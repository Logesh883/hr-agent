import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isOrgWide,
  LEAVE_TYPES,
  roleHasPermission,
  type Holiday,
  type LeaveApproveBody,
  type LeaveBalance,
  type LeavePreview,
  type LeaveRejectBody,
  type LeaveRequest,
  type LeaveRequestBody,
  type LeaveSearchQuery,
  type LeaveType,
  type Paginated,
} from '@hr/contracts';
import type { Prisma } from '@hr/db';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { BusinessRuleException } from '../common/business-rule.exception.js';
import { fromIsoDate, toIsoDate, todayIso, yearOf } from '../common/dates.js';
import { assertEmployeeInScope, employeeScope } from '../common/scope.js';
import { employeeRefSelect } from '../employees/employee.mapper.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { buildBalance, evaluateLeave } from './leave-rules.js';

const leaveInclude = {
  employee: { select: { ...employeeRefSelect, managerId: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.LeaveRequestInclude;

type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: typeof leaveInclude }>;

interface TargetEmployee {
  id: string;
  status: 'ACTIVE' | 'PROBATION' | 'ARCHIVED';
  joiningDate: Date;
}

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- Reads -----------------------------------------------------------------

  async holidays(year?: number): Promise<Holiday[]> {
    const rows = await this.prisma.holiday.findMany({
      where: year
        ? { date: { gte: fromIsoDate(`${year}-01-01`), lte: fromIsoDate(`${year}-12-31`) } }
        : undefined,
      orderBy: { date: 'asc' },
    });
    return rows.map((h) => ({ date: toIsoDate(h.date), name: h.name }));
  }

  async balances(user: AuthUser, employeeId: string, year?: number): Promise<LeaveBalance[]> {
    await assertEmployeeInScope(this.prisma, user, employeeId, 'team');
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { joiningDate: true },
    });
    const targetYear = year ?? yearOf(todayIso());
    const requests = await this.requestsInYear(this.prisma, employeeId, targetYear);
    return LEAVE_TYPES.map((type) =>
      buildBalance(type, targetYear, toIsoDate(employee.joiningDate), requests),
    );
  }

  async list(user: AuthUser, query: LeaveSearchQuery): Promise<Paginated<LeaveRequest>> {
    const filters: Prisma.LeaveRequestWhereInput[] = [
      { employee: employeeScope(user, 'team') },
      {
        employeeId: query.employeeId,
        status: query.status,
        type: query.type,
        ...(query.from && { endDate: { gte: fromIsoDate(query.from) } }),
        ...(query.to && { startDate: { lte: fromIsoDate(query.to) } }),
      },
    ];
    if (query.view === 'mine') {
      filters.push({ employeeId: user.employeeId ?? '00000000-0000-0000-0000-000000000000' });
    }
    if (query.view === 'approvals') {
      filters.push(this.decidableFilter(user));
    }

    const where: Prisma.LeaveRequestWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.leaveRequest.findMany({
        where,
        include: leaveInclude,
        orderBy: query.view === 'approvals' ? { startDate: 'asc' } : { startDate: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r, user)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(user: AuthUser, id: string): Promise<LeaveRequest> {
    return this.toDto(await this.findInScope(this.prisma, user, id), user);
  }

  // ---- Requests --------------------------------------------------------------

  /** Dry run: working days, balance after, and every reason the request would fail. */
  async preview(user: AuthUser, body: LeaveRequestBody): Promise<LeavePreview> {
    const employee = await this.targetEmployee(user, body.employeeId);
    return this.evaluate(this.prisma, employee, body);
  }

  async create(user: AuthUser, body: LeaveRequestBody): Promise<LeaveRequest> {
    const employee = await this.targetEmployee(user, body.employeeId);

    return this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employee.id);
      const preview = await this.evaluate(tx, employee, body);
      if (preview.problems.length) throw new BusinessRuleException(preview.problems);

      const row = await tx.leaveRequest.create({
        data: {
          employeeId: employee.id,
          type: body.type,
          startDate: fromIsoDate(body.startDate),
          endDate: fromIsoDate(body.endDate),
          days: preview.workingDays,
          reason: body.reason || null,
          requestedById: user.id,
        },
        include: leaveInclude,
      });
      await this.audit.record(tx, {
        actor: user,
        action: 'leave.requested',
        entityType: 'LeaveRequest',
        entityId: row.id,
        after: snapshot(row),
      });
      return this.toDto(row, user);
    });
  }

  async approve(user: AuthUser, id: string, body: LeaveApproveBody): Promise<LeaveRequest> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findInScope(tx, user, id);
      this.assertCanDecide(user, current);
      await lockEmployee(tx, current.employeeId);

      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: current.employeeId },
        select: { id: true, status: true, joiningDate: true },
      });
      const preview = await this.evaluate(
        tx,
        employee,
        {
          type: current.type,
          startDate: toIsoDate(current.startDate),
          endDate: toIsoDate(current.endDate),
        },
        { excludeRequestId: id, forApproval: true },
      );
      if (preview.problems.length) throw new BusinessRuleException(preview.problems);

      return this.decide(tx, user, current, 'APPROVED', body.comment);
    });
  }

  async reject(user: AuthUser, id: string, body: LeaveRejectBody): Promise<LeaveRequest> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findInScope(tx, user, id);
      this.assertCanDecide(user, current);
      return this.decide(tx, user, current, 'REJECTED', body.reason);
    });
  }

  async cancel(user: AuthUser, id: string): Promise<LeaveRequest> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findInScope(tx, user, id);
      if (!this.canCancel(user, current)) {
        throw new ForbiddenException(
          current.status === 'PENDING' || current.status === 'APPROVED'
            ? 'Only the employee or HR can cancel this request, and approved leave can only be cancelled before it starts.'
            : `This request is already ${current.status.toLowerCase()}.`,
        );
      }
      const { count } = await tx.leaveRequest.updateMany({
        where: { id, status: current.status },
        data: { status: 'CANCELLED' },
      });
      if (count === 0) throw new ConflictException('This request was just changed. Reload and try again.');

      const row = await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: leaveInclude });
      await this.audit.record(tx, {
        actor: user,
        action: 'leave.cancelled',
        entityType: 'LeaveRequest',
        entityId: id,
        before: { status: current.status },
        after: { status: 'CANCELLED' },
      });
      return this.toDto(row, user);
    });
  }

  // ---- Helpers ---------------------------------------------------------------

  private async decide(
    tx: Tx,
    user: AuthUser,
    current: LeaveRow,
    status: 'APPROVED' | 'REJECTED',
    comment?: string,
  ): Promise<LeaveRequest> {
    const { count } = await tx.leaveRequest.updateMany({
      where: { id: current.id, status: 'PENDING' },
      data: {
        status,
        decidedById: user.id,
        decidedAt: new Date(),
        decisionComment: comment || null,
      },
    });
    if (count === 0) throw new ConflictException('This request was already decided. Reload to see the latest status.');

    const row = await tx.leaveRequest.findUniqueOrThrow({
      where: { id: current.id },
      include: leaveInclude,
    });
    await this.audit.record(tx, {
      actor: user,
      action: status === 'APPROVED' ? 'leave.approved' : 'leave.rejected',
      entityType: 'LeaveRequest',
      entityId: current.id,
      before: { status: 'PENDING' },
      after: { status, ...(comment ? { comment } : {}) },
    });
    return this.toDto(row, user);
  }

  private async evaluate(
    client: PrismaService | Tx,
    employee: TargetEmployee,
    body: { type: LeaveType; startDate: string; endDate: string },
    { excludeRequestId, forApproval = false }: { excludeRequestId?: string; forApproval?: boolean } = {},
  ): Promise<LeavePreview> {
    const excludeSelf = excludeRequestId ? { id: { not: excludeRequestId } } : {};
    const year = yearOf(body.startDate);

    const [holidays, others, requests] = await Promise.all([
      client.holiday.findMany({
        where: { date: { gte: fromIsoDate(body.startDate), lte: fromIsoDate(body.endDate) } },
      }),
      client.leaveRequest.findMany({
        where: {
          ...excludeSelf,
          employeeId: employee.id,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: fromIsoDate(body.endDate) },
          endDate: { gte: fromIsoDate(body.startDate) },
        },
        orderBy: { startDate: 'asc' },
      }),
      this.requestsInYear(client, employee.id, year, excludeRequestId),
    ]);

    const joiningDate = toIsoDate(employee.joiningDate);
    return evaluateLeave({
      ...body,
      today: todayIso(),
      employee: { status: employee.status, joiningDate },
      holidays: new Map(holidays.map((h) => [toIsoDate(h.date), h.name])),
      otherRequests: others.map((r) => ({
        startDate: toIsoDate(r.startDate),
        endDate: toIsoDate(r.endDate),
        status: r.status,
      })),
      balance: buildBalance(body.type, year, joiningDate, requests),
      forApproval,
    });
  }

  private async requestsInYear(
    client: PrismaService | Tx,
    employeeId: string,
    year: number,
    excludeRequestId?: string,
  ) {
    const rows = await client.leaveRequest.findMany({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { gte: fromIsoDate(`${year}-01-01`), lte: fromIsoDate(`${year}-12-31`) },
        ...(excludeRequestId && { id: { not: excludeRequestId } }),
      },
      select: { type: true, status: true, days: true, startDate: true },
    });
    return rows.map((r) => ({ ...r, startDate: toIsoDate(r.startDate) }));
  }

  /** Who the leave is for: yourself, or anyone if you manage leave. */
  private async targetEmployee(user: AuthUser, employeeId?: string): Promise<TargetEmployee> {
    const targetId = employeeId ?? user.employeeId;
    if (!targetId) {
      throw new BadRequestException(
        "Your account isn't linked to an employee record, so choose who the leave is for.",
      );
    }
    if (targetId !== user.employeeId && !roleHasPermission(user.role, 'leave:manage')) {
      throw new ForbiddenException('You can only request leave for yourself.');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: targetId },
      select: { id: true, status: true, joiningDate: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  private async findInScope(client: PrismaService | Tx, user: AuthUser, id: string) {
    const row = await client.leaveRequest.findFirst({
      where: { id, employee: employeeScope(user, 'team') },
      include: leaveInclude,
    });
    if (!row) throw new NotFoundException('Leave request not found');
    return row;
  }

  /** Pending requests the user may approve or reject. Nobody decides their own. */
  private decidableFilter(user: AuthUser): Prisma.LeaveRequestWhereInput {
    if (!roleHasPermission(user.role, 'leave:approve')) return { id: { in: [] } };
    return {
      status: 'PENDING',
      ...(user.employeeId && { employeeId: { not: user.employeeId } }),
      ...(!isOrgWide(user.role) && { employee: { managerId: user.employeeId ?? '' } }),
    };
  }

  private canDecide(user: AuthUser, row: LeaveRow): boolean {
    return (
      row.status === 'PENDING' &&
      roleHasPermission(user.role, 'leave:approve') &&
      row.employeeId !== user.employeeId &&
      (isOrgWide(user.role) || row.employee.managerId === user.employeeId)
    );
  }

  private assertCanDecide(user: AuthUser, row: LeaveRow) {
    if (row.status !== 'PENDING') {
      throw new ConflictException(`This request is already ${row.status.toLowerCase()}.`);
    }
    if (row.employeeId === user.employeeId) {
      throw new ForbiddenException("You can't approve or reject your own leave.");
    }
    if (!this.canDecide(user, row)) {
      throw new ForbiddenException("Only the employee's manager or HR can decide this request.");
    }
  }

  private canCancel(user: AuthUser, row: LeaveRow): boolean {
    const cancellable =
      row.status === 'PENDING' ||
      (row.status === 'APPROVED' && toIsoDate(row.startDate) > todayIso());
    return (
      cancellable &&
      (row.employeeId === user.employeeId || roleHasPermission(user.role, 'leave:manage'))
    );
  }

  private toDto(row: LeaveRow, user: AuthUser): LeaveRequest {
    const { managerId: _managerId, ...employee } = row.employee;
    return {
      id: row.id,
      employee,
      type: row.type,
      startDate: toIsoDate(row.startDate),
      endDate: toIsoDate(row.endDate),
      days: row.days,
      reason: row.reason,
      status: row.status,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionComment: row.decisionComment,
      createdAt: row.createdAt.toISOString(),
      canDecide: this.canDecide(user, row),
      canCancel: this.canCancel(user, row),
    };
  }
}

/** Serialises balance checks per employee so concurrent requests can't overdraw. */
async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employeeId}))`;
}

function snapshot(row: LeaveRow) {
  return {
    employeeId: row.employeeId,
    type: row.type,
    startDate: toIsoDate(row.startDate),
    endDate: toIsoDate(row.endDate),
    days: row.days,
    reason: row.reason,
    status: row.status,
  };
}

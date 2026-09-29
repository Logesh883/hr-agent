import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  roleHasPermission,
  type AttendanceCorrection,
  type AttendanceDay,
  type AttendanceEntry,
  type CorrectionSearchQuery,
  type DailyAttendance,
  type DailyAttendanceQuery,
  type MonthlyAttendance,
  type MonthlyAttendanceQuery,
  type MonthlyAttendanceRow,
  type Paginated,
  type ProposeCorrectionBody,
} from '@hr/contracts';
import type { Prisma } from '@hr/db';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import {
  eachDay,
  formatDate,
  fromIsoDate,
  isWeekend,
  localTime,
  monthRange,
  toInstant,
  toIsoDate,
  todayIso,
} from '../common/dates.js';
import { assertEmployeeInScope, employeeScope } from '../common/scope.js';
import { employeeRefSelect } from '../employees/employee.mapper.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { evaluateDay } from './attendance-rules.js';

const correctionInclude = {
  employee: { select: employeeRefSelect },
  proposedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceCorrectionInclude;

type CorrectionRow = Prisma.AttendanceCorrectionGetPayload<{ include: typeof correctionInclude }>;

interface Filters {
  departmentId?: string;
  employeeId?: string;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async daily(user: AuthUser, query: DailyAttendanceQuery): Promise<DailyAttendance> {
    const { days, holidays } = await this.buildDays(user, query.date, query.date, query);
    const summary = { present: 0, halfDay: 0, absent: 0, onLeave: 0, missing: 0 };
    for (const d of days) {
      if (d.dayStatus === 'PRESENT') summary.present++;
      else if (d.dayStatus === 'HALF_DAY') summary.halfDay++;
      else if (d.dayStatus === 'ABSENT') summary.absent++;
      else if (d.dayStatus === 'ON_LEAVE') summary.onLeave++;
      else if (d.dayStatus === 'MISSING') summary.missing++;
    }
    const holiday = holidays.get(query.date) ?? null;
    return {
      date: query.date,
      holiday,
      isWorkingDay: !isWeekend(query.date) && !holiday,
      rows: days,
      summary,
    };
  }

  async monthly(user: AuthUser, query: MonthlyAttendanceQuery): Promise<MonthlyAttendance> {
    if (query.employeeId) await assertEmployeeInScope(this.prisma, user, query.employeeId, 'team');
    const { start, end } = monthRange(query.month);
    const { days, holidays } = await this.buildDays(user, start, end, query);
    const today = todayIso();

    const rows = new Map<string, MonthlyAttendanceRow>();
    for (const d of days) {
      const row = rows.get(d.employee.id) ?? {
        employee: d.employee,
        workingDays: 0,
        present: 0,
        halfDays: 0,
        absent: 0,
        onLeave: 0,
        missing: 0,
        anomalies: 0,
      };
      if (['PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE', 'MISSING'].includes(d.dayStatus)) row.workingDays++;
      if (d.dayStatus === 'PRESENT') row.present++;
      if (d.dayStatus === 'HALF_DAY') row.halfDays++;
      if (d.dayStatus === 'ABSENT') row.absent++;
      if (d.dayStatus === 'ON_LEAVE') row.onLeave++;
      if (d.dayStatus === 'MISSING' && d.date < today) row.missing++;
      row.anomalies += d.anomalies.length;
      rows.set(d.employee.id, row);
    }

    const elapsedEnd = end < today ? end : today;
    const workingDays = start > elapsedEnd
      ? 0
      : eachDay(start, elapsedEnd).filter((d) => !isWeekend(d) && !holidays.has(d)).length;

    return {
      month: query.month,
      workingDays,
      rows: [...rows.values()],
      anomalies: days
        .flatMap((d) => d.anomalies.map((a) => ({ ...a, date: d.date, employee: d.employee })))
        .sort((a, b) => b.date.localeCompare(a.date) || a.employee.firstName.localeCompare(b.employee.firstName)),
      ...(query.employeeId && { days }),
    };
  }

  // ---- Corrections -------------------------------------------------------------

  async corrections(user: AuthUser, query: CorrectionSearchQuery): Promise<Paginated<AttendanceCorrection>> {
    const where: Prisma.AttendanceCorrectionWhereInput = {
      employee: employeeScope(user, 'team'),
      status: query.status,
      employeeId: query.employeeId,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceCorrection.findMany({
        where,
        include: correctionInclude,
        orderBy: { createdAt: query.status === 'PENDING' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.attendanceCorrection.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toCorrectionDto(r, user)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Records a proposed change. Nothing about the attendance record changes until it's approved. */
  async propose(user: AuthUser, body: ProposeCorrectionBody): Promise<AttendanceCorrection> {
    await assertEmployeeInScope(this.prisma, user, body.employeeId, 'team');
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: body.employeeId },
      select: { joiningDate: true, status: true },
    });
    if (body.date > todayIso()) throw new BadRequestException("Attendance can't be corrected for a future date.");
    if (body.date < toIsoDate(employee.joiningDate)) {
      throw new BadRequestException(`The employee hadn't joined yet on ${formatDate(body.date)}.`);
    }
    const holiday = await this.prisma.holiday.findUnique({ where: { date: fromIsoDate(body.date) } });
    if (isWeekend(body.date) || holiday) {
      throw new BadRequestException(`${formatDate(body.date)} isn't a working day (${holiday?.name ?? 'weekend'}).`);
    }

    return this.prisma.$transaction(async (tx) => {
      const pending = await tx.attendanceCorrection.findFirst({
        where: { employeeId: body.employeeId, date: fromIsoDate(body.date), status: 'PENDING' },
      });
      if (pending) {
        throw new ConflictException('A correction for this day is already waiting for approval.');
      }
      const current = await tx.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId: body.employeeId, date: fromIsoDate(body.date) } },
      });
      const row = await tx.attendanceCorrection.create({
        data: {
          employeeId: body.employeeId,
          date: fromIsoDate(body.date),
          proposedStatus: body.status,
          proposedCheckIn: body.status !== 'ABSENT' && body.checkIn ? toInstant(body.date, body.checkIn) : null,
          proposedCheckOut: body.status !== 'ABSENT' && body.checkOut ? toInstant(body.date, body.checkOut) : null,
          reason: body.reason,
          previous: current ? (toEntry(current) as unknown as Prisma.InputJsonValue) : undefined,
          proposedById: user.id,
        },
        include: correctionInclude,
      });
      await this.audit.record(tx, {
        actor: user,
        action: 'attendance.correction_proposed',
        entityType: 'AttendanceCorrection',
        entityId: row.id,
        before: current ? { ...toEntry(current) } : null,
        after: { date: body.date, ...proposedEntry(row), reason: body.reason },
      });
      return this.toCorrectionDto(row, user);
    });
  }

  async approve(user: AuthUser, id: string, comment?: string): Promise<AttendanceCorrection> {
    return this.prisma.$transaction(async (tx) => {
      const correction = await this.findReviewable(tx, user, id);
      const date = toIsoDate(correction.date);
      const data = {
        status: correction.proposedStatus,
        checkIn: correction.proposedCheckIn,
        checkOut: correction.proposedCheckOut,
        source: 'CORRECTION' as const,
        correctionReason: correction.reason,
      };
      const before = await tx.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId: correction.employeeId, date: correction.date } },
      });
      const record = await tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: correction.employeeId, date: correction.date } },
        update: data,
        create: { employeeId: correction.employeeId, date: correction.date, ...data },
      });
      await this.decide(tx, correction.id, user, 'APPROVED', comment);

      await this.audit.record(tx, {
        actor: user,
        action: 'attendance.corrected',
        entityType: 'AttendanceRecord',
        entityId: record.id,
        before: before ? { date, ...toEntry(before) } : null,
        after: { date, ...toEntry(record), correctionId: correction.id },
      });
      return this.toCorrectionDto(await this.reload(tx, id), user);
    });
  }

  async reject(user: AuthUser, id: string, reason: string): Promise<AttendanceCorrection> {
    return this.prisma.$transaction(async (tx) => {
      const correction = await this.findReviewable(tx, user, id);
      await this.decide(tx, correction.id, user, 'REJECTED', reason);
      return this.toCorrectionDto(await this.reload(tx, id), user);
    });
  }

  // ---- Helpers ---------------------------------------------------------------

  private async buildDays(user: AuthUser, from: string, to: string, filters: Filters) {
    const employees = await this.prisma.employee.findMany({
      where: {
        AND: [
          employeeScope(user, 'team') ?? {},
          { status: { not: 'ARCHIVED' }, joiningDate: { lte: fromIsoDate(to) } },
          { departmentId: filters.departmentId, id: filters.employeeId },
        ],
      },
      select: { ...employeeRefSelect, joiningDate: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    const ids = employees.map((e) => e.id);
    const range = { gte: fromIsoDate(from), lte: fromIsoDate(to) };

    const [records, leaves, holidayRows, pending] = await Promise.all([
      this.prisma.attendanceRecord.findMany({ where: { employeeId: { in: ids }, date: range } }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId: { in: ids },
          status: 'APPROVED',
          startDate: { lte: fromIsoDate(to) },
          endDate: { gte: fromIsoDate(from) },
        },
        select: { id: true, employeeId: true, type: true, startDate: true, endDate: true },
      }),
      this.prisma.holiday.findMany({ where: { date: range } }),
      this.prisma.attendanceCorrection.findMany({
        where: { employeeId: { in: ids }, date: range, status: 'PENDING' },
        select: { employeeId: true, date: true },
      }),
    ]);

    const holidays = new Map(holidayRows.map((h) => [toIsoDate(h.date), h.name]));
    const recordByKey = new Map(records.map((r) => [`${r.employeeId}:${toIsoDate(r.date)}`, r]));
    const pendingKeys = new Set(pending.map((p) => `${p.employeeId}:${toIsoDate(p.date)}`));
    const today = todayIso();
    const dates = eachDay(from, to);

    const days: AttendanceDay[] = [];
    for (const { joiningDate, ...employee } of employees) {
      for (const date of dates) {
        const key = `${employee.id}:${date}`;
        const record = recordByKey.get(key) ?? null;
        const leave = leaves.find(
          (l) => l.employeeId === employee.id && toIsoDate(l.startDate) <= date && toIsoDate(l.endDate) >= date,
        );
        const entry = record ? toEntry(record) : null;
        const evaluated = evaluateDay({
          date,
          today,
          joiningDate: toIsoDate(joiningDate),
          holiday: holidays.get(date) ?? null,
          record: entry,
          leave: leave ? { type: leave.type } : null,
        });
        days.push({
          date,
          employee,
          ...evaluated,
          record: record && entry ? { id: record.id, ...entry, source: record.source, correctionReason: record.correctionReason } : null,
          leave: leave ? { id: leave.id, type: leave.type } : null,
          holiday: holidays.get(date) ?? null,
          pendingCorrection: pendingKeys.has(key),
        });
      }
    }
    return { days, holidays };
  }

  private async findReviewable(tx: Tx, user: AuthUser, id: string) {
    const correction = await tx.attendanceCorrection.findFirst({
      where: { id, employee: employeeScope(user, 'team') },
      include: correctionInclude,
    });
    if (!correction) throw new NotFoundException('Correction not found');
    if (correction.status !== 'PENDING') {
      throw new ConflictException(`This correction was already ${correction.status.toLowerCase()}.`);
    }
    if (correction.proposedById === user.id) {
      throw new ForbiddenException("You can't approve or reject a correction you proposed.");
    }
    if (correction.employeeId === user.employeeId) {
      throw new ForbiddenException("You can't review corrections to your own attendance.");
    }
    return correction;
  }

  private async decide(
    tx: Tx,
    id: string,
    user: AuthUser,
    status: 'APPROVED' | 'REJECTED',
    comment?: string,
  ) {
    const { count } = await tx.attendanceCorrection.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, reviewedById: user.id, reviewedAt: new Date(), reviewComment: comment || null },
    });
    if (count === 0) throw new ConflictException('This correction was just reviewed. Reload and try again.');
    await this.audit.record(tx, {
      actor: user,
      action: status === 'APPROVED' ? 'attendance.correction_approved' : 'attendance.correction_rejected',
      entityType: 'AttendanceCorrection',
      entityId: id,
      before: { status: 'PENDING' },
      after: { status, ...(comment ? { comment } : {}) },
    });
  }

  private reload(tx: Tx, id: string) {
    return tx.attendanceCorrection.findUniqueOrThrow({ where: { id }, include: correctionInclude });
  }

  private toCorrectionDto(row: CorrectionRow, user: AuthUser): AttendanceCorrection {
    return {
      id: row.id,
      employee: row.employee,
      date: toIsoDate(row.date),
      proposed: proposedEntry(row),
      previous: (row.previous as AttendanceEntry | null) ?? null,
      reason: row.reason,
      status: row.status,
      proposedBy: row.proposedBy,
      proposedAt: row.createdAt.toISOString(),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewComment: row.reviewComment,
      canReview:
        row.status === 'PENDING' &&
        roleHasPermission(user.role, 'attendance:approve') &&
        row.proposedById !== user.id &&
        row.employeeId !== user.employeeId,
    };
  }
}

function toEntry(r: { status: AttendanceEntry['status']; checkIn: Date | null; checkOut: Date | null }): AttendanceEntry {
  return {
    status: r.status,
    checkIn: r.checkIn ? localTime(r.checkIn) : null,
    checkOut: r.checkOut ? localTime(r.checkOut) : null,
  };
}

function proposedEntry(r: {
  proposedStatus: AttendanceEntry['status'];
  proposedCheckIn: Date | null;
  proposedCheckOut: Date | null;
}): AttendanceEntry {
  return toEntry({ status: r.proposedStatus, checkIn: r.proposedCheckIn, checkOut: r.proposedCheckOut });
}

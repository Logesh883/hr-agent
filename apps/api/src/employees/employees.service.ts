import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ArchiveEmployeeRequest,
  CreateEmployeeRequest,
  Employee,
  EmployeeSearchQuery,
  Paginated,
  UpdateEmployeeRequest,
} from '@hr/contracts';
import type { Prisma } from '@hr/db';
import { AuditService, diffSnapshots } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import {
  employeeInclude,
  fromIsoDate,
  toEmployee,
  toEmployeeSnapshot,
} from './employee.mapper.js';

const STALE_VERSION =
  'This employee was changed by someone else. Reload and try again.';
const MAX_MANAGER_CHAIN = 100;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async search(query: EmployeeSearchQuery): Promise<Paginated<Employee>> {
    // Every search term must match at least one field, so "arun kumar" finds
    // Arun Kumar and "EMP-0005" finds by code.
    const terms = query.q?.split(/\s+/).filter(Boolean) ?? [];
    const where: Prisma.EmployeeWhereInput = {
      status: query.status ?? { in: ['ACTIVE', 'PROBATION'] },
      departmentId: query.departmentId,
      managerId: query.managerId,
      location: query.location
        ? { equals: query.location, mode: 'insensitive' }
        : undefined,
      AND: terms.map((term) => ({
        OR: (
          ['firstName', 'lastName', 'email', 'employeeCode', 'jobTitle'] as const
        ).map((field) => ({
          [field]: { contains: term, mode: 'insensitive' },
        })),
      })),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        include: employeeInclude,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return {
      items: rows.map(toEmployee),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<Employee> {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      include: employeeInclude,
    });
    if (!row) throw new NotFoundException('Employee not found');
    return toEmployee(row);
  }

  async create(input: CreateEmployeeRequest, actor: AuthUser): Promise<Employee> {
    await this.assertDepartmentActive(input.departmentId);
    if (input.managerId) await this.assertValidManager(input.managerId);
    await this.assertEmailAvailable(input.email);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.employee.create({
        data: {
          ...input,
          dateOfBirth: input.dateOfBirth ? fromIsoDate(input.dateOfBirth) : null,
          joiningDate: fromIsoDate(input.joiningDate),
          employeeCode: await nextEmployeeCode(tx),
        },
        include: employeeInclude,
      });
      await this.audit.record(tx, {
        actor,
        action: 'employee.created',
        entityType: 'Employee',
        entityId: row.id,
        after: toEmployeeSnapshot(row),
      });
      return toEmployee(row);
    });
  }

  async update(
    id: string,
    input: UpdateEmployeeRequest,
    actor: AuthUser,
  ): Promise<Employee> {
    const { version, ...changes } = input;
    const current = await this.findRowOrThrow(id);
    if (current.status === 'ARCHIVED') {
      throw new ConflictException(
        'Archived employees cannot be edited. Reactivate the employee first.',
      );
    }
    if (current.version !== version) throw new ConflictException(STALE_VERSION);

    if (changes.departmentId && changes.departmentId !== current.departmentId) {
      await this.assertDepartmentActive(changes.departmentId);
    }
    if (changes.managerId && changes.managerId !== current.managerId) {
      await this.assertValidManager(changes.managerId, id);
    }
    if (changes.email && changes.email !== current.email) {
      await this.assertEmailAvailable(changes.email, id);
    }

    return this.prisma.$transaction(async (tx) => {
      await updateWithVersion(tx, id, version, toUpdateData(changes));
      if (changes.email && changes.email !== current.email) {
        // The login email is always the work email.
        await tx.user.updateMany({ where: { employeeId: id }, data: { email: changes.email } });
      }
      const row = await tx.employee.findUniqueOrThrow({
        where: { id },
        include: employeeInclude,
      });
      const diff = diffSnapshots(
        toEmployeeSnapshot(current),
        toEmployeeSnapshot(row),
      );
      if (diff) {
        await this.audit.record(tx, {
          actor,
          action: 'employee.updated',
          entityType: 'Employee',
          entityId: id,
          ...diff,
        });
      }
      return toEmployee(row);
    });
  }

  async archive(
    id: string,
    { version, reason }: ArchiveEmployeeRequest,
    actor: AuthUser,
  ): Promise<Employee> {
    const current = await this.findRowOrThrow(id);
    if (current.status === 'ARCHIVED') {
      throw new ConflictException('Employee is already archived');
    }

    const activeReports = await this.prisma.employee.count({
      where: { managerId: id, status: { not: 'ARCHIVED' } },
    });
    if (activeReports) {
      throw new ConflictException(
        `Reassign ${activeReports} direct report(s) before archiving this employee`,
      );
    }
    const managed = await this.prisma.department.findMany({
      where: { managerId: id, status: 'ACTIVE' },
      select: { name: true },
    });
    if (managed.length) {
      throw new ConflictException(
        `Assign a new manager for ${managed.map((d) => d.name).join(', ')} before archiving this employee`,
      );
    }

    return this.changeStatus(id, version, 'ARCHIVED', current.status, actor, {
      action: 'employee.archived',
      reason,
    });
  }

  async reactivate(
    id: string,
    { version, reason }: ArchiveEmployeeRequest,
    actor: AuthUser,
  ): Promise<Employee> {
    const current = await this.findRowOrThrow(id);
    if (current.status !== 'ARCHIVED') {
      throw new ConflictException('Only archived employees can be reactivated');
    }
    await this.assertDepartmentActive(current.departmentId);

    return this.changeStatus(id, version, 'ACTIVE', current.status, actor, {
      action: 'employee.reactivated',
      reason,
    });
  }

  private async changeStatus(
    id: string,
    version: number,
    status: 'ACTIVE' | 'ARCHIVED',
    previous: string,
    actor: AuthUser,
    { action, reason }: { action: string; reason?: string },
  ): Promise<Employee> {
    return this.prisma.$transaction(async (tx) => {
      await updateWithVersion(tx, id, version, { status });
      // Leavers can't sign in. Reactivating doesn't restore access automatically.
      const { count: loginsDisabled } =
        status === 'ARCHIVED'
          ? await tx.user.updateMany({ where: { employeeId: id, isActive: true }, data: { isActive: false } })
          : { count: 0 };
      const row = await tx.employee.findUniqueOrThrow({
        where: { id },
        include: employeeInclude,
      });
      await this.audit.record(tx, {
        actor,
        action,
        entityType: 'Employee',
        entityId: id,
        before: { status: previous },
        after: { status, ...(reason ? { reason } : {}), ...(loginsDisabled ? { loginDisabled: true } : {}) },
      });
      return toEmployee(row);
    });
  }

  private async findRowOrThrow(id: string) {
    const row = await this.prisma.employee.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Employee not found');
    return row;
  }

  private async assertDepartmentActive(departmentId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { name: true, status: true },
    });
    if (!dept) throw new BadRequestException('Department does not exist');
    if (dept.status !== 'ACTIVE') {
      throw new BadRequestException(`Department ${dept.name} is archived`);
    }
  }

  /**
   * Manager must exist, be active, and not be the employee or anyone who
   * reports to them (directly or indirectly).
   */
  private async assertValidManager(managerId: string, employeeId?: string) {
    if (managerId === employeeId) {
      throw new BadRequestException('An employee cannot manage themselves');
    }
    const manager = await this.prisma.employee.findUnique({
      where: { id: managerId },
      select: { status: true },
    });
    if (!manager) throw new BadRequestException('Manager does not exist');
    if (manager.status === 'ARCHIVED') {
      throw new BadRequestException('Manager is archived');
    }
    if (!employeeId) return;

    let cursor: string | null = managerId;
    for (let i = 0; cursor && i < MAX_MANAGER_CHAIN; i++) {
      const next: { managerId: string | null } | null =
        await this.prisma.employee.findUnique({
          where: { id: cursor },
          select: { managerId: true },
        });
      cursor = next?.managerId ?? null;
      if (cursor === employeeId) {
        throw new BadRequestException(
          'This manager reports to the employee, which would create a reporting cycle',
        );
      }
    }
  }

  private async assertEmailAvailable(email: string, exceptId?: string) {
    const existing = await this.prisma.employee.findUnique({
      where: { email },
      select: { id: true, employeeCode: true },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(
        `Email is already used by ${existing.employeeCode}`,
      );
    }
    const login = await this.prisma.user.findUnique({
      where: { email },
      select: { employeeId: true },
    });
    if (login && (!exceptId || login.employeeId !== exceptId)) {
      throw new ConflictException('Email is already used by another login');
    }
  }
}

/** Converts date strings; undefined fields are left out so Prisma skips them. */
function toUpdateData(
  changes: Omit<UpdateEmployeeRequest, 'version'>,
): Prisma.EmployeeUncheckedUpdateManyInput {
  const { dateOfBirth, joiningDate, ...rest } = changes;
  return {
    ...rest,
    ...(dateOfBirth !== undefined && {
      dateOfBirth: dateOfBirth === null ? null : fromIsoDate(dateOfBirth),
    }),
    ...(joiningDate !== undefined && { joiningDate: fromIsoDate(joiningDate) }),
  };
}

/** Applies the update only if the stored version still matches. */
async function updateWithVersion(
  tx: Tx,
  id: string,
  version: number,
  data: Prisma.EmployeeUncheckedUpdateManyInput,
) {
  const { count } = await tx.employee.updateMany({
    where: { id, version },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 0) throw new ConflictException(STALE_VERSION);
}

async function nextEmployeeCode(tx: Tx): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { name: 'employeeCode' },
    update: { value: { increment: 1 } },
    create: { name: 'employeeCode', value: 1 },
  });
  return `EMP-${String(counter.value).padStart(4, '0')}`;
}

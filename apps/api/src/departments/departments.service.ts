import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateDepartmentRequest,
  Department,
  EmployeeRef,
  UpdateDepartmentRequest,
} from '@hr/contracts';
import type { Department as DepartmentModel, Prisma } from '@hr/db';
import { AuditService, diffSnapshots } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { employeeRefSelect } from '../employees/employee.mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';

const departmentInclude = {
  manager: { select: employeeRefSelect },
  _count: {
    select: { employees: { where: { status: { not: 'ARCHIVED' } } } },
  },
} satisfies Prisma.DepartmentInclude;

type DepartmentRow = Prisma.DepartmentGetPayload<{
  include: typeof departmentInclude;
}>;

function toDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    manager: row.manager as EmployeeRef | null,
    employeeCount: row._count.employees,
  };
}

function toSnapshot(row: DepartmentModel) {
  return {
    name: row.name,
    code: row.code,
    status: row.status,
    managerId: row.managerId,
  };
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<Department[]> {
    const rows = await this.prisma.department.findMany({
      include: departmentInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map(toDepartment);
  }

  async get(id: string): Promise<Department> {
    const row = await this.prisma.department.findUnique({
      where: { id },
      include: departmentInclude,
    });
    if (!row) throw new NotFoundException('Department not found');
    return toDepartment(row);
  }

  async create(
    input: CreateDepartmentRequest,
    actor: AuthUser,
  ): Promise<Department> {
    await this.assertUnique(input);
    if (input.managerId) await this.assertValidManager(input.managerId);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.department.create({
        data: input,
        include: departmentInclude,
      });
      await this.audit.record(tx, {
        actor,
        action: 'department.created',
        entityType: 'Department',
        entityId: row.id,
        after: toSnapshot(row),
      });
      return toDepartment(row);
    });
  }

  async update(
    id: string,
    input: UpdateDepartmentRequest,
    actor: AuthUser,
  ): Promise<Department> {
    const current = await this.prisma.department.findUnique({
      where: { id },
      include: departmentInclude,
    });
    if (!current) throw new NotFoundException('Department not found');

    await this.assertUnique(input, id);
    if (input.managerId && input.managerId !== current.managerId) {
      await this.assertValidManager(input.managerId);
    }
    if (
      input.status === 'ARCHIVED' &&
      current.status !== 'ARCHIVED' &&
      current._count.employees > 0
    ) {
      throw new ConflictException(
        `Move or archive the ${current._count.employees} employee(s) in ${current.name} before archiving it`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.department.update({
        where: { id },
        data: input,
        include: departmentInclude,
      });
      const diff = diffSnapshots(toSnapshot(current), toSnapshot(row));
      if (diff) {
        await this.audit.record(tx, {
          actor,
          action: 'department.updated',
          entityType: 'Department',
          entityId: id,
          ...diff,
        });
      }
      return toDepartment(row);
    });
  }

  private async assertUnique(
    input: { name?: string; code?: string },
    exceptId?: string,
  ) {
    const clashes = await this.prisma.department.findMany({
      where: {
        OR: [
          ...(input.name
            ? [{ name: { equals: input.name, mode: 'insensitive' as const } }]
            : []),
          ...(input.code ? [{ code: input.code }] : []),
        ],
        NOT: exceptId ? { id: exceptId } : undefined,
      },
      select: { name: true, code: true },
    });
    const clash = clashes[0];
    if (!clash) return;
    const field =
      input.code && clash.code === input.code ? `code ${input.code}` : `name ${clash.name}`;
    throw new ConflictException(`A department with ${field} already exists`);
  }

  private async assertValidManager(managerId: string) {
    const manager = await this.prisma.employee.findUnique({
      where: { id: managerId },
      select: { status: true },
    });
    if (!manager) throw new BadRequestException('Manager does not exist');
    if (manager.status === 'ARCHIVED') {
      throw new BadRequestException('Manager is archived');
    }
  }
}

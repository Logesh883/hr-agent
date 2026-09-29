import type { Employee, EmployeeRef } from '@hr/contracts';
import type { Employee as EmployeeModel, Prisma } from '@hr/db';
import { fromIsoDate, toIsoDate } from '../common/dates.js';

export const employeeRefSelect = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

export const employeeInclude = {
  department: { select: { id: true, name: true } },
  manager: { select: employeeRefSelect },
} satisfies Prisma.EmployeeInclude;

export type EmployeeRow = Prisma.EmployeeGetPayload<{
  include: typeof employeeInclude;
}>;

export { fromIsoDate, toIsoDate };

export function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    dateOfBirth: row.dateOfBirth ? toIsoDate(row.dateOfBirth) : null,
    jobTitle: row.jobTitle,
    location: row.location,
    joiningDate: toIsoDate(row.joiningDate),
    employmentType: row.employmentType,
    status: row.status,
    department: row.department,
    manager: row.manager as EmployeeRef | null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Business fields recorded in audit before/after snapshots. */
export function toEmployeeSnapshot(
  row: EmployeeModel,
): Record<string, unknown> {
  return {
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    dateOfBirth: row.dateOfBirth ? toIsoDate(row.dateOfBirth) : null,
    jobTitle: row.jobTitle,
    location: row.location,
    joiningDate: toIsoDate(row.joiningDate),
    employmentType: row.employmentType,
    status: row.status,
    departmentId: row.departmentId,
    managerId: row.managerId,
  };
}

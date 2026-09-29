import { z } from 'zod';
import type { EmployeeRef } from './employee.js';

export const DEPARTMENT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type DepartmentStatus = (typeof DEPARTMENT_STATUSES)[number];

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,10}$/, '2–10 letters, digits, - or _'),
  managerId: z.uuid().nullable().optional(),
});
export type CreateDepartmentInput = z.input<typeof createDepartmentSchema>;
export type CreateDepartmentRequest = z.output<typeof createDepartmentSchema>;

export const updateDepartmentSchema = createDepartmentSchema.partial().extend({
  status: z.enum(DEPARTMENT_STATUSES).optional(),
});
export type UpdateDepartmentInput = z.input<typeof updateDepartmentSchema>;
export type UpdateDepartmentRequest = z.output<typeof updateDepartmentSchema>;

export interface Department {
  id: string;
  name: string;
  code: string;
  status: DepartmentStatus;
  manager: EmployeeRef | null;
  employeeCount: number;
}

import { z } from 'zod';
import { isoDate, paginationQuery } from './common.js';

export const EMPLOYEE_STATUSES = ['ACTIVE', 'PROBATION', 'ARCHIVED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

const optionalText = z
  .string()
  .trim()
  .max(50)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const employeeFields = {
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  email: z.email('Enter a valid email').trim().toLowerCase(),
  phone: optionalText,
  dateOfBirth: isoDate.nullable().optional(),
  jobTitle: z.string().trim().min(1, 'Job title is required').max(150),
  departmentId: z.uuid('Select a department'),
  managerId: z.uuid().nullable().optional(),
  location: z.string().trim().min(1, 'Location is required').max(100),
  joiningDate: isoDate,
  employmentType: z.enum(EMPLOYMENT_TYPES),
};

export const createEmployeeSchema = z.object({
  ...employeeFields,
  status: z.enum(['ACTIVE', 'PROBATION']).default('PROBATION'),
});
export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;
export type CreateEmployeeRequest = z.output<typeof createEmployeeSchema>;

/**
 * Partial update. `version` is required for optimistic locking; the API
 * rejects the update with 409 if the record changed since it was read.
 * Archiving goes through its own endpoint, so ARCHIVED is not allowed here.
 */
export const updateEmployeeSchema = z
  .object(employeeFields)
  .partial()
  .extend({
    status: z.enum(['ACTIVE', 'PROBATION']).optional(),
    version: z.number().int().min(1),
  });
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>;
export type UpdateEmployeeRequest = z.output<typeof updateEmployeeSchema>;

export const archiveEmployeeSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().max(500).optional(),
});
export type ArchiveEmployeeRequest = z.output<typeof archiveEmployeeSchema>;

export const employeeSearchSchema = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  departmentId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  location: z.string().trim().max(100).optional(),
  /** Omit to list ACTIVE and PROBATION employees only. */
  status: z.enum(EMPLOYEE_STATUSES).optional(),
});
export type EmployeeSearchQuery = z.output<typeof employeeSearchSchema>;
/** Query params a client sends; the API fills in defaults. */
export type EmployeeSearchParams = Partial<EmployeeSearchQuery>;

export interface EmployeeRef {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
}

export interface Employee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  dateOfBirth: string | null;
  jobTitle: string;
  location: string;
  joiningDate: string;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  department: { id: string; name: string } | null;
  manager: EmployeeRef | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

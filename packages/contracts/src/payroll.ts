import { z } from 'zod';
import { isoDate, userRefSchema } from './common.js';
import { EMPLOYMENT_TYPES, employeeRefSchema } from './employee.js';

export const payrollReportSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
});
export type PayrollReportQuery = z.output<typeof payrollReportSchema>;

export const PAYROLL_FLAG_CODES = [
  'MISSING_BANK_DETAILS',
  'BANK_DETAILS_FLAGGED',
  'MISSING_PAN',
  'UNRESOLVED_ATTENDANCE',
  'PENDING_LEAVE',
  'PENDING_CORRECTION',
] as const;
export type PayrollFlagCode = (typeof PAYROLL_FLAG_CODES)[number];

/** Something to fix before the payroll run. */
export const payrollFlagSchema = z.object({
  code: z.enum(PAYROLL_FLAG_CODES),
  message: z.string(),
});
export type PayrollFlag = z.infer<typeof payrollFlagSchema>;

/** Payroll inputs for one employee and month. No salary maths: that's out of MVP scope. */
export const payrollRowSchema = z.object({
  employee: employeeRefSchema,
  department: z.string().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  joiningDate: isoDate,
  /** Joined during the month (pay is prorated from the joining date). */
  newJoiner: z.boolean(),
  /** Company working days in the month while employed. */
  workingDays: z.number(),
  /** Present days (half days count 0.5). */
  daysWorked: z.number(),
  paidLeaveDays: z.number(),
  unpaidLeaveDays: z.number(),
  /** Absent without leave, or no record and no leave. */
  unexplainedDays: z.number(),
  /** Loss of pay: unpaid leave + unexplained days. */
  lopDays: z.number(),
  payableDays: z.number(),
  flags: z.array(payrollFlagSchema),
});
export type PayrollRow = z.infer<typeof payrollRowSchema>;

export const payrollChangeSchema = z.object({
  employee: employeeRefSchema,
  kind: z.enum(['JOINED', 'EXITED', 'CHANGED']),
  summary: z.string(),
  date: isoDate,
  by: userRefSchema.nullable(),
});
export type PayrollChange = z.infer<typeof payrollChangeSchema>;

export const payrollReportResponseSchema = z.object({
  month: z.string(),
  /** Last date the report covers (month end, or today for the current month). */
  through: isoDate,
  complete: z.boolean(),
  summary: z.object({
    headcount: z.number().int(),
    newJoiners: z.number().int(),
    exits: z.number().int(),
    employeesWithFlags: z.number().int(),
    lopDays: z.number(),
  }),
  rows: z.array(payrollRowSchema),
  changes: z.array(payrollChangeSchema),
});
export type PayrollReport = z.infer<typeof payrollReportResponseSchema>;

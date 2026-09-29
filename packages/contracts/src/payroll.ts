import { z } from 'zod';
import type { UserRef } from './common.js';
import type { EmployeeRef, EmploymentType } from './employee.js';

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
export interface PayrollFlag {
  code: PayrollFlagCode;
  message: string;
}

/** Payroll inputs for one employee and month. No salary maths: that's out of MVP scope. */
export interface PayrollRow {
  employee: EmployeeRef;
  department: string | null;
  employmentType: EmploymentType;
  joiningDate: string;
  /** Joined during the month (pay is prorated from the joining date). */
  newJoiner: boolean;
  /** Company working days in the month while employed. */
  workingDays: number;
  /** Present days (half days count 0.5). */
  daysWorked: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  /** Absent without leave, or no record and no leave. */
  unexplainedDays: number;
  /** Loss of pay: unpaid leave + unexplained days. */
  lopDays: number;
  payableDays: number;
  flags: PayrollFlag[];
}

export interface PayrollChange {
  employee: EmployeeRef;
  kind: 'JOINED' | 'EXITED' | 'CHANGED';
  summary: string;
  date: string;
  by: UserRef | null;
}

export interface PayrollReport {
  month: string;
  /** Last date the report covers (month end, or today for the current month). */
  through: string;
  complete: boolean;
  summary: {
    headcount: number;
    newJoiners: number;
    exits: number;
    employeesWithFlags: number;
    lopDays: number;
  };
  rows: PayrollRow[];
  changes: PayrollChange[];
}

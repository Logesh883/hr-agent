import { z } from 'zod';
import { isoDate, isoDateTime, paginationQuery, userRefSchema, type UserRef } from './common.js';
import { employeeRefSchema, type EmployeeRef } from './employee.js';
import { LEAVE_TYPES } from './leave.js';

/** What a stored attendance record says. */
export const ATTENDANCE_STATUSES = ['PRESENT', 'HALF_DAY', 'ABSENT'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** What a day works out to once leave, holidays and weekends are applied. */
export const DAY_STATUSES = [
  'PRESENT',
  'HALF_DAY',
  'ABSENT',
  'ON_LEAVE',
  'HOLIDAY',
  'WEEKEND',
  'MISSING',
  'NOT_EMPLOYED',
  'UPCOMING',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const ANOMALY_CODES = [
  'MISSING_RECORD',
  'ABSENT_WITHOUT_LEAVE',
  'WORKED_ON_LEAVE',
  'LATE_CHECK_IN',
  'MISSING_CHECK_OUT',
  'SHORT_DAY',
] as const;
export type AnomalyCode = (typeof ANOMALY_CODES)[number];

/** Company attendance rules; times are local (Asia/Kolkata). */
export const ATTENDANCE_RULES = {
  lateAfter: '10:30',
  minHoursPresent: 6,
  minHoursHalfDay: 4,
} as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const dailyAttendanceSchema = z.object({
  date: isoDate,
  departmentId: z.uuid().optional(),
});
export type DailyAttendanceQuery = z.output<typeof dailyAttendanceSchema>;

export const monthlyAttendanceSchema = z.object({
  month,
  departmentId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
});
export type MonthlyAttendanceQuery = z.output<typeof monthlyAttendanceSchema>;

export const proposeCorrectionSchema = z
  .object({
    employeeId: z.uuid(),
    date: isoDate,
    status: z.enum(ATTENDANCE_STATUSES),
    checkIn: time.nullable().optional(),
    checkOut: time.nullable().optional(),
    reason: z.string().trim().min(1, 'Explain why the record should change').max(500),
  })
  .refine((v) => v.status === 'ABSENT' || !!v.checkIn, {
    path: ['checkIn'],
    message: 'Check-in time is required unless the employee was absent',
  })
  .refine((v) => !v.checkIn || !v.checkOut || v.checkOut > v.checkIn, {
    path: ['checkOut'],
    message: 'Check-out must be after check-in',
  });
export type ProposeCorrectionInput = z.input<typeof proposeCorrectionSchema>;
export type ProposeCorrectionBody = z.output<typeof proposeCorrectionSchema>;

export const correctionApproveSchema = z.object({
  comment: z.string().trim().max(500).optional(),
});
export const correctionRejectSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason for the rejection').max(500),
});

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const correctionSearchSchema = paginationQuery.extend({
  status: z.enum(CORRECTION_STATUSES).optional(),
  employeeId: z.uuid().optional(),
});
export type CorrectionSearchQuery = z.output<typeof correctionSearchSchema>;
export type CorrectionSearchParams = Partial<CorrectionSearchQuery>;

export const attendanceAnomalySchema = z.object({
  code: z.enum(ANOMALY_CODES),
  message: z.string(),
});
export type AttendanceAnomaly = z.infer<typeof attendanceAnomalySchema>;

export const attendanceEntrySchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  /** Local time, HH:mm. */
  checkIn: z.string().nullable(),
  checkOut: z.string().nullable(),
});
export type AttendanceEntry = z.infer<typeof attendanceEntrySchema>;

export const attendanceDaySchema = z.object({
  date: isoDate,
  employee: employeeRefSchema,
  dayStatus: z.enum(DAY_STATUSES),
  record: attendanceEntrySchema
    .extend({
      id: z.uuid(),
      source: z.enum(['SYSTEM', 'MANUAL', 'CORRECTION']),
      correctionReason: z.string().nullable(),
    })
    .nullable(),
  /** Worked time in minutes, when both times are known. */
  workedMinutes: z.number().nullable(),
  leave: z.object({ id: z.uuid(), type: z.enum(LEAVE_TYPES) }).nullable(),
  holiday: z.string().nullable(),
  anomalies: z.array(attendanceAnomalySchema),
  /** Whether a correction is already waiting for approval for this day. */
  pendingCorrection: z.boolean(),
});
export type AttendanceDay = z.infer<typeof attendanceDaySchema>;

export interface DailyAttendance {
  date: string;
  holiday: string | null;
  isWorkingDay: boolean;
  rows: AttendanceDay[];
  summary: Record<'present' | 'halfDay' | 'absent' | 'onLeave' | 'missing', number>;
}

export const monthlyAttendanceRowSchema = z.object({
  employee: employeeRefSchema,
  workingDays: z.number(),
  present: z.number(),
  halfDays: z.number(),
  absent: z.number(),
  onLeave: z.number(),
  missing: z.number(),
  anomalies: z.number(),
});
export type MonthlyAttendanceRow = z.infer<typeof monthlyAttendanceRowSchema>;

export const monthlyAttendanceReportSchema = z.object({
  month,
  /** Working days elapsed so far (the whole month once it's over). */
  workingDays: z.number(),
  rows: z.array(monthlyAttendanceRowSchema),
  /** Every anomaly in the month, newest first. */
  anomalies: z.array(attendanceAnomalySchema.extend({ date: isoDate, employee: employeeRefSchema })),
  /** Day-by-day detail; only when a single employee is requested. */
  days: z.array(attendanceDaySchema).optional(),
});
export type MonthlyAttendance = z.infer<typeof monthlyAttendanceReportSchema>;

export const attendanceCorrectionSchema = z.object({
  id: z.uuid(),
  employee: employeeRefSchema,
  date: isoDate,
  proposed: attendanceEntrySchema,
  /** The record before the change (null when there was none). */
  previous: attendanceEntrySchema.nullable(),
  reason: z.string(),
  status: z.enum(CORRECTION_STATUSES),
  proposedBy: userRefSchema,
  proposedAt: isoDateTime,
  reviewedBy: userRefSchema.nullable(),
  reviewedAt: isoDateTime.nullable(),
  reviewComment: z.string().nullable(),
  /** HR, not the proposer, and not their own attendance. */
  canReview: z.boolean(),
});
export type AttendanceCorrection = z.infer<typeof attendanceCorrectionSchema>;

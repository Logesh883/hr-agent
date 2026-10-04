import { z } from 'zod';
import { isoDate, isoDateTime, paginationQuery, userRefSchema } from './common.js';
import { employeeRefSchema } from './employee.js';

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'CASUAL', 'UNPAID'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/**
 * Deterministic leave policy. Entitlements are per calendar year and prorated
 * by joining month; `null` means no balance is tracked.
 */
export const LEAVE_POLICY: Record<LeaveType, { label: string; daysPerYear: number | null }> = {
  ANNUAL: { label: 'Annual leave', daysPerYear: 18 },
  SICK: { label: 'Sick leave', daysPerYear: 12 },
  CASUAL: { label: 'Casual leave', daysPerYear: 6 },
  UNPAID: { label: 'Unpaid leave', daysPerYear: null },
};

export const LEAVE_RULES = {
  /** How far back a request may start, in days. */
  maxBackdateDays: 30,
  /** Longest single request, in calendar days. */
  maxSpanDays: 60,
} as const;

export const leaveRequestSchema = z
  .object({
    /** Defaults to the requester's own employee record. */
    employeeId: z.uuid().optional(),
    type: z.enum(LEAVE_TYPES),
    startDate: isoDate,
    endDate: isoDate,
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    path: ['endDate'],
    message: 'End date must be on or after the start date',
  });
export type LeaveRequestInput = z.input<typeof leaveRequestSchema>;
export type LeaveRequestBody = z.output<typeof leaveRequestSchema>;

export const leaveApproveSchema = z.object({
  comment: z.string().trim().max(500).optional(),
});
export type LeaveApproveBody = z.output<typeof leaveApproveSchema>;

export const leaveRejectSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason for the rejection').max(500),
});
export type LeaveRejectBody = z.output<typeof leaveRejectSchema>;

export const LEAVE_VIEWS = ['mine', 'approvals', 'all'] as const;

export const leaveSearchSchema = paginationQuery.extend({
  /** mine: own requests · approvals: pending requests the caller may decide · all: everything in scope */
  view: z.enum(LEAVE_VIEWS).default('all'),
  employeeId: z.uuid().optional(),
  status: z.enum(LEAVE_STATUSES).optional(),
  type: z.enum(LEAVE_TYPES).optional(),
  /** Requests overlapping [from, to]. */
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type LeaveSearchQuery = z.output<typeof leaveSearchSchema>;
export type LeaveSearchParams = Partial<LeaveSearchQuery>;

export const leaveBalanceQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const LEAVE_PROBLEM_CODES = [
  'END_BEFORE_START',
  'CROSSES_YEAR',
  'TOO_LONG',
  'TOO_FAR_IN_PAST',
  'BEFORE_JOINING',
  'NO_WORKING_DAYS',
  'OVERLAP',
  'INSUFFICIENT_BALANCE',
  'EMPLOYEE_ARCHIVED',
] as const;
export type LeaveProblemCode = (typeof LEAVE_PROBLEM_CODES)[number];

/** A reason a request can't be made or approved, in words an HR user (or the AI agent) can relay. */
export const leaveProblemSchema = z.object({
  code: z.enum(LEAVE_PROBLEM_CODES),
  message: z.string(),
});
export type LeaveProblem = z.infer<typeof leaveProblemSchema>;

export const leaveBalanceSchema = z.object({
  type: z.enum(LEAVE_TYPES),
  year: z.number().int(),
  /** null when the type has no balance (unpaid). */
  entitled: z.number().nullable(),
  used: z.number(),
  pending: z.number(),
  available: z.number().nullable(),
});
export type LeaveBalance = z.infer<typeof leaveBalanceSchema>;

export const leavePreviewSchema = z.object({
  workingDays: z.number(),
  /** Weekends and holidays inside the range that don't count. */
  nonWorkingDays: z.array(z.object({ date: isoDate, reason: z.string() })),
  balance: leaveBalanceSchema.nullable(),
  balanceAfter: z.number().nullable(),
  problems: z.array(leaveProblemSchema),
});
export type LeavePreview = z.infer<typeof leavePreviewSchema>;

export const leaveRequestRecordSchema = z.object({
  id: z.uuid(),
  employee: employeeRefSchema,
  type: z.enum(LEAVE_TYPES),
  startDate: isoDate,
  endDate: isoDate,
  days: z.number(),
  reason: z.string().nullable(),
  status: z.enum(LEAVE_STATUSES),
  requestedBy: userRefSchema,
  decidedBy: userRefSchema.nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionComment: z.string().nullable(),
  createdAt: isoDateTime,
  /** Whether the caller may approve/reject or cancel this request. */
  canDecide: z.boolean(),
  canCancel: z.boolean(),
});
export type LeaveRequest = z.infer<typeof leaveRequestRecordSchema>;

export interface Holiday {
  date: string;
  name: string;
}

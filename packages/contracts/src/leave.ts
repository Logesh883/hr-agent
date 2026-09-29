import { z } from 'zod';
import { isoDate, paginationQuery, type UserRef } from './common.js';
import type { EmployeeRef } from './employee.js';

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
export interface LeaveProblem {
  code: LeaveProblemCode;
  message: string;
}

export interface LeaveBalance {
  type: LeaveType;
  year: number;
  /** null when the type has no balance (unpaid). */
  entitled: number | null;
  used: number;
  pending: number;
  available: number | null;
}

export interface LeavePreview {
  workingDays: number;
  /** Weekends and holidays inside the range that don't count. */
  nonWorkingDays: { date: string; reason: string }[];
  balance: LeaveBalance | null;
  balanceAfter: number | null;
  problems: LeaveProblem[];
}

export interface LeaveRequest {
  id: string;
  employee: EmployeeRef;
  type: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  requestedBy: UserRef;
  decidedBy: UserRef | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdAt: string;
  /** Whether the caller may approve/reject or cancel this request. */
  canDecide: boolean;
  canCancel: boolean;
}

export interface Holiday {
  date: string;
  name: string;
}

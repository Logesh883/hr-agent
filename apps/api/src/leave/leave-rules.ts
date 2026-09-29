/**
 * Deterministic leave rules. Pure functions: no database, no clock, so the
 * same inputs always give the same answer (and they're easy to unit test).
 */
import {
  LEAVE_POLICY,
  LEAVE_RULES,
  type EmployeeStatus,
  type LeaveBalance,
  type LeavePreview,
  type LeaveProblem,
  type LeaveStatus,
  type LeaveType,
} from '@hr/contracts';
import {
  addDays,
  daysBetween,
  eachDay,
  formatDate,
  isWeekend,
  yearOf,
} from '../common/dates.js';

export interface LeaveWindow {
  startDate: string;
  endDate: string;
}

export interface LeaveContext extends LeaveWindow {
  type: LeaveType;
  today: string;
  employee: { status: EmployeeStatus; joiningDate: string };
  /** Holiday date → name. */
  holidays: ReadonlyMap<string, string>;
  /** The employee's other PENDING/APPROVED requests (not this one). */
  otherRequests: (LeaveWindow & { status: LeaveStatus })[];
  /** Balance for the request's year, not counting this request. */
  balance: LeaveBalance | null;
  /** Approving an existing request: backdating limits no longer apply. */
  forApproval?: boolean;
}

export function countWorkingDays(
  { startDate, endDate }: LeaveWindow,
  holidays: ReadonlyMap<string, string>,
): Pick<LeavePreview, 'workingDays' | 'nonWorkingDays'> {
  const nonWorkingDays: LeavePreview['nonWorkingDays'] = [];
  let workingDays = 0;
  if (endDate < startDate) return { workingDays, nonWorkingDays };

  for (const date of eachDay(startDate, endDate)) {
    const holiday = holidays.get(date);
    if (isWeekend(date)) nonWorkingDays.push({ date, reason: 'Weekend' });
    else if (holiday) nonWorkingDays.push({ date, reason: holiday });
    else workingDays++;
  }
  return { workingDays, nonWorkingDays };
}

export function evaluateLeave(ctx: LeaveContext): LeavePreview {
  const problems: LeaveProblem[] = [];
  const add = (code: LeaveProblem['code'], message: string) =>
    problems.push({ code, message });

  const { workingDays, nonWorkingDays } = countWorkingDays(ctx, ctx.holidays);

  if (ctx.employee.status === 'ARCHIVED') {
    add('EMPLOYEE_ARCHIVED', 'This employee is archived.');
  }
  if (ctx.endDate < ctx.startDate) {
    add('END_BEFORE_START', 'End date must be on or after the start date.');
  } else {
    if (yearOf(ctx.startDate) !== yearOf(ctx.endDate)) {
      add('CROSSES_YEAR', "Leave can't span two calendar years. Split it into two requests.");
    }
    if (daysBetween(ctx.startDate, ctx.endDate) + 1 > LEAVE_RULES.maxSpanDays) {
      add('TOO_LONG', `A single request can cover at most ${LEAVE_RULES.maxSpanDays} calendar days.`);
    }
    if (workingDays === 0) {
      add('NO_WORKING_DAYS', 'The selected dates are all weekends or holidays.');
    }
  }
  if (!ctx.forApproval && ctx.startDate < addDays(ctx.today, -LEAVE_RULES.maxBackdateDays)) {
    add('TOO_FAR_IN_PAST', `Leave can't start more than ${LEAVE_RULES.maxBackdateDays} days in the past.`);
  }
  if (ctx.startDate < ctx.employee.joiningDate) {
    add('BEFORE_JOINING', `Leave can't start before the joining date (${formatDate(ctx.employee.joiningDate)}).`);
  }

  const overlap = ctx.otherRequests.find(
    (r) => r.startDate <= ctx.endDate && r.endDate >= ctx.startDate,
  );
  if (overlap) {
    add(
      'OVERLAP',
      `Overlaps with ${overlap.status.toLowerCase()} leave from ${formatDate(overlap.startDate)} to ${formatDate(overlap.endDate)}.`,
    );
  }

  const available = ctx.balance?.available ?? null;
  if (available !== null && workingDays > available) {
    const label = LEAVE_POLICY[ctx.type].label.toLowerCase();
    add(
      'INSUFFICIENT_BALANCE',
      `Needs ${plural(workingDays, 'working day')} of ${label} but only ${available} ${available === 1 ? 'is' : 'are'} available in ${yearOf(ctx.startDate)}.`,
    );
  }

  return {
    workingDays,
    nonWorkingDays,
    balance: ctx.balance,
    balanceAfter: available === null ? null : available - workingDays,
    problems,
  };
}

/**
 * Annual entitlement, prorated by joining month for people who joined during
 * the year (rounded down to the nearest half day).
 */
export function entitlementFor(
  type: LeaveType,
  year: number,
  joiningDate: string,
): number | null {
  const perYear = LEAVE_POLICY[type].daysPerYear;
  if (perYear === null) return null;
  const joinYear = yearOf(joiningDate);
  if (joinYear > year) return 0;
  if (joinYear < year) return perYear;
  const monthsRemaining = 12 - Number(joiningDate.slice(5, 7)) + 1;
  return Math.floor(((perYear * monthsRemaining) / 12) * 2) / 2;
}

export function buildBalance(
  type: LeaveType,
  year: number,
  joiningDate: string,
  requests: { type: LeaveType; status: LeaveStatus; days: number; startDate: string }[],
): LeaveBalance {
  const inYear = requests.filter((r) => r.type === type && yearOf(r.startDate) === year);
  const sum = (status: LeaveStatus) =>
    inYear.filter((r) => r.status === status).reduce((total, r) => total + r.days, 0);
  const entitled = entitlementFor(type, year, joiningDate);
  const used = sum('APPROVED');
  const pending = sum('PENDING');
  return {
    type,
    year,
    entitled,
    used,
    pending,
    available: entitled === null ? null : entitled - used - pending,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

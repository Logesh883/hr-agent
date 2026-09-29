import type { LeaveBalance } from '@hr/contracts';
import {
  buildBalance,
  countWorkingDays,
  entitlementFor,
  evaluateLeave,
  type LeaveContext,
} from './leave-rules.js';

const holidays = new Map([['2026-10-02', 'Gandhi Jayanti']]);

const balance = (available: number | null): LeaveBalance => ({
  type: 'ANNUAL',
  year: 2026,
  entitled: available,
  used: 0,
  pending: 0,
  available,
});

const base: LeaveContext = {
  type: 'ANNUAL',
  startDate: '2026-10-05',
  endDate: '2026-10-09',
  today: '2026-09-29',
  employee: { status: 'ACTIVE', joiningDate: '2023-06-05' },
  holidays,
  otherRequests: [],
  balance: balance(18),
};

const codes = (ctx: Partial<LeaveContext>) =>
  evaluateLeave({ ...base, ...ctx }).problems.map((p) => p.code);

describe('countWorkingDays', () => {
  it('skips weekends and holidays', () => {
    // Thu 1 Oct → Tue 6 Oct: Fri 2 is a holiday, Sat/Sun are weekend.
    const result = countWorkingDays({ startDate: '2026-10-01', endDate: '2026-10-06' }, holidays);
    expect(result.workingDays).toBe(3);
    expect(result.nonWorkingDays).toEqual([
      { date: '2026-10-02', reason: 'Gandhi Jayanti' },
      { date: '2026-10-03', reason: 'Weekend' },
      { date: '2026-10-04', reason: 'Weekend' },
    ]);
  });
});

describe('evaluateLeave', () => {
  it('accepts a valid request and reports the balance after it', () => {
    const preview = evaluateLeave(base);
    expect(preview.problems).toEqual([]);
    expect(preview.workingDays).toBe(5);
    expect(preview.balanceAfter).toBe(13);
  });

  it('rejects a range with no working days', () => {
    expect(codes({ startDate: '2026-10-02', endDate: '2026-10-04' })).toEqual(['NO_WORKING_DAYS']);
  });

  it('explains an insufficient balance in words', () => {
    const preview = evaluateLeave({ ...base, balance: balance(3) });
    expect(preview.problems).toEqual([
      {
        code: 'INSUFFICIENT_BALANCE',
        message: 'Needs 5 working days of annual leave but only 3 are available in 2026.',
      },
    ]);
    expect(preview.balanceAfter).toBe(-2);
  });

  it('does not track a balance for unpaid leave', () => {
    const preview = evaluateLeave({ ...base, type: 'UNPAID', balance: balance(null) });
    expect(preview.problems).toEqual([]);
    expect(preview.balanceAfter).toBeNull();
  });

  it('detects overlap with other pending or approved leave', () => {
    const problems = evaluateLeave({
      ...base,
      otherRequests: [{ startDate: '2026-10-09', endDate: '2026-10-12', status: 'APPROVED' }],
    }).problems;
    expect(problems.map((p) => p.code)).toEqual(['OVERLAP']);
    expect(problems[0].message).toBe('Overlaps with approved leave from 9 Oct 2026 to 12 Oct 2026.');
  });

  it('blocks backdating beyond the limit, but not when approving', () => {
    const old = { startDate: '2026-08-03', endDate: '2026-08-04' };
    expect(codes(old)).toContain('TOO_FAR_IN_PAST');
    expect(codes({ ...old, forApproval: true })).not.toContain('TOO_FAR_IN_PAST');
    expect(codes({ startDate: '2026-09-01', endDate: '2026-09-01' })).toEqual([]);
  });

  it('rejects requests crossing a year, too long, before joining, or for archived staff', () => {
    expect(codes({ startDate: '2026-12-28', endDate: '2027-01-05' })).toContain('CROSSES_YEAR');
    expect(codes({ startDate: '2026-10-05', endDate: '2026-12-31', balance: balance(null) })).toContain('TOO_LONG');
    expect(codes({ employee: { status: 'ACTIVE', joiningDate: '2026-10-07' } })).toContain('BEFORE_JOINING');
    expect(codes({ employee: { status: 'ARCHIVED', joiningDate: '2023-06-05' } })).toContain('EMPLOYEE_ARCHIVED');
  });

  it('rejects an end date before the start date', () => {
    expect(codes({ startDate: '2026-10-09', endDate: '2026-10-05' })).toContain('END_BEFORE_START');
  });
});

describe('entitlementFor / buildBalance', () => {
  it('prorates by joining month, rounded down to half days', () => {
    expect(entitlementFor('ANNUAL', 2026, '2020-01-01')).toBe(18);
    expect(entitlementFor('ANNUAL', 2026, '2026-07-01')).toBe(9); // 6 of 12 months
    expect(entitlementFor('CASUAL', 2026, '2026-08-03')).toBe(2.5); // 5/12 × 6 = 2.5
    expect(entitlementFor('SICK', 2026, '2027-01-10')).toBe(0);
    expect(entitlementFor('UNPAID', 2026, '2020-01-01')).toBeNull();
  });

  it('counts approved as used and pending separately, per type and year', () => {
    const result = buildBalance('ANNUAL', 2026, '2020-01-01', [
      { type: 'ANNUAL', status: 'APPROVED', days: 5, startDate: '2026-08-10' },
      { type: 'ANNUAL', status: 'PENDING', days: 3, startDate: '2026-10-19' },
      { type: 'SICK', status: 'APPROVED', days: 2, startDate: '2026-09-14' },
      { type: 'ANNUAL', status: 'APPROVED', days: 4, startDate: '2025-12-01' },
    ]);
    expect(result).toEqual({ type: 'ANNUAL', year: 2026, entitled: 18, used: 5, pending: 3, available: 10 });
  });
});

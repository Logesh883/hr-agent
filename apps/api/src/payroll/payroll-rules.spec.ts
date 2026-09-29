import type { AttendanceDay, DayStatus, LeaveType } from '@hr/contracts';
import { payrollCounts, toCsv } from './payroll-rules.js';

const day = (date: string, dayStatus: DayStatus, leave?: LeaveType): AttendanceDay => ({
  date,
  employee: { id: 'e1', employeeCode: 'EMP-0001', firstName: 'A', lastName: 'B' },
  dayStatus,
  record: null,
  workedMinutes: null,
  leave: leave ? { id: 'l1', type: leave } : null,
  holiday: null,
  anomalies: [],
  pendingCorrection: false,
});

describe('payrollCounts', () => {
  it('splits working days into worked, paid leave and loss of pay', () => {
    const counts = payrollCounts(
      [
        day('2026-09-01', 'PRESENT'),
        day('2026-09-02', 'HALF_DAY'),
        day('2026-09-03', 'ON_LEAVE', 'ANNUAL'),
        day('2026-09-04', 'ON_LEAVE', 'UNPAID'),
        day('2026-09-05', 'WEEKEND'),
        day('2026-09-07', 'ABSENT'),
        day('2026-09-08', 'MISSING'),
        day('2026-09-09', 'HOLIDAY'),
        day('2026-09-10', 'PRESENT'),
      ],
      '2026-09-30',
    );
    expect(counts).toEqual({
      workingDays: 7,
      daysWorked: 2.5,
      paidLeaveDays: 1,
      unpaidLeaveDays: 1,
      unexplainedDays: 2,
      lopDays: 3.5,
      payableDays: 3.5,
    });
  });

  it('ignores days after the cut-off and days before joining', () => {
    const counts = payrollCounts(
      [day('2026-09-01', 'NOT_EMPLOYED'), day('2026-09-02', 'PRESENT'), day('2026-09-03', 'MISSING')],
      '2026-09-02',
    );
    expect(counts).toMatchObject({ workingDays: 1, daysWorked: 1, lopDays: 0, payableDays: 1 });
  });
});

describe('toCsv', () => {
  it('quotes cells that need it', () => {
    expect(toCsv([['Name', 'Note'], ['Kavya Shetty', 'Name "Kavya S." doesn\'t match, check']]))
      .toBe('Name,Note\r\nKavya Shetty,"Name ""Kavya S."" doesn\'t match, check"\r\n');
  });
});

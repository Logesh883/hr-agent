/**
 * Turns an employee's evaluated attendance days into payroll inputs.
 * Pure: no database, no clock.
 */
import type { AttendanceDay, PayrollRow } from '@hr/contracts';

type Counts = Pick<
  PayrollRow,
  'workingDays' | 'daysWorked' | 'paidLeaveDays' | 'unpaidLeaveDays' | 'unexplainedDays' | 'lopDays' | 'payableDays'
>;

/** Days up to and including `through` count; later days are ignored. */
export function payrollCounts(days: AttendanceDay[], through: string): Counts {
  const counts = {
    workingDays: 0,
    daysWorked: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    unexplainedDays: 0,
    halfDays: 0,
  };
  for (const day of days) {
    if (day.date > through) continue;
    switch (day.dayStatus) {
      case 'PRESENT':
        counts.workingDays++;
        counts.daysWorked++;
        break;
      case 'HALF_DAY':
        counts.workingDays++;
        counts.daysWorked += 0.5;
        counts.halfDays++;
        break;
      case 'ON_LEAVE':
        counts.workingDays++;
        if (day.leave?.type === 'UNPAID') counts.unpaidLeaveDays++;
        else counts.paidLeaveDays++;
        break;
      case 'ABSENT':
      case 'MISSING':
        counts.workingDays++;
        counts.unexplainedDays++;
        break;
      default:
        // Weekends, holidays, days before joining and future days aren't payroll days.
        break;
    }
  }
  // The unworked half of a half day is loss of pay unless covered by leave.
  const lopDays = counts.unpaidLeaveDays + counts.unexplainedDays + counts.halfDays * 0.5;
  return {
    workingDays: counts.workingDays,
    daysWorked: counts.daysWorked,
    paidLeaveDays: counts.paidLeaveDays,
    unpaidLeaveDays: counts.unpaidLeaveDays,
    unexplainedDays: counts.unexplainedDays,
    lopDays,
    payableDays: counts.workingDays - lopDays,
  };
}

/** RFC 4180 CSV. */
export function toCsv(rows: (string | number | boolean | null)[][]): string {
  const cell = (value: string | number | boolean | null) => {
    const text = value === null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

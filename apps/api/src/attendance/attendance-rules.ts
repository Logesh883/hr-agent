/**
 * Deterministic attendance rules: what a day works out to, and what looks
 * wrong about it. Pure functions; no database, no clock.
 */
import {
  ATTENDANCE_RULES,
  LEAVE_POLICY,
  type AttendanceAnomaly,
  type AttendanceEntry,
  type DayStatus,
  type LeaveType,
} from '@hr/contracts';
import { isWeekend, minutesBetween } from '../common/dates.js';

export interface DayInput {
  date: string;
  today: string;
  joiningDate: string;
  holiday: string | null;
  record: AttendanceEntry | null;
  /** Approved leave covering this day. */
  leave: { type: LeaveType } | null;
}

export interface DayResult {
  dayStatus: DayStatus;
  workedMinutes: number | null;
  anomalies: AttendanceAnomaly[];
}

export function evaluateDay(input: DayInput): DayResult {
  const { date, today, record, leave } = input;
  const workedMinutes =
    record?.checkIn && record.checkOut ? minutesBetween(record.checkIn, record.checkOut) : null;
  const result = (dayStatus: DayStatus, anomalies: AttendanceAnomaly[] = []): DayResult => ({
    dayStatus,
    workedMinutes,
    anomalies,
  });

  if (date < input.joiningDate) return result('NOT_EMPLOYED');
  if (date > today) return result('UPCOMING');
  if (isWeekend(date)) return result('WEEKEND');
  if (input.holiday) return result('HOLIDAY');

  // The day isn't over yet, so gaps today aren't anomalies.
  const dayOver = date < today;

  if (leave) {
    if (record && record.status !== 'ABSENT') {
      return result(record.status, [
        {
          code: 'WORKED_ON_LEAVE',
          message: `Checked in on a day of approved ${LEAVE_POLICY[leave.type].label.toLowerCase()}.`,
        },
      ]);
    }
    return result('ON_LEAVE');
  }

  if (!record) {
    return result(
      'MISSING',
      dayOver ? [{ code: 'MISSING_RECORD', message: 'No attendance record and no approved leave.' }] : [],
    );
  }

  if (record.status === 'ABSENT') {
    return result('ABSENT', [
      { code: 'ABSENT_WITHOUT_LEAVE', message: 'Marked absent without approved leave.' },
    ]);
  }

  const anomalies: AttendanceAnomaly[] = [];
  if (record.checkIn && record.checkIn > ATTENDANCE_RULES.lateAfter) {
    anomalies.push({
      code: 'LATE_CHECK_IN',
      message: `Checked in at ${record.checkIn}, after ${ATTENDANCE_RULES.lateAfter}.`,
    });
  }
  if (record.checkIn && !record.checkOut && dayOver) {
    anomalies.push({ code: 'MISSING_CHECK_OUT', message: 'Checked in but never checked out.' });
  }
  const minimumHours =
    record.status === 'PRESENT' ? ATTENDANCE_RULES.minHoursPresent : ATTENDANCE_RULES.minHoursHalfDay;
  if (workedMinutes !== null && workedMinutes < minimumHours * 60) {
    anomalies.push({
      code: 'SHORT_DAY',
      message: `Worked ${formatMinutes(workedMinutes)} but marked ${record.status === 'PRESENT' ? 'present' : 'half day'} (minimum ${minimumHours}h).`,
    });
  }
  return result(record.status, anomalies);
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

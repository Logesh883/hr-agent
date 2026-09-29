import { localTime, toInstant } from '../common/dates.js';
import { evaluateDay, type DayInput } from './attendance-rules.js';

// Tuesday 15 Sep 2026.
const base: DayInput = {
  date: '2026-09-15',
  today: '2026-09-29',
  joiningDate: '2023-01-02',
  holiday: null,
  record: { status: 'PRESENT', checkIn: '09:30', checkOut: '18:15' },
  leave: null,
};

const evaluate = (overrides: Partial<DayInput>) => evaluateDay({ ...base, ...overrides });
const codes = (overrides: Partial<DayInput>) => evaluate(overrides).anomalies.map((a) => a.code);

describe('evaluateDay', () => {
  it('accepts a normal day and reports worked time', () => {
    expect(evaluate({})).toEqual({ dayStatus: 'PRESENT', workedMinutes: 525, anomalies: [] });
  });

  it('classifies days before joining, upcoming days, weekends and holidays', () => {
    expect(evaluate({ joiningDate: '2026-09-20' }).dayStatus).toBe('NOT_EMPLOYED');
    expect(evaluate({ date: '2026-09-30', record: null }).dayStatus).toBe('UPCOMING');
    expect(evaluate({ date: '2026-09-19', record: null }).dayStatus).toBe('WEEKEND');
    expect(evaluate({ date: '2026-10-02', today: '2026-10-05', holiday: 'Gandhi Jayanti', record: null }).dayStatus).toBe('HOLIDAY');
  });

  it('flags a working day with no record and no leave', () => {
    expect(evaluate({ record: null })).toMatchObject({ dayStatus: 'MISSING', anomalies: [{ code: 'MISSING_RECORD' }] });
  });

  it("doesn't flag today's gaps before the day is over", () => {
    expect(evaluate({ date: '2026-09-29', record: null })).toMatchObject({ dayStatus: 'MISSING', anomalies: [] });
    expect(codes({ date: '2026-09-29', record: { status: 'PRESENT', checkIn: '09:10', checkOut: null } })).toEqual([]);
  });

  it('treats approved leave as on leave, and flags a check-in during it', () => {
    expect(evaluate({ record: null, leave: { type: 'ANNUAL' } }).dayStatus).toBe('ON_LEAVE');
    const worked = evaluate({ leave: { type: 'SICK' } });
    expect(worked.dayStatus).toBe('PRESENT');
    expect(worked.anomalies).toEqual([{ code: 'WORKED_ON_LEAVE', message: 'Checked in on a day of approved sick leave.' }]);
  });

  it('flags absence without leave', () => {
    expect(codes({ record: { status: 'ABSENT', checkIn: null, checkOut: null } })).toEqual(['ABSENT_WITHOUT_LEAVE']);
  });

  it('flags late check-in, missing check-out and short days', () => {
    expect(evaluate({ record: { status: 'PRESENT', checkIn: '10:52', checkOut: '19:30' } }).anomalies).toEqual([
      { code: 'LATE_CHECK_IN', message: 'Checked in at 10:52, after 10:30.' },
    ]);
    expect(codes({ record: { status: 'PRESENT', checkIn: '09:00', checkOut: null } })).toEqual(['MISSING_CHECK_OUT']);
    expect(evaluate({ record: { status: 'PRESENT', checkIn: '09:30', checkOut: '12:45' } }).anomalies).toEqual([
      { code: 'SHORT_DAY', message: 'Worked 3h 15m but marked present (minimum 6h).' },
    ]);
    expect(codes({ record: { status: 'HALF_DAY', checkIn: '09:30', checkOut: '13:45' } })).toEqual([]);
  });
});

describe('company time zone', () => {
  it('round-trips local times through instants', () => {
    const instant = toInstant('2026-09-15', '09:30');
    expect(instant.toISOString()).toBe('2026-09-15T04:00:00.000Z');
    expect(localTime(instant)).toBe('09:30');
  });
});

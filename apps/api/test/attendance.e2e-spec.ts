/**
 * Attendance views and the correction workflow against the real database
 * (run `pnpm db:up && pnpm db:seed` first). Uses seeded September 2026 data;
 * restores the one record it corrects and removes what it creates.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  AttendanceCorrection,
  DailyAttendance,
  Employee,
  LoginResponse,
  MonthlyAttendance,
  Paginated,
} from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const PASSWORD = 'Password123!';
const DIVYA_DAY = '2026-09-24';

describe('Attendance (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = { admin: '', hr: '', manager: '', employee: '' };
  const people: Record<string, Employee> = {};
  const created: string[] = [];
  let divyaRecord: { id: string; checkOut: Date | null; source: 'SYSTEM' | 'MANUAL' | 'CORRECTION'; correctionReason: string | null };

  const as = (who: keyof typeof tokens) => {
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${tokens[who]}`);
    return {
      get: (path: string) => auth(request(app.getHttpServer()).get(path)),
      post: (path: string, body: object = {}) => auth(request(app.getHttpServer()).post(path)).send(body),
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Bind to loopback explicitly (see employees.e2e-spec.ts).
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);

    for (const [who, email] of [
      ['admin', 'admin@hr.local'],
      ['hr', 'hr@hr.local'],
      ['manager', 'manager@hr.local'],
      ['employee', 'employee@hr.local'],
    ] as const) {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
      tokens[who] = (res.body as LoginResponse).accessToken;
    }
    for (const name of ['divya', 'rohan', 'farhan', 'karthik']) {
      const res = await as('hr').get(`/employees?q=${name}`).expect(200);
      people[name] = (res.body as Paginated<Employee>).items[0];
    }
    divyaRecord = await prisma.attendanceRecord.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: people.divya.id, date: new Date(`${DIVYA_DAY}T00:00:00Z`) } },
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...created, divyaRecord.id] } } });
    await prisma.attendanceCorrection.deleteMany({ where: { id: { in: created } } });
    await prisma.attendanceRecord.update({
      where: { id: divyaRecord.id },
      data: { checkOut: divyaRecord.checkOut, source: divyaRecord.source, correctionReason: divyaRecord.correctionReason },
    });
    await app.close();
  });

  it("cross-checks attendance with approved leave and flags what's off", async () => {
    const res = await as('hr').get('/attendance/monthly?month=2026-09').expect(200);
    const month = res.body as MonthlyAttendance;
    const find = (name: string, code: string) =>
      month.anomalies.find((a) => a.employee.id === people[name].id && a.code === code);

    expect(find('karthik', 'WORKED_ON_LEAVE')).toMatchObject({ date: '2026-09-15' });
    expect(find('rohan', 'MISSING_RECORD')).toMatchObject({ message: 'No attendance record and no approved leave.' });
    expect(find('divya', 'MISSING_CHECK_OUT')).toMatchObject({ date: DIVYA_DAY });
    expect(month.rows.find((r) => r.employee.id === people.rohan.id)?.missing).toBe(2);
  });

  it('scopes views: managers see their team, employees themselves', async () => {
    const team = await as('manager').get('/attendance/monthly?month=2026-09').expect(200);
    const names = (team.body as MonthlyAttendance).rows.map((r) => r.employee.firstName).sort();
    expect(names).toEqual(['Arun', 'Divya', 'Karthik', 'Rahul', 'Rohan', 'Sneha']);

    const own = await as('employee').get('/attendance/monthly?month=2026-09').expect(200);
    expect((own.body as MonthlyAttendance).rows.map((r) => r.employee.firstName)).toEqual(['Sneha']);
    await as('employee').get(`/attendance/monthly?month=2026-09&employeeId=${people.rohan.id}`).expect(404);
  });

  it('returns day-by-day detail for one employee', async () => {
    const res = await as('manager')
      .get(`/attendance/monthly?month=2026-09&employeeId=${people.karthik.id}`)
      .expect(200);
    const days = (res.body as MonthlyAttendance).days!;
    expect(days).toHaveLength(30);
    expect(days.find((d) => d.date === '2026-09-14')).toMatchObject({ dayStatus: 'ON_LEAVE', leave: { type: 'SICK' } });
    expect(days.find((d) => d.date === '2026-09-19')?.dayStatus).toBe('WEEKEND');
  });

  it('refuses corrections that make no sense', async () => {
    const base = { employeeId: people.divya.id, status: 'PRESENT', checkIn: '09:25', checkOut: '18:30', reason: 'Forgot to badge out' };
    await as('manager').post('/attendance/corrections', { ...base, date: '2026-09-19' }).expect(400); // Saturday
    await as('manager').post('/attendance/corrections', { ...base, date: '2027-01-04' }).expect(400); // future
    await as('manager').post('/attendance/corrections', { ...base, date: DIVYA_DAY, checkOut: '09:00' }).expect(400);
    await as('employee').post('/attendance/corrections', { ...base, date: DIVYA_DAY }).expect(403);
    await as('manager')
      .post('/attendance/corrections', { ...base, employeeId: people.farhan.id, date: '2026-09-23' })
      .expect(404); // not on Rahul's team
  });

  it("proposes without touching the record; approval applies it", async () => {
    const proposed = await as('manager')
      .post('/attendance/corrections', {
        employeeId: people.divya.id,
        date: DIVYA_DAY,
        status: 'PRESENT',
        checkIn: '09:25',
        checkOut: '18:30',
        reason: 'Forgot to badge out; left with the team at 18:30',
      })
      .expect(201);
    const correction = proposed.body as AttendanceCorrection;
    created.push(correction.id);
    expect(correction).toMatchObject({
      status: 'PENDING',
      previous: { status: 'PRESENT', checkIn: '09:25', checkOut: null },
      proposed: { status: 'PRESENT', checkIn: '09:25', checkOut: '18:30' },
      canReview: false,
    });

    await as('manager')
      .post('/attendance/corrections', { employeeId: people.divya.id, date: DIVYA_DAY, status: 'ABSENT', reason: 'dup' })
      .expect(409);

    // Historical record unchanged until approval.
    const before = await as('hr').get(`/attendance/daily?date=${DIVYA_DAY}`).expect(200);
    const divyaBefore = (before.body as DailyAttendance).rows.find((r) => r.employee.id === people.divya.id)!;
    expect(divyaBefore).toMatchObject({ record: { checkOut: null }, pendingCorrection: true });

    await as('manager').post(`/attendance/corrections/${correction.id}/approve`).expect(403);
    const approved = await as('hr').post(`/attendance/corrections/${correction.id}/approve`, { comment: 'OK' }).expect(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', reviewedBy: { name: 'Lakshmi Pillai' } });

    const after = await as('hr').get(`/attendance/daily?date=${DIVYA_DAY}`).expect(200);
    const divyaAfter = (after.body as DailyAttendance).rows.find((r) => r.employee.id === people.divya.id)!;
    expect(divyaAfter).toMatchObject({
      record: { checkOut: '18:30', source: 'CORRECTION' },
      anomalies: [],
      pendingCorrection: false,
    });

    const audit = await as('hr').get(`/audit-logs?entityType=AttendanceRecord&entityId=${divyaRecord.id}`).expect(200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'attendance.corrected',
      before: { checkOut: null },
      after: { checkOut: '18:30', correctionId: correction.id },
    });
  });

  it('keeps proposer and approver separate', async () => {
    const res = await as('hr')
      .post('/attendance/corrections', {
        employeeId: people.farhan.id,
        date: '2026-09-23',
        status: 'PRESENT',
        checkIn: '09:40',
        checkOut: '18:50',
        reason: 'Traffic diversion; manager confirmed arrival time',
      })
      .expect(201);
    const correction = res.body as AttendanceCorrection;
    created.push(correction.id);

    const own = await as('hr').post(`/attendance/corrections/${correction.id}/approve`).expect(403);
    expect(own.body.message).toMatch(/you proposed/);

    await as('admin').post(`/attendance/corrections/${correction.id}/reject`, {}).expect(400);
    const rejected = await as('admin')
      .post(`/attendance/corrections/${correction.id}/reject`, { reason: 'Needs badge logs' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', reviewComment: 'Needs badge logs' });

    const farhan = await prisma.attendanceRecord.findFirstOrThrow({
      where: { employeeId: people.farhan.id, date: new Date('2026-09-23T00:00:00Z') },
    });
    expect(farhan.source).toBe('SYSTEM'); // rejected: nothing applied
  });
});

/**
 * Leave workflow against the real database (run `pnpm db:up && pnpm db:seed` first).
 * Uses 2027 dates so it doesn't collide with seeded 2026 requests; removes what it creates.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  Employee,
  LeaveBalance,
  LeavePreview,
  LeaveRequest,
  LoginResponse,
  Paginated,
} from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const PASSWORD = 'Password123!';

describe('Leave (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens: Record<'hr' | 'manager' | 'employee', string> = { hr: '', manager: '', employee: '' };
  const me: Record<keyof typeof tokens, LoginResponse['user'] | undefined> = { hr: undefined, manager: undefined, employee: undefined };
  const created: string[] = [];
  let rohan: Employee;

  const as = (who: keyof typeof tokens) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens[who]}`),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Bind to loopback explicitly: an ephemeral port on :: can collide with another
    // process listening on 127.0.0.1, sending requests to the wrong server.
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);

    for (const [who, email] of [
      ['hr', 'hr@hr.local'],
      ['manager', 'manager@hr.local'],
      ['employee', 'employee@hr.local'],
    ] as const) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      tokens[who] = (res.body as LoginResponse).accessToken;
      me[who] = (res.body as LoginResponse).user;
    }
    const found = await as('hr').get('/employees?q=rohan').expect(200);
    rohan = (found.body as Paginated<Employee>).items[0];
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: created } } });
    await prisma.leaveRequest.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  const track = (res: request.Response) => {
    created.push((res.body as LeaveRequest).id);
    return res.body as LeaveRequest;
  };

  it('previews working days, excluding weekends and holidays', async () => {
    // Fri 1 Oct 2027 → Mon 4 Oct 2027; Sat 2 Oct is also Gandhi Jayanti.
    const res = await as('employee')
      .post('/leave-requests/preview', { type: 'CASUAL', startDate: '2027-10-01', endDate: '2027-10-04' })
      .expect(200);
    const preview = res.body as LeavePreview;
    expect(preview.workingDays).toBe(2);
    expect(preview.problems).toEqual([]);
    expect(preview.balanceAfter).toBe(4);
  });

  it('explains why a request is refused (insufficient balance)', async () => {
    const res = await as('employee')
      .post('/leave-requests', { type: 'ANNUAL', startDate: '2027-02-01', endDate: '2027-02-26' })
      .expect(422);
    expect(res.body.problems).toEqual([
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
    ]);
    expect(res.body.message).toBe('Needs 20 working days of annual leave but only 18 are available in 2027.');
  });

  it('lets an employee request leave for themselves only', async () => {
    const res = await as('employee')
      .post('/leave-requests', { type: 'CASUAL', startDate: '2027-03-01', endDate: '2027-03-02', reason: 'Exam' })
      .expect(201);
    const leave = track(res);
    expect(leave).toMatchObject({ status: 'PENDING', days: 2, canCancel: true, canDecide: false });

    await as('employee')
      .post('/leave-requests', { employeeId: rohan.id, type: 'CASUAL', startDate: '2027-03-03', endDate: '2027-03-03' })
      .expect(403);
  });

  it('refuses an overlapping request', async () => {
    const res = await as('employee')
      .post('/leave-requests', { type: 'SICK', startDate: '2027-03-02', endDate: '2027-03-02' })
      .expect(422);
    expect(res.body.problems[0].code).toBe('OVERLAP');
  });

  it("hides other people's leave from an employee", async () => {
    const list = await as('employee').get('/leave-requests?pageSize=100').expect(200);
    const employeeIds = new Set((list.body as Paginated<LeaveRequest>).items.map((l) => l.employee.id));
    expect([...employeeIds]).toEqual([me.employee!.employeeId]);

    await as('employee').get(`/employees/${rohan.id}/leave-balances`).expect(404);
  });

  it("shows a manager only their reports' pending requests to approve", async () => {
    const res = await as('manager').get('/leave-requests?view=approvals&pageSize=100').expect(200);
    const items = (res.body as Paginated<LeaveRequest>).items;
    const names = new Set(items.map((l) => l.employee.firstName));
    expect(names.has('Sneha')).toBe(true);
    expect(names.has('Rohan')).toBe(true);
    expect(names.has('Rahul')).toBe(false); // own request
    expect(names.has('Neha')).toBe(false); // not a direct report
    expect(items.every((l) => l.status === 'PENDING' && l.canDecide)).toBe(true);
  });

  it('lets the manager approve, and the balance reflects it', async () => {
    const pending = created[0];
    const res = await as('manager').post(`/leave-requests/${pending}/approve`, { comment: 'Good luck!' }).expect(200);
    expect(res.body).toMatchObject({ status: 'APPROVED', decidedBy: { name: 'Rahul Sharma' }, decisionComment: 'Good luck!' });

    await as('manager').post(`/leave-requests/${pending}/approve`).expect(409);

    const balances = await as('employee').get(`/employees/${me.employee!.employeeId}/leave-balances?year=2027`).expect(200);
    const casual = (balances.body as LeaveBalance[]).find((b) => b.type === 'CASUAL')!;
    expect(casual).toMatchObject({ entitled: 6, used: 2, pending: 0, available: 4 });
  });

  it("stops a manager deciding their own leave or someone else's team", async () => {
    // HR files leave on Rahul's behalf (leave:manage).
    const res = await as('hr')
      .post('/leave-requests', { employeeId: me.manager!.employeeId, type: 'SICK', startDate: '2027-04-05', endDate: '2027-04-05' })
      .expect(201);
    const rahulLeave = track(res);

    const own = await as('manager').post(`/leave-requests/${rahulLeave.id}/approve`).expect(403);
    expect(own.body.message).toMatch(/own leave/);

    const neha = await prisma.leaveRequest.findFirstOrThrow({ where: { employee: { firstName: 'Neha' } } });
    await as('manager').post(`/leave-requests/${neha.id}/approve`).expect(404);

    await as('hr').post(`/leave-requests/${rahulLeave.id}/reject`, {}).expect(400);
    const rejected = await as('hr')
      .post(`/leave-requests/${rahulLeave.id}/reject`, { reason: 'Clash with quarterly planning' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decisionComment: 'Clash with quarterly planning' });
  });

  it('lets the employee cancel approved future leave, with an audit trail', async () => {
    const approved = created[0];
    const res = await as('employee').post(`/leave-requests/${approved}/cancel`).expect(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', canCancel: false });

    const audit = await as('hr').get(`/audit-logs?entityType=LeaveRequest&entityId=${approved}`).expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual([
      'leave.cancelled',
      'leave.approved',
      'leave.requested',
    ]);
  });

  it('serves the holiday calendar', async () => {
    const res = await as('employee').get('/holidays?year=2026').expect(200);
    expect(res.body).toContainEqual({ date: '2026-10-02', name: 'Gandhi Jayanti' });
  });
});

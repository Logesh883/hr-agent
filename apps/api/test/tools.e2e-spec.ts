/**
 * T3.7: the Tool API's contract. Valid input runs and answers with the tool's output
 * schema; invalid input is refused with the schema's issues; a role without the tool's
 * permission is refused; and changes are audited with the tool's name (AI with a run id).
 * Creates its own records and removes them afterwards.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  TOOLS,
  TOOL_NAMES,
  type AuditLogEntry,
  type Department,
  type Employee,
  type LeavePreview,
  type LeaveRequest,
  type LoginResponse,
  type Paginated,
  type ToolCatalogEntry,
} from '@hr/contracts';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const PASSWORD = 'Password123!';

describe('Tool API (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens: Record<'hr' | 'manager' | 'employee', string> = {
    hr: '',
    manager: '',
    employee: '',
  };
  const userIds: string[] = [];
  let engineering: Department;
  const createdEmails: string[] = [];
  const createdLeave: string[] = [];

  const api = () => request(app.getHttpServer());
  const as = (who: keyof typeof tokens, req: request.Test) =>
    req.set('Authorization', `Bearer ${tokens[who]}`);
  const tool = (who: keyof typeof tokens, name: string, body: unknown) =>
    as(who, api().post(`/tools/${name}`)).send(body as object);

  function newHire(suffix: string) {
    const email = `tool.${suffix}.${Date.now()}@acme.example`;
    createdEmails.push(email);
    return {
      firstName: 'Tool',
      lastName: `Test-${suffix}`,
      email,
      jobTitle: 'Software Engineer',
      departmentId: engineering.id,
      location: 'Bangalore',
      joiningDate: '2026-10-12',
      employmentType: 'FULL_TIME',
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    for (const who of Object.keys(tokens) as (keyof typeof tokens)[]) {
      const login = await api()
        .post('/auth/login')
        .send({ email: `${who}@hr.local`, password: PASSWORD })
        .expect(200);
      tokens[who] = (login.body as LoginResponse).accessToken;
      userIds.push((login.body as LoginResponse).user.id);
    }
    const depts = await as('hr', api().get('/departments')).expect(200);
    engineering = (depts.body as Department[]).find((d) => d.code === 'ENG')!;
  });

  afterAll(async () => {
    const employees = await prisma.employee.findMany({
      where: { email: { in: createdEmails } },
    });
    const ids = employees.map((e) => e.id);
    const tasks = await prisma.onboardingTask.findMany({
      where: { employeeId: { in: ids } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entityId: { in: [...ids, ...tasks.map((t) => t.id), ...createdLeave] },
      },
    });
    await prisma.leaveRequest.deleteMany({
      where: { id: { in: createdLeave } },
    });
    await prisma.onboardingTask.deleteMany({
      where: { employeeId: { in: ids } },
    });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({
      where: { userId: { in: userIds } },
    });
    await app.close();
  });

  it('lists every tool with JSON Schemas and what the caller may use', async () => {
    const hr = (await as('hr', api().get('/tools')).expect(200))
      .body as ToolCatalogEntry[];
    expect(hr.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(hr.every((t) => t.allowed)).toBe(true);
    const create = hr.find((t) => t.name === 'create_employee')!;
    expect(create.risk).toBe('medium');
    expect(create.input).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['email']),
    });
    expect(hr.find((t) => t.name === 'search_employee')!.risk).toBeNull();

    const employee = (await as('employee', api().get('/tools')).expect(200))
      .body as ToolCatalogEntry[];
    const allowed = employee.filter((t) => t.allowed).map((t) => t.name);
    expect(allowed).toEqual([
      'update_onboarding_task',
      'create_leave_request',
      'cancel_leave',
      'read_attendance',
    ]);
  });

  it('refuses anonymous callers and unknown tools', async () => {
    await api().post('/tools/search_employee').send({}).expect(401);
    const res = await tool('hr', 'drop_database', {}).expect(404);
    expect(res.body.message).toMatch(/Unknown tool/);
  });

  it.each(TOOL_NAMES.filter((n) => TOOLS[n].kind === 'write'))(
    '%s: refuses invalid input with the schema issues',
    async (name) => {
      const res = await tool('hr', name, { employeeId: 'not-a-uuid' }).expect(
        400,
      );
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.issues.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ['employee', 'create_employee'],
    ['employee', 'approve_leave'],
    ['employee', 'search_employee'],
    ['manager', 'change_manager'],
    ['manager', 'apply_attendance_correction'],
  ] as const)('a %s may not call %s (403)', async (who, name) => {
    const res = await tool(who, name, {}).expect(403);
    expect(res.body.message).toMatch(/lacks permission/);
  });

  it('runs reads and answers with the output schema', async () => {
    const found = await tool('hr', 'search_employee', { q: 'Rahul' }).expect(
      200,
    );
    const page = TOOLS.search_employee.output.parse(found.body);
    expect(page.items.length).toBeGreaterThan(0);

    const month = await tool('hr', 'read_attendance', {
      month: '2026-09',
    }).expect(200);
    TOOLS.read_attendance.output.parse(month.body);
  });

  it('creates, changes and onboards through tools, audited as AI with the tool name', async () => {
    const runId = randomUUID();
    const created = await tool('hr', 'create_employee', newHire('flow'))
      .set('X-Agent-Run-Id', runId)
      .set('Idempotency-Key', `${runId}:s1`)
      .expect(200);
    const hire = TOOLS.create_employee.output.parse(created.body) as Employee;

    // A retry with the same key replays instead of creating twice.
    const again = await tool('hr', 'create_employee', newHire('flow'))
      .set('Idempotency-Key', `${runId}:s1`)
      .expect(422); // a different email: a different request under the same key
    expect(again.body.message).toMatch(/different request/);

    const rahul = TOOLS.search_employee.output.parse(
      (await tool('hr', 'search_employee', { q: 'Rahul' })).body,
    ).items[0];
    const moved = await tool('hr', 'change_manager', {
      employeeId: hire.id,
      managerId: rahul.id,
      version: hire.version,
    })
      .set('X-Agent-Run-Id', runId)
      .expect(200);
    const updated = TOOLS.change_manager.output.parse(moved.body) as Employee;
    expect(updated.manager?.id).toBe(rahul.id);

    // Optimistic locking: the old version is refused.
    await tool('hr', 'update_employee', {
      employeeId: hire.id,
      version: hire.version,
      jobTitle: 'Senior Software Engineer',
    }).expect(409);

    const started = await tool('hr', 'start_onboarding', {
      employeeId: hire.id,
    })
      .set('X-Agent-Run-Id', runId)
      .expect(200);
    const onboarding = TOOLS.start_onboarding.output.parse(started.body);
    const task = onboarding.tasks[0];
    const done = await tool('hr', 'update_onboarding_task', {
      taskId: task.id,
      notes: 'Done by the agent',
    }).expect(200);
    expect(TOOLS.update_onboarding_task.output.parse(done.body).notes).toBe(
      'Done by the agent',
    );

    const audit = await as(
      'hr',
      api()
        .get('/audit-logs')
        .query({ entityType: 'Employee', entityId: hire.id }),
    ).expect(200);
    const entries = (audit.body as Paginated<AuditLogEntry>).items;
    expect(
      entries.map((e) => [e.action, e.actorType, e.toolName, e.agentRunId]),
    ).toEqual(
      expect.arrayContaining([
        ['employee.created', 'AI', 'create_employee', runId],
        ['employee.updated', 'AI', 'change_manager', runId],
      ]),
    );
  });

  it('requests leave as an employee and approves it as HR', async () => {
    // The next weekday the rules accept (no holiday, balance available).
    let body:
      { type: 'CASUAL'; startDate: string; endDate: string } | undefined;
    const day = new Date(Date.UTC(2026, 10, 2));
    for (
      let i = 0;
      i < 30 && !body;
      i++, day.setUTCDate(day.getUTCDate() + 1)
    ) {
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const date = day.toISOString().slice(0, 10);
      const candidate = {
        type: 'CASUAL' as const,
        startDate: date,
        endDate: date,
      };
      const preview = await as(
        'employee',
        api().post('/leave-requests/preview'),
      )
        .send(candidate)
        .expect(200);
      if ((preview.body as LeavePreview).problems.length === 0)
        body = candidate;
    }
    expect(body).toBeDefined();

    const created = await tool('employee', 'create_leave_request', body).expect(
      200,
    );
    const leave = TOOLS.create_leave_request.output.parse(
      created.body,
    ) as LeaveRequest;
    createdLeave.push(leave.id);
    expect(leave.status).toBe('PENDING');

    const approved = await tool('hr', 'approve_leave', {
      leaveRequestId: leave.id,
      comment: 'Enjoy',
    }).expect(200);
    expect(TOOLS.approve_leave.output.parse(approved.body).status).toBe(
      'APPROVED',
    );
  });
});

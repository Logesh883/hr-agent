/**
 * A6.1: what the AI agent needs from the API. Audit entries marked AI with the agent run
 * id, and Idempotency-Key on writes (replay, mismatch, concurrent duplicates).
 * Creates its own employees and removes them (and their audit rows) afterwards.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  AuditLogEntry,
  Department,
  Employee,
  LoginResponse,
  Paginated,
} from '@hr/contracts';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const PASSWORD = 'Password123!';

describe('AI agent support (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let userId: string;
  let engineering: Department;
  const createdEmails: string[] = [];

  const api = () => request(app.getHttpServer());
  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  function newHire(suffix: string) {
    const email = `agent.${suffix}.${Date.now()}@acme.example`;
    createdEmails.push(email);
    return {
      firstName: 'Agent',
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
    const login = await api()
      .post('/auth/login')
      .send({ email: 'hr@hr.local', password: PASSWORD })
      .expect(200);
    token = (login.body as LoginResponse).accessToken;
    userId = (login.body as LoginResponse).user.id;
    const depts = await auth(api().get('/departments')).expect(200);
    engineering = (depts.body as Department[]).find((d) => d.code === 'ENG')!;
  });

  afterAll(async () => {
    const employees = await prisma.employee.findMany({
      where: { email: { in: createdEmails } },
    });
    const ids = employees.map((e) => e.id);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { userId } });
    await app.close();
  });

  it('marks changes made through the agent as AI, with the run id', async () => {
    const runId = randomUUID();
    const res = await auth(api().post('/employees'))
      .set('X-Agent-Run-Id', runId)
      .send(newHire('audit'))
      .expect(201);
    const employee = res.body as Employee;

    const audit = await auth(
      api()
        .get('/audit-logs')
        .query({ entityType: 'Employee', entityId: employee.id }),
    ).expect(200);
    const [entry] = (audit.body as Paginated<AuditLogEntry>).items;
    expect(entry.actorType).toBe('AI');
    expect(entry.agentRunId).toBe(runId);
    // Still attributed to the user the agent acted for.
    expect(entry.actorId).toBe(userId);
  });

  it('records a plain user change as USER', async () => {
    const res = await auth(api().post('/employees'))
      .send(newHire('user'))
      .expect(201);
    const audit = await auth(
      api()
        .get('/audit-logs')
        .query({ entityType: 'Employee', entityId: (res.body as Employee).id }),
    ).expect(200);
    const [entry] = (audit.body as Paginated<AuditLogEntry>).items;
    expect(entry.actorType).toBe('USER');
    expect(entry.agentRunId).toBeNull();
  });

  it('replays a retried write instead of acting twice', async () => {
    const key = randomUUID();
    const body = newHire('retry');

    const first = await auth(api().post('/employees'))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await auth(api().post('/employees'))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect((second.body as Employee).id).toBe((first.body as Employee).id);
    expect(await prisma.employee.count({ where: { email: body.email } })).toBe(
      1,
    );
  });

  it('refuses a reused key with a different request', async () => {
    const key = randomUUID();
    await auth(api().post('/employees'))
      .set('Idempotency-Key', key)
      .send(newHire('a'))
      .expect(201);

    const res = await auth(api().post('/employees'))
      .set('Idempotency-Key', key)
      .send(newHire('b'))
      .expect(422);
    expect(res.body.message).toMatch(/different request/);
  });

  it('lets only one of two simultaneous identical requests act', async () => {
    const key = randomUUID();
    const body = newHire('race');

    const responses = await Promise.all([
      auth(api().post('/employees')).set('Idempotency-Key', key).send(body),
      auth(api().post('/employees')).set('Idempotency-Key', key).send(body),
    ]);

    // One creates (201); the other either sees it in progress (409) or replays it (201).
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect([
      [201, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    expect(await prisma.employee.count({ where: { email: body.email } })).toBe(
      1,
    );
  });

  it('stores a refusal (4xx) as final, so a retry gets the same answer', async () => {
    const key = randomUUID();
    const bad = { ...newHire('bad'), departmentId: 'not-a-uuid' };

    await auth(api().post('/employees'))
      .set('Idempotency-Key', key)
      .send(bad)
      .expect(400);
    const retry = await auth(api().post('/employees'))
      .set('Idempotency-Key', key)
      .send(bad)
      .expect(400);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });
});

/**
 * Employee lifecycle against the real database (run `pnpm db:up && pnpm db:seed` first).
 * Creates its own employee and removes it (and its audit rows) afterwards.
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
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const PASSWORD = 'Password123!';

describe('Employees (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let engineering: Department;
  let created: Employee | undefined;

  const api = () => request(app.getHttpServer());
  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const login = await api()
      .post('/auth/login')
      .send({ email: 'hr@hr.local', password: PASSWORD })
      .expect(200);
    token = (login.body as LoginResponse).accessToken;

    const depts = await auth(api().get('/departments')).expect(200);
    engineering = (depts.body as Department[]).find((d) => d.code === 'ENG')!;
  });

  afterAll(async () => {
    if (created) {
      await prisma.auditLog.deleteMany({ where: { entityId: created.id } });
      await prisma.employee.delete({ where: { id: created.id } });
    }
    await app.close();
  });

  it('rejects a wrong password', async () => {
    await api()
      .post('/auth/login')
      .send({ email: 'hr@hr.local', password: 'wrong' })
      .expect(401);
  });

  it('returns validation issues for a bad create request', async () => {
    const res = await auth(api().post('/employees'))
      .send({ firstName: '', email: 'not-an-email' })
      .expect(400);
    const paths = (res.body.issues as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['firstName', 'email', 'departmentId']));
  });

  it('creates an employee with a generated code and audit entry', async () => {
    const res = await auth(api().post('/employees'))
      .send({
        firstName: 'Test',
        lastName: `Hire-${Date.now()}`,
        email: `test.hire.${Date.now()}@acme.example`,
        jobTitle: 'Software Engineer',
        departmentId: engineering.id,
        managerId: engineering.manager!.id,
        location: 'Bangalore',
        joiningDate: '2026-10-12',
        employmentType: 'FULL_TIME',
      })
      .expect(201);
    created = res.body as Employee;

    expect(created.employeeCode).toMatch(/^EMP-\d{4}$/);
    expect(created).toMatchObject({
      status: 'PROBATION',
      version: 1,
      joiningDate: '2026-10-12',
      department: { id: engineering.id },
      manager: { id: engineering.manager!.id },
    });
  });

  it('rejects a duplicate email', async () => {
    const res = await auth(api().post('/employees'))
      .send({
        firstName: 'Dup',
        lastName: 'Licate',
        email: created!.email,
        jobTitle: 'Engineer',
        departmentId: engineering.id,
        location: 'Bangalore',
        joiningDate: '2026-10-12',
        employmentType: 'FULL_TIME',
      })
      .expect(409);
    expect(res.body.message).toContain(created!.employeeCode);
  });

  it('finds the employee by search terms', async () => {
    const res = await auth(
      api().get('/employees').query({ q: `test ${created!.lastName}` }),
    ).expect(200);
    const page = res.body as Paginated<Employee>;
    expect(page.items.map((e) => e.id)).toEqual([created!.id]);
  });

  it('updates with the current version and bumps it', async () => {
    const res = await auth(api().patch(`/employees/${created!.id}`))
      .send({ jobTitle: 'Senior Software Engineer', status: 'ACTIVE', version: 1 })
      .expect(200);
    expect(res.body).toMatchObject({
      jobTitle: 'Senior Software Engineer',
      status: 'ACTIVE',
      version: 2,
    });
  });

  it('rejects an update with a stale version (optimistic locking)', async () => {
    const res = await auth(api().patch(`/employees/${created!.id}`))
      .send({ jobTitle: 'Principal Engineer', version: 1 })
      .expect(409);
    expect(res.body.message).toMatch(/changed by someone else/);
  });

  it('prevents a reporting cycle', async () => {
    // The new hire reports to the Engineering manager, so the manager can't report to them.
    const version = await versionOf(engineering.manager!.id);
    const res = await auth(api().patch(`/employees/${engineering.manager!.id}`))
      .send({ managerId: created!.id, version })
      .expect(400);
    expect(res.body.message).toMatch(/reporting cycle/);
  });

  it('blocks archiving a manager with active reports', async () => {
    const version = await versionOf(engineering.manager!.id);
    const res = await auth(api().post(`/employees/${engineering.manager!.id}/archive`))
      .send({ version })
      .expect(409);
    expect(res.body.message).toMatch(/direct report/);
  });

  it('archives, blocks edits while archived, and reactivates', async () => {
    await auth(api().post(`/employees/${created!.id}/archive`))
      .send({ version: 2, reason: 'Test cleanup' })
      .expect(200);

    await auth(api().patch(`/employees/${created!.id}`))
      .send({ jobTitle: 'Nope', version: 3 })
      .expect(409);

    const listed = await auth(api().get('/employees').query({ q: created!.lastName })).expect(200);
    expect((listed.body as Paginated<Employee>).total).toBe(0);

    const res = await auth(api().post(`/employees/${created!.id}/reactivate`))
      .send({ version: 3 })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ACTIVE', version: 4 });
  });

  it('records every change in the audit log with only changed fields', async () => {
    const res = await auth(
      api().get('/audit-logs').query({ entityType: 'Employee', entityId: created!.id }),
    ).expect(200);
    const entries = (res.body as Paginated<AuditLogEntry>).items;

    expect(entries.map((e) => e.action)).toEqual([
      'employee.reactivated',
      'employee.archived',
      'employee.updated',
      'employee.created',
    ]);
    expect(entries.every((e) => e.actorType === 'USER' && e.actorName === 'Lakshmi Pillai')).toBe(true);
    expect(entries[2]).toMatchObject({
      before: { jobTitle: 'Software Engineer', status: 'PROBATION' },
      after: { jobTitle: 'Senior Software Engineer', status: 'ACTIVE' },
    });
    expect(Object.keys(entries[2].after!)).toHaveLength(2);
  });

  async function versionOf(id: string) {
    const res = await auth(api().get(`/employees/${id}`)).expect(200);
    return (res.body as Employee).version;
  }
});

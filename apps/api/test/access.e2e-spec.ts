/**
 * App access lifecycle against the real database (run `pnpm db:up && pnpm db:seed` first).
 * Creates a throwaway hire and removes it, its login and their audit rows.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  Department,
  Employee,
  EmployeeAccess,
  LoginResponse,
  Paginated,
  TemporaryPasswordResponse,
} from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'Brand-new-passw0rd';
// Tokens carry second-resolution issue times; wait so "older than the password change" is unambiguous.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

describe('App access (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = { admin: '', hr: '' };
  let hrEmployeeId: string;
  let hire: Employee;
  let temporaryPassword: string;
  let hireToken: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (email: string, password: string) => http().post('/auth/login').send({ email, password });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Bind to loopback explicitly (see employees.e2e-spec.ts).
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);

    tokens.admin = ((await login('admin@hr.local', PASSWORD)).body as LoginResponse).accessToken;
    const hr = (await login('hr@hr.local', PASSWORD)).body as LoginResponse;
    tokens.hr = hr.accessToken;
    hrEmployeeId = hr.user.employeeId!;

    const depts = await http().get('/departments').set(bearer(tokens.hr)).expect(200);
    const engineering = (depts.body as Department[]).find((d) => d.code === 'ENG')!;
    const stamp = Date.now();
    const res = await http()
      .post('/employees')
      .set(bearer(tokens.hr))
      .send({
        firstName: 'Access',
        lastName: `Test-${stamp}`,
        email: `test.hire.access.${stamp}@acme.example`,
        jobTitle: 'Analyst',
        departmentId: engineering.id,
        location: 'Bangalore',
        joiningDate: '2026-10-12',
        employmentType: 'FULL_TIME',
      })
      .expect(201);
    hire = res.body as Employee;
  });

  afterAll(async () => {
    const user = await prisma.user.findUnique({ where: { employeeId: hire.id } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [hire.id, ...(user ? [user.id] : [])] } } });
    if (user) await prisma.user.delete({ where: { id: user.id } });
    await prisma.employee.delete({ where: { id: hire.id } });
    await app.close();
  });

  const access = (token = tokens.hr) => http().get(`/employees/${hire.id}/access`).set(bearer(token));
  const grant = (role: string, token = tokens.hr) =>
    http().post(`/employees/${hire.id}/access`).set(bearer(token)).send({ role });
  const update = (body: object, token = tokens.hr) =>
    http().patch(`/employees/${hire.id}/access`).set(bearer(token)).send(body);
  const reset = (token = tokens.hr) => http().post(`/employees/${hire.id}/access/reset-password`).set(bearer(token));

  it('starts without a login, and HR can grant up to HR Operations', async () => {
    const res = await access().expect(200);
    expect(res.body).toMatchObject({
      hasAccess: false,
      email: hire.email,
      canManage: true,
      grantableRoles: ['EMPLOYEE', 'MANAGER', 'HR_OPS'],
    });
    const admin = await grant('ADMIN').expect(403);
    expect(admin.body.message).toBe('Only an admin can grant the Admin role.');
  });

  it('grants a login with a one-time temporary password', async () => {
    const res = await grant('EMPLOYEE').expect(201);
    ({ temporaryPassword } = res.body as TemporaryPasswordResponse);
    expect(temporaryPassword).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}$/);
    expect((res.body as TemporaryPasswordResponse).access).toMatchObject({
      hasAccess: true,
      role: 'EMPLOYEE',
      isActive: true,
      mustChangePassword: true,
    });
    await grant('EMPLOYEE').expect(409);

    const stored = await prisma.user.findUniqueOrThrow({ where: { employeeId: hire.id } });
    expect(stored.passwordHash).not.toContain(temporaryPassword);
  });

  it('blocks everything but changing the password until the temporary one is replaced', async () => {
    const res = await login(hire.email, temporaryPassword).expect(200);
    hireToken = (res.body as LoginResponse).accessToken;
    expect((res.body as LoginResponse).user).toMatchObject({ role: 'EMPLOYEE', mustChangePassword: true });

    const blocked = await http().get('/leave-requests').set(bearer(hireToken)).expect(403);
    expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    await http().get('/auth/me').set(bearer(hireToken)).expect(200);

    const wrong = await http()
      .post('/auth/change-password')
      .set(bearer(hireToken))
      .send({ currentPassword: 'nope', newPassword: NEW_PASSWORD })
      .expect(400);
    expect(wrong.body.message).toBe('Your current password is incorrect.');
    const weak = await http()
      .post('/auth/change-password')
      .set(bearer(hireToken))
      .send({ currentPassword: temporaryPassword, newPassword: 'short1' })
      .expect(400);
    expect(weak.body.issues[0]).toMatchObject({ path: 'newPassword' });
  });

  it('replaces the temporary password, ending the old session', async () => {
    await nextSecond();
    const res = await http()
      .post('/auth/change-password')
      .set(bearer(hireToken))
      .send({ currentPassword: temporaryPassword, newPassword: NEW_PASSWORD })
      .expect(200);
    const fresh = res.body as LoginResponse;
    expect(fresh.user.mustChangePassword).toBe(false);

    await http().get('/auth/me').set(bearer(hireToken)).expect(401);
    await http().get('/leave-requests').set(bearer(fresh.accessToken)).expect(200);
    await login(hire.email, temporaryPassword).expect(401);
    hireToken = (await login(hire.email, NEW_PASSWORD).expect(200)).body.accessToken;
  });

  it('resets a password: old password and sessions stop working', async () => {
    await nextSecond();
    const res = await reset().expect(200);
    const next = (res.body as TemporaryPasswordResponse).temporaryPassword;
    expect(next).not.toBe(temporaryPassword);

    await http().get('/auth/me').set(bearer(hireToken)).expect(401);
    await login(hire.email, NEW_PASSWORD).expect(401);
    const again = await login(hire.email, next).expect(200);
    expect((again.body as LoginResponse).user.mustChangePassword).toBe(true);
    temporaryPassword = next;
  });

  it('keeps admin logins for admins only', async () => {
    await update({ role: 'ADMIN' }).expect(403);
    await update({ role: 'ADMIN' }, tokens.admin).expect(200);

    const hrView = await access().expect(200);
    expect((hrView.body as EmployeeAccess).canManage).toBe(false);
    await reset().expect(403);
    await update({ isActive: false }).expect(403);

    await update({ role: 'EMPLOYEE' }, tokens.admin).expect(200);
  });

  it("doesn't let anyone change their own access", async () => {
    const res = await http()
      .patch(`/employees/${hrEmployeeId}/access`)
      .set(bearer(tokens.hr))
      .send({ isActive: false })
      .expect(403);
    expect(res.body.message).toMatch(/your own access/);
  });

  it('turns access off and on immediately', async () => {
    await update({ isActive: false }).expect(200);
    await login(hire.email, temporaryPassword).expect(401);
    await update({ isActive: true }).expect(200);
    await login(hire.email, temporaryPassword).expect(200);
  });

  it('moves the login email with the work email', async () => {
    const newEmail = hire.email.replace('test.hire.access', 'test.hire.renamed');
    const current = await http().get(`/employees/${hire.id}`).set(bearer(tokens.hr)).expect(200);
    await http()
      .patch(`/employees/${hire.id}`)
      .set(bearer(tokens.hr))
      .send({ email: newEmail, version: (current.body as Employee).version })
      .expect(200);

    await login(hire.email, temporaryPassword).expect(401);
    await login(newEmail, temporaryPassword).expect(200);
    hire = { ...hire, email: newEmail };

    // A login email can't be taken by another employee.
    const other = await http().get('/employees?q=arun').set(bearer(tokens.hr)).expect(200);
    const arun = (other.body as Paginated<Employee>).items[0];
    await http()
      .patch(`/employees/${arun.id}`)
      .set(bearer(tokens.hr))
      .send({ email: 'hr@hr.local', version: arun.version })
      .expect(409);
  });

  it('turns the login off when the employee is archived', async () => {
    const current = await http().get(`/employees/${hire.id}`).set(bearer(tokens.hr)).expect(200);
    const archived = await http()
      .post(`/employees/${hire.id}/archive`)
      .set(bearer(tokens.hr))
      .send({ version: (current.body as Employee).version, reason: 'Test' })
      .expect(200);
    expect((archived.body as Employee).status).toBe('ARCHIVED');

    await login(hire.email, temporaryPassword).expect(401);
    expect((await access().expect(200)).body).toMatchObject({ hasAccess: true, isActive: false });
    await update({ isActive: true }).expect(400);

    const audit = await http()
      .get(`/audit-logs?entityType=Employee&entityId=${hire.id}&pageSize=50`)
      .set(bearer(tokens.hr))
      .expect(200);
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['access.granted', 'access.temporary_password_replaced', 'access.password_reset', 'access.updated']),
    );
    expect(JSON.stringify(audit.body)).not.toContain(temporaryPassword);
  });
});

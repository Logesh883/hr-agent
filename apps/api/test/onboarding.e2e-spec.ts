/**
 * Onboarding lifecycle against the real database (run `pnpm db:up && pnpm db:seed` first).
 * Creates a throwaway new hire and removes everything it creates.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  Department,
  Employee,
  EmployeeDocument,
  EmployeeOnboarding,
  LoginResponse,
  OnboardingSummary,
  OnboardingTask,
  Paginated,
} from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';

const PASSWORD = 'Password123!';

describe('Onboarding (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = { hr: '', manager: '', employee: '' };
  let hire: Employee;
  let onboarding: EmployeeOnboarding;

  const as = (who: keyof typeof tokens) => {
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${tokens[who]}`);
    return {
      get: (path: string) => auth(request(app.getHttpServer()).get(path)),
      post: (path: string, body: object = {}) => auth(request(app.getHttpServer()).post(path)).send(body),
      patch: (path: string, body: object) => auth(request(app.getHttpServer()).patch(path)).send(body),
    };
  };
  const task = (title: RegExp) => onboarding.tasks.find((t) => title.test(t.title))!;

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
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
      tokens[who] = (res.body as LoginResponse).accessToken;
    }

    const depts = await as('hr').get('/departments').expect(200);
    const engineering = (depts.body as Department[]).find((d) => d.code === 'ENG')!;
    const created = await as('hr')
      .post('/employees', {
        firstName: 'Onboard',
        lastName: `Test-${Date.now()}`,
        email: `onboard.test.${Date.now()}@acme.example`,
        jobTitle: 'Software Engineer',
        departmentId: engineering.id,
        managerId: engineering.manager!.id,
        location: 'Bangalore',
        joiningDate: '2026-10-12',
        employmentType: 'FULL_TIME',
      })
      .expect(201);
    hire = created.body as Employee;
  });

  afterAll(async () => {
    const tasks = await prisma.onboardingTask.findMany({ where: { employeeId: hire.id }, select: { id: true } });
    const docs = await prisma.document.findMany({ where: { employeeId: hire.id } });
    const storage = app.get(StorageService);
    await Promise.all(docs.map((d) => storage.delete(d.storageKey)));
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: [hire.id, ...tasks.map((t) => t.id), ...docs.map((d) => d.id)] } },
    });
    await prisma.onboardingTask.deleteMany({ where: { employeeId: hire.id } });
    await prisma.document.deleteMany({ where: { employeeId: hire.id } });
    await prisma.employee.delete({ where: { id: hire.id } });
    await app.close();
  });

  it('reports missing information before onboarding starts', async () => {
    const res = await as('hr').get(`/employees/${hire.id}/onboarding`).expect(200);
    onboarding = res.body as EmployeeOnboarding;
    expect(onboarding).toMatchObject({ started: false, canStart: true, tasks: [] });
    expect(onboarding.missingInfo.map((m) => m.message)).toEqual([
      'Phone number is missing.',
      'Date of birth is missing.',
      'Offer letter not uploaded.',
      'ID proof not uploaded.',
      'PAN card not uploaded.',
      'Bank details not uploaded.',
    ]);
  });

  it('builds the checklist from company and department templates', async () => {
    const res = await as('hr').post(`/employees/${hire.id}/onboarding`).expect(201);
    onboarding = res.body as EmployeeOnboarding;
    expect(onboarding.started).toBe(true);
    expect(onboarding.progress).toMatchObject({ total: 13, done: 0, percent: 0 });
    expect(task(/GitHub/).dueDate).toBe('2026-10-12');
    expect(task(/offer letter/).dueDate).toBe('2026-09-28'); // 14 days before joining
    expect(task(/offer letter/).isOverdue).toBe(true);
    expect(onboarding.tasks.some((t) => /CRM/.test(t.title))).toBe(false); // Sales only

    await as('hr').post(`/employees/${hire.id}/onboarding`).expect(409);
  });

  it("lets the manager tick off their own tasks, and nothing else", async () => {
    const welcome = task(/welcome message/);
    const res = await as('manager').patch(`/onboarding/tasks/${welcome.id}`, { status: 'DONE' }).expect(200);
    expect(res.body).toMatchObject({ status: 'DONE', completedBy: { name: 'Rahul Sharma' } });

    await as('manager').patch(`/onboarding/tasks/${task(/HR orientation/).id}`, { status: 'DONE' }).expect(403);
    await as('manager')
      .patch(`/onboarding/tasks/${task(/buddy/).id}`, { status: 'SKIPPED', notes: 'n/a' })
      .expect(403);
  });

  it('hides the new hire from other employees', async () => {
    await as('employee').get(`/employees/${hire.id}/onboarding`).expect(404);
    await as('employee').patch(`/onboarding/tasks/${task(/buddy/).id}`, { status: 'DONE' }).expect(404);
  });

  it('completes document tasks only through verification', async () => {
    const idTask = task(/ID proof/);
    const manual = await as('hr').patch(`/onboarding/tasks/${idTask.id}`, { status: 'DONE' }).expect(400);
    expect(manual.body.message).toBe('This task completes automatically when the ID proof is verified.');

    const uploaded = await request(app.getHttpServer())
      .post(`/employees/${hire.id}/documents`)
      .set('Authorization', `Bearer ${tokens.hr}`)
      .field('type', 'ID_PROOF')
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'aadhaar.pdf')
      .expect(201);
    await as('hr').post(`/documents/${(uploaded.body as EmployeeDocument).id}/verify`).expect(200);

    const res = await as('hr').get(`/employees/${hire.id}/onboarding`).expect(200);
    onboarding = res.body as EmployeeOnboarding;
    expect(task(/ID proof/)).toMatchObject({
      status: 'DONE',
      notes: 'Completed automatically when the ID proof was verified.',
    });
    expect(onboarding.missingInfo.map((m) => m.code)).not.toContain('DOC_ID_PROOF');
    expect(onboarding.progress.done).toBe(2);
  });

  it('requires a note to skip, and records every change', async () => {
    const buddy = task(/buddy/);
    await as('hr').patch(`/onboarding/tasks/${buddy.id}`, { status: 'SKIPPED' }).expect(400);
    const res = await as('hr')
      .patch(`/onboarding/tasks/${buddy.id}`, { status: 'SKIPPED', notes: 'Joining a team of two' })
      .expect(200);
    expect((res.body as OnboardingTask).status).toBe('SKIPPED');

    const audit = await as('hr').get(`/audit-logs?entityType=OnboardingTask&entityId=${buddy.id}`).expect(200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'onboarding.task_updated',
      before: { title: 'Assign an onboarding buddy', status: 'PENDING', notes: null },
      after: { status: 'SKIPPED', notes: 'Joining a team of two' },
    });
  });

  it('lists the new hire among active onboardings for HR and their manager', async () => {
    for (const who of ['hr', 'manager'] as const) {
      const res = await as(who).get('/onboarding?state=active&pageSize=100').expect(200);
      const item = (res.body as Paginated<OnboardingSummary>).items.find((s) => s.employee.id === hire.id);
      expect(item?.progress).toMatchObject({ total: 13, done: 2, skipped: 1 });
    }
  });
});

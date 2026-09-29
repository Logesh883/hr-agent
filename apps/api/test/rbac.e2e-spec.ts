/**
 * RBAC matrix (T1.10): every protected endpoint × every role.
 * Services and the database are stubbed; this only exercises routing,
 * the JWT guard, and the permissions guard.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ROLES, type Role } from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { AuditService } from '../src/audit/audit.service.js';
import { DepartmentsService } from '../src/departments/departments.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { EmployeesService } from '../src/employees/employees.service.js';
import { LeaveService } from '../src/leave/leave.service.js';
import { OnboardingService } from '../src/onboarding/onboarding.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const ID = '5f0d7c3e-8a51-4c47-9d2e-1b6a0f3c9e21';
const DEPT = '0b8a4d52-6f1e-4c3a-8e7d-2a9c5b1f4e60';
const LEAVE = '9a3e2f10-4b5c-4d6e-8f70-1a2b3c4d5e6f';
const DOC = '3d7c1b2a-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const HR_ONLY: Role[] = ['ADMIN', 'HR_OPS'];
const TASK = '4e8d2c3b-6f7a-4b9c-8d1e-2f3a4b5c6d7e';
const ALL: Role[] = ['ADMIN', 'HR_OPS', 'MANAGER', 'EMPLOYEE'];
const leaveBody = { type: 'CASUAL', startDate: '2027-03-01', endDate: '2027-03-02' };

const employeeBody = {
  firstName: 'Priya',
  lastName: 'Nair',
  email: 'priya.nair@acme.example',
  jobTitle: 'Software Engineer',
  departmentId: DEPT,
  location: 'Bangalore',
  joiningDate: '2026-10-12',
  employmentType: 'FULL_TIME',
};

type Method = 'get' | 'post' | 'patch';

/** Expected access, written out explicitly rather than derived from the role map. */
const endpoints: {
  method: Method;
  path: string;
  body?: object;
  allowed: Role[];
}[] = [
  { method: 'get', path: '/employees', allowed: ['ADMIN', 'HR_OPS', 'MANAGER'] },
  { method: 'get', path: `/employees/${ID}`, allowed: ['ADMIN', 'HR_OPS', 'MANAGER'] },
  { method: 'post', path: '/employees', body: employeeBody, allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'patch', path: `/employees/${ID}`, body: { jobTitle: 'Staff Engineer', version: 1 }, allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'post', path: `/employees/${ID}/archive`, body: { version: 1 }, allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'post', path: `/employees/${ID}/reactivate`, body: { version: 1 }, allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'get', path: '/departments', allowed: ['ADMIN', 'HR_OPS', 'MANAGER', 'EMPLOYEE'] },
  { method: 'get', path: `/departments/${DEPT}`, allowed: ['ADMIN', 'HR_OPS', 'MANAGER', 'EMPLOYEE'] },
  { method: 'post', path: '/departments', body: { name: 'Finance', code: 'FIN' }, allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'patch', path: `/departments/${DEPT}`, body: { name: 'Finance & Legal' }, allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'get', path: '/audit-logs', allowed: ['ADMIN', 'HR_OPS'] },
  { method: 'get', path: '/auth/me', allowed: ALL },
  { method: 'get', path: '/leave-requests', allowed: ALL },
  { method: 'get', path: `/leave-requests/${LEAVE}`, allowed: ALL },
  { method: 'post', path: '/leave-requests/preview', body: leaveBody, allowed: ALL },
  { method: 'post', path: '/leave-requests', body: leaveBody, allowed: ALL },
  { method: 'post', path: `/leave-requests/${LEAVE}/approve`, body: {}, allowed: ['ADMIN', 'HR_OPS', 'MANAGER'] },
  { method: 'post', path: `/leave-requests/${LEAVE}/reject`, body: { reason: 'Busy' }, allowed: ['ADMIN', 'HR_OPS', 'MANAGER'] },
  { method: 'post', path: `/leave-requests/${LEAVE}/cancel`, allowed: ALL },
  { method: 'get', path: `/employees/${ID}/leave-balances`, allowed: ALL },
  { method: 'get', path: '/holidays', allowed: ALL },
  { method: 'get', path: '/documents', allowed: ALL },
  { method: 'get', path: `/employees/${ID}/documents`, allowed: ALL },
  { method: 'post', path: `/employees/${ID}/documents`, body: { type: 'PAN_CARD' }, allowed: ALL },
  { method: 'get', path: `/documents/${DOC}`, allowed: ALL },
  { method: 'get', path: `/documents/${DOC}/file`, allowed: ALL },
  { method: 'post', path: `/documents/${DOC}/verify`, body: {}, allowed: HR_ONLY },
  { method: 'post', path: `/documents/${DOC}/flag`, body: { note: 'Blurry' }, allowed: HR_ONLY },
  { method: 'get', path: '/onboarding', allowed: ALL },
  { method: 'get', path: `/employees/${ID}/onboarding`, allowed: ALL },
  { method: 'post', path: `/employees/${ID}/onboarding`, allowed: HR_ONLY },
  { method: 'patch', path: `/onboarding/tasks/${TASK}`, body: { status: 'DONE' }, allowed: ALL },
];

const userIdFor = (role: Role) =>
  `00000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;

const stubService = (methods: string[]) =>
  Object.fromEntries(methods.map((m) => [m, vi.fn().mockResolvedValue({})]));

describe('RBAC', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Role, string>;

  beforeAll(async () => {
    const usersById = new Map(
      ROLES.map((role) => [
        userIdFor(role),
        {
          id: userIdFor(role),
          email: `${role.toLowerCase()}@test.local`,
          name: role,
          role,
          employeeId: null,
          isActive: true,
        },
      ]),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        user: {
          findUnique: ({ where }: { where: { id: string } }) =>
            Promise.resolve(usersById.get(where.id) ?? null),
        },
        $disconnect: () => Promise.resolve(),
      })
      .overrideProvider(EmployeesService)
      .useValue(stubService(['search', 'get', 'create', 'update', 'archive', 'reactivate']))
      .overrideProvider(DepartmentsService)
      .useValue(stubService(['list', 'get', 'create', 'update']))
      .overrideProvider(LeaveService)
      .useValue(stubService(['list', 'get', 'preview', 'create', 'approve', 'reject', 'cancel', 'balances', 'holidays']))
      .overrideProvider(DocumentsService)
      .useValue({
        ...stubService(['search', 'forEmployee', 'get', 'upload', 'review']),
        readFile: vi.fn().mockResolvedValue({
          doc: { mimeType: 'application/pdf', fileName: 'x.pdf' },
          data: Buffer.from('%PDF-'),
        }),
      })
      .overrideProvider(OnboardingService)
      .useValue(stubService(['list', 'forEmployee', 'start', 'updateTask']))
      .overrideProvider(AuditService)
      .useValue(stubService(['search', 'record']))
      .compile();

    app = moduleRef.createNestApplication();
    // Bind to loopback explicitly: an ephemeral port on :: can collide with another
    // process listening on 127.0.0.1, sending requests to the wrong server.
    await app.listen(0, '127.0.0.1');

    const jwt = app.get(JwtService);
    for (const role of ROLES) {
      tokens[role] = await jwt.signAsync({
        sub: userIdFor(role),
        email: `${role.toLowerCase()}@test.local`,
        role,
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: Method, path: string, body?: object) => {
    const req = request(app.getHttpServer())[method](path);
    return body ? req.send(body) : req;
  };

  describe.each(endpoints)('$method $path', ({ method, path, body, allowed }) => {
    it.each(ROLES)('%s', async (role) => {
      const res = await call(method, path, body).set(
        'Authorization',
        `Bearer ${tokens[role]}`,
      );
      if (allowed.includes(role)) {
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      } else {
        expect(res.status).toBe(403);
      }
    });

    it('rejects anonymous requests', async () => {
      const res = await call(method, path, body);
      expect(res.status).toBe(401);
    });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new JwtService({ secret: 'not-the-real-secret-123' }).signAsync({
      sub: userIdFor('ADMIN'),
      email: 'admin@test.local',
      role: 'ADMIN',
    });
    const res = await request(app.getHttpServer())
      .get('/employees')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('leaves /health public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});

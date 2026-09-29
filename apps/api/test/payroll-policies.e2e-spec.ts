/**
 * Payroll preparation and policy versions against the real database
 * (run `pnpm db:up && pnpm db:seed` first). Removes what it creates.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { LoginResponse, PayrollReport, Policy, PolicyVersion } from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';

const PASSWORD = 'Password123!';

describe('Payroll preparation and policies (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = { hr: '', manager: '', employee: '' };
  const createdPolicies: string[] = [];

  const as = (who: keyof typeof tokens) => (req: request.Test) => req.set('Authorization', `Bearer ${tokens[who]}`);
  const get = (who: keyof typeof tokens, path: string) => as(who)(request(app.getHttpServer()).get(path));
  const publish = (who: keyof typeof tokens, fields: Record<string, string>, file: Buffer, name: string) => {
    let req = as(who)(request(app.getHttpServer()).post('/policies'));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', file, name);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Bind to loopback explicitly (see employees.e2e-spec.ts).
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
  });

  afterAll(async () => {
    const rows = await prisma.policyDocument.findMany({ where: { id: { in: createdPolicies } } });
    const storage = app.get(StorageService);
    await Promise.all(rows.map((r) => storage.delete(r.storageKey)));
    await prisma.auditLog.deleteMany({ where: { entityId: { in: createdPolicies } } });
    await prisma.policyDocument.deleteMany({ where: { id: { in: createdPolicies } } });
    await app.close();
  });

  describe('payroll preparation', () => {
    let report: PayrollReport;
    const row = (firstName: string) => report.rows.find((r) => r.employee.firstName === firstName)!;

    beforeAll(async () => {
      const res = await get('hr', '/payroll/preparation?month=2026-09').expect(200);
      report = res.body as PayrollReport;
    });

    it('counts paid leave, loss of pay and payable days', () => {
      expect(row('Amit')).toMatchObject({ workingDays: 20, daysWorked: 15, paidLeaveDays: 5, lopDays: 0, payableDays: 20 });
      expect(row('Manoj')).toMatchObject({ unexplainedDays: 1, lopDays: 1, payableDays: 19 });
      expect(row('Riya')).toMatchObject({ daysWorked: 19.5, lopDays: 0.5 });
    });

    it('flags what blocks the payroll run', () => {
      expect(row('Rohan').flags.map((f) => f.code)).toEqual([
        'MISSING_BANK_DETAILS',
        'MISSING_PAN',
        'UNRESOLVED_ATTENDANCE',
        'PENDING_CORRECTION',
      ]);
      expect(row('Kavya').flags).toEqual([
        { code: 'BANK_DETAILS_FLAGGED', message: expect.stringContaining("doesn't match the employee record") },
      ]);
      expect(row('Arun').flags).toEqual([]);
      expect(report.summary.headcount).toBe(19);
    });

    it('exports CSV and stays HR-only', async () => {
      const csv = await get('hr', '/payroll/preparation.csv?month=2026-09').expect(200);
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.headers['content-disposition']).toBe('attachment; filename="payroll-preparation-2026-09.csv"');
      expect(csv.text.split('\r\n')[0]).toMatch(/^Employee code,Name,Department/);

      await get('manager', '/payroll/preparation?month=2026-09').expect(403);
      await get('hr', '/payroll/preparation?month=2099-01').expect(400);
    });
  });

  describe('policies', () => {
    it('lists policies with the version in force', async () => {
      const res = await get('employee', '/policies').expect(200);
      const leave = (res.body as Policy[]).find((p) => p.title === 'Leave Policy')!;
      expect(leave.current?.version).toBe(2);
      expect(leave.versions.map((v) => v.state)).toEqual(['CURRENT', 'SUPERSEDED']);
      const hybrid = (res.body as Policy[]).find((p) => p.title === 'Hybrid Work Policy')!;
      expect(hybrid).toMatchObject({ current: null, versions: [{ state: 'UPCOMING' }] });
    });

    it('publishes a new version that takes effect later', async () => {
      const body = Buffer.from('# Leave Policy (v3)\n\nAnnual leave: 20 days.\n');
      await publish('employee', { title: 'Leave Policy', category: 'LEAVE', effectiveFrom: '2027-01-01' }, body, 'leave.md').expect(403);
      await publish('hr', { title: 'leave policy', category: 'LEAVE', effectiveFrom: '2025-06-01' }, body, 'leave.md').expect(400);
      await publish('hr', { title: 'Leave Policy', category: 'LEAVE', effectiveFrom: '2027-01-01' }, Buffer.from([0x4d, 0x5a, 0, 1]), 'leave.md').expect(415);

      const res = await publish('hr', { title: 'leave policy', category: 'OTHER', effectiveFrom: '2027-01-01', summary: 'Annual leave to 20 days' }, body, 'Leave Policy v3.md').expect(201);
      const version = res.body as PolicyVersion;
      createdPolicies.push(version.id);
      expect(version).toMatchObject({ version: 3, state: 'UPCOMING', mimeType: 'text/markdown; charset=utf-8' });

      const list = await get('employee', '/policies').expect(200);
      const leave = (list.body as Policy[]).find((p) => p.title === 'Leave Policy')!;
      expect(leave.category).toBe('LEAVE'); // existing title keeps its category
      expect(leave.versions.map((v) => `${v.version}:${v.state}`)).toEqual(['3:UPCOMING', '2:CURRENT', '1:SUPERSEDED']);

      const file = await get('employee', `/policies/${version.id}/file`).expect(200);
      expect(file.text).toBe(body.toString('utf8'));
    });
  });
});

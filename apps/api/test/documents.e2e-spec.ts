/**
 * Document upload and review against the real database and local storage
 * (run `pnpm db:up && pnpm db:seed` first). Removes what it creates.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Employee, EmployeeDocument, LoginResponse, Paginated } from '@hr/contracts';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';

const PASSWORD = 'Password123!';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');

describe('Documents (database)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tokens = { hr: '', manager: '', employee: '' };
  let sneha: string;
  let rohan: Employee;
  let uploaded: EmployeeDocument;
  const created: string[] = [];

  const as = (who: keyof typeof tokens) => {
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${tokens[who]}`);
    return {
      get: (path: string) => auth(request(app.getHttpServer()).get(path)),
      post: (path: string, body: object = {}) => auth(request(app.getHttpServer()).post(path)).send(body),
      upload: (employeeId: string, type: string, data: Buffer, name: string) =>
        auth(request(app.getHttpServer()).post(`/employees/${employeeId}/documents`))
          .field('type', type)
          .attach('file', data, name),
    };
  };

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
      if (who === 'employee') sneha = (res.body as LoginResponse).user.employeeId!;
    }
    const found = await as('hr').get('/employees?q=rohan').expect(200);
    rohan = (found.body as Paginated<Employee>).items[0];
  });

  afterAll(async () => {
    const docs = await prisma.document.findMany({ where: { id: { in: created } } });
    const storage = app.get(StorageService);
    await Promise.all(docs.map((d) => storage.delete(d.storageKey)));
    await prisma.auditLog.deleteMany({ where: { entityId: { in: created } } });
    await prisma.document.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it('lets an employee upload their own document', async () => {
    const res = await as('employee').upload(sneha, 'EDUCATION_CERTIFICATE', PDF, 'B.Tech degree.pdf').expect(201);
    uploaded = res.body as EmployeeDocument;
    created.push(uploaded.id);
    expect(uploaded).toMatchObject({
      type: 'EDUCATION_CERTIFICATE',
      fileName: 'B.Tech degree.pdf',
      mimeType: 'application/pdf',
      status: 'PENDING',
      canReview: false,
      uploadedBy: { name: 'Sneha Patel' },
    });
  });

  it('checks file contents, not the file name', async () => {
    const res = await as('employee').upload(sneha, 'OTHER', Buffer.from('<script>alert(1)</script>'), 'scan.pdf').expect(415);
    expect(res.body.message).toBe('Upload a PDF, JPEG or PNG file.');
  });

  it('requires a file and a valid type', async () => {
    await as('employee').post(`/employees/${sneha}/documents`, { type: 'OTHER' }).expect(400);
    await as('employee').upload(sneha, 'PASSPORT', PDF, 'x.pdf').expect(400);
  });

  it("keeps documents private: no uploading to or reading someone else's file", async () => {
    await as('employee').upload(rohan.id, 'OTHER', PDF, 'x.pdf').expect(404);
    // Managers can see their team's leave, but not their documents.
    await as('manager').get(`/employees/${sneha}/documents`).expect(404);
    await as('manager').get(`/documents/${uploaded.id}/file`).expect(404);
    const mine = await as('manager').get('/documents?pageSize=100').expect(200);
    const owners = new Set((mine.body as Paginated<EmployeeDocument>).items.map((d) => d.employee.firstName));
    expect([...owners]).toEqual(['Rahul']);
  });

  it('serves the file back byte-for-byte to someone allowed to see it', async () => {
    const res = await as('hr')
      .get(`/documents/${uploaded.id}/file`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
  });

  it('puts new uploads in the HR review queue', async () => {
    const res = await as('hr').get('/documents?status=PENDING&pageSize=100').expect(200);
    const queue = (res.body as Paginated<EmployeeDocument>).items;
    expect(queue.find((d) => d.id === uploaded.id)?.canReview).toBe(true);
  });

  it('lets HR flag and then verify, with a reason for flags', async () => {
    await as('employee').post(`/documents/${uploaded.id}/verify`).expect(403);
    await as('hr').post(`/documents/${uploaded.id}/flag`, {}).expect(400);

    const flagged = await as('hr')
      .post(`/documents/${uploaded.id}/flag`, { note: 'Scan is cut off; upload all pages' })
      .expect(200);
    expect(flagged.body).toMatchObject({ status: 'FLAGGED', reviewNote: 'Scan is cut off; upload all pages', reviewedBy: { name: 'Lakshmi Pillai' } });

    const verified = await as('hr').post(`/documents/${uploaded.id}/verify`).expect(200);
    expect(verified.body).toMatchObject({ status: 'VERIFIED', reviewNote: null });
    await as('hr').post(`/documents/${uploaded.id}/verify`).expect(409);

    const audit = await as('hr').get(`/audit-logs?entityType=Document&entityId=${uploaded.id}`).expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual([
      'document.verified',
      'document.flagged',
      'document.uploaded',
    ]);
  });

  it("doesn't let HR review their own documents", async () => {
    const own = await prisma.document.findFirstOrThrow({ where: { employee: { firstName: 'Lakshmi' } } });
    const res = await as('hr').post(`/documents/${own.id}/flag`, { note: 'test' }).expect(403);
    expect(res.body.message).toMatch(/own documents/);
  });
});

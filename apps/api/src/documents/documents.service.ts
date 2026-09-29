import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_UPLOAD_RULES,
  roleHasPermission,
  type DocumentSearchQuery,
  type DocumentStatus,
  type DocumentType,
  type EmployeeDocument,
  type Paginated,
} from '@hr/contracts';
import type { Prisma } from '@hr/db';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { assertEmployeeInScope, employeeScope } from '../common/scope.js';
import { employeeRefSelect } from '../employees/employee.mapper.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { detectFileType, sanitizeFileName } from './file-type.js';

const documentInclude = {
  employee: { select: employeeRefSelect },
  uploadedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.DocumentInclude;

type DocumentRow = Prisma.DocumentGetPayload<{ include: typeof documentInclude }>;

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Called in the same transaction when a document becomes VERIFIED, so other
 * areas (e.g. onboarding) can react without the documents module knowing them.
 */
export type DocumentVerifiedHook = (tx: Tx, doc: { employeeId: string; type: DocumentType }, actor: AuthUser) => Promise<void>;

@Injectable()
export class DocumentsService {
  private readonly verifiedHooks: DocumentVerifiedHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  onVerified(hook: DocumentVerifiedHook) {
    this.verifiedHooks.push(hook);
  }

  async search(user: AuthUser, query: DocumentSearchQuery): Promise<Paginated<EmployeeDocument>> {
    const where: Prisma.DocumentWhereInput = {
      employee: employeeScope(user, 'self'),
      employeeId: query.employeeId,
      status: query.status,
      type: query.type,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        include: documentInclude,
        // Review queues read oldest first; everything else newest first.
        orderBy: { uploadedAt: query.status === 'PENDING' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.document.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r, user)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async forEmployee(user: AuthUser, employeeId: string): Promise<EmployeeDocument[]> {
    await assertEmployeeInScope(this.prisma, user, employeeId, 'self');
    const rows = await this.prisma.document.findMany({
      where: { employeeId },
      include: documentInclude,
      orderBy: { uploadedAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r, user));
  }

  async get(user: AuthUser, id: string): Promise<EmployeeDocument> {
    return this.toDto(await this.findInScope(this.prisma, user, id), user);
  }

  async readFile(user: AuthUser, id: string): Promise<{ doc: DocumentRow; data: Buffer }> {
    const doc = await this.findInScope(this.prisma, user, id);
    return { doc, data: await this.storage.read(doc.storageKey) };
  }

  async upload(
    user: AuthUser,
    employeeId: string,
    type: DocumentType,
    file: UploadedFile | undefined,
  ): Promise<EmployeeDocument> {
    if (!file || file.size === 0) throw new BadRequestException('Attach a file to upload.');
    const detected = detectFileType(file.buffer);
    if (!detected || !(DOCUMENT_UPLOAD_RULES.mimeTypes as readonly string[]).includes(detected.mimeType)) {
      throw new UnsupportedMediaTypeException('Upload a PDF, JPEG or PNG file.');
    }
    await assertEmployeeInScope(this.prisma, user, employeeId, 'self');

    const id = randomUUID();
    const storageKey = `documents/${employeeId}/${id}${detected.extension}`;
    await this.storage.put(storageKey, file.buffer, detected.mimeType);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.document.create({
          data: {
            id,
            employeeId,
            type,
            fileName: sanitizeFileName(file.originalname, `${DOCUMENT_TYPE_LABELS[type]}${detected.extension}`),
            mimeType: detected.mimeType,
            sizeBytes: file.size,
            storageKey,
            uploadedById: user.id,
          },
          include: documentInclude,
        });
        await this.audit.record(tx, {
          actor: user,
          action: 'document.uploaded',
          entityType: 'Document',
          entityId: id,
          after: { employeeId, type, fileName: row.fileName, sizeBytes: row.sizeBytes },
        });
        return this.toDto(row, user);
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async review(
    user: AuthUser,
    id: string,
    status: Exclude<DocumentStatus, 'PENDING'>,
    note?: string,
  ): Promise<EmployeeDocument> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findInScope(tx, user, id);
      if (current.employeeId === user.employeeId) {
        throw new ForbiddenException("You can't review your own documents.");
      }
      if (current.status === status) {
        throw new ConflictException(`This document is already ${status.toLowerCase()}.`);
      }

      const { count } = await tx.document.updateMany({
        where: { id, status: current.status },
        data: { status, reviewedById: user.id, reviewedAt: new Date(), reviewNote: note || null },
      });
      if (count === 0) throw new ConflictException('This document was just reviewed. Reload and try again.');

      await this.audit.record(tx, {
        actor: user,
        action: status === 'VERIFIED' ? 'document.verified' : 'document.flagged',
        entityType: 'Document',
        entityId: id,
        before: { status: current.status },
        after: { status, ...(note ? { note } : {}) },
      });
      if (status === 'VERIFIED') {
        for (const hook of this.verifiedHooks) await hook(tx, current, user);
      }

      const row = await tx.document.findUniqueOrThrow({ where: { id }, include: documentInclude });
      return this.toDto(row, user);
    });
  }

  private async findInScope(client: PrismaService | Tx, user: AuthUser, id: string) {
    const row = await client.document.findFirst({
      where: { id, employee: employeeScope(user, 'self') },
      include: documentInclude,
    });
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  private toDto(row: DocumentRow, user: AuthUser): EmployeeDocument {
    return {
      id: row.id,
      employee: row.employee,
      type: row.type,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      uploadedBy: row.uploadedBy,
      uploadedAt: row.uploadedAt.toISOString(),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      canReview:
        roleHasPermission(user.role, 'document:verify') && row.employeeId !== user.employeeId,
    };
  }
}

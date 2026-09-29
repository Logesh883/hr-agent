import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Policy, PolicyVersion, PublishPolicyBody } from '@hr/contracts';
import type { Prisma } from '@hr/db';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { formatDate, fromIsoDate, toIsoDate, todayIso } from '../common/dates.js';
import { detectPolicyFileType, sanitizeFileName } from '../documents/file-type.js';
import type { UploadedFile } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

const policyInclude = {
  publishedBy: { select: { id: true, name: true } },
} satisfies Prisma.PolicyDocumentInclude;

type PolicyRow = Prisma.PolicyDocumentGetPayload<{ include: typeof policyInclude }>;

@Injectable()
export class PoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /** Every policy with its version history; which version is in force is decided by effective date. */
  async list(): Promise<Policy[]> {
    const rows = await this.prisma.policyDocument.findMany({
      include: policyInclude,
      orderBy: [{ title: 'asc' }, { version: 'desc' }],
    });
    const today = todayIso();
    const byTitle = new Map<string, PolicyRow[]>();
    for (const r of rows) byTitle.set(r.title, [...(byTitle.get(r.title) ?? []), r]);

    return [...byTitle.values()].map((versions) => {
      const current = versions.find((v) => toIsoDate(v.effectiveFrom) <= today) ?? null;
      const dtos = versions.map((v) => toDto(v, current?.id === v.id ? 'CURRENT' : toIsoDate(v.effectiveFrom) > today ? 'UPCOMING' : 'SUPERSEDED'));
      return {
        title: versions[0].title,
        category: versions[0].category,
        current: dtos.find((d) => d.state === 'CURRENT') ?? null,
        versions: dtos,
      };
    });
  }

  async readFile(id: string): Promise<{ doc: PolicyRow; data: Buffer }> {
    const doc = await this.prisma.policyDocument.findUnique({ where: { id }, include: policyInclude });
    if (!doc) throw new NotFoundException('Policy not found');
    return { doc, data: await this.storage.read(doc.storageKey) };
  }

  /** Publishes a policy, or a new version of an existing one (matched by title). */
  async publish(user: AuthUser, body: PublishPolicyBody, file: UploadedFile | undefined): Promise<PolicyVersion> {
    if (!file || file.size === 0) throw new BadRequestException('Attach the policy document.');
    const detected = detectPolicyFileType(file.buffer, file.originalname);
    if (!detected) throw new UnsupportedMediaTypeException('Upload a PDF, DOCX, Markdown or text file.');

    const latest = await this.prisma.policyDocument.findFirst({
      where: { title: { equals: body.title, mode: 'insensitive' } },
      orderBy: { version: 'desc' },
    });
    if (latest && body.effectiveFrom < toIsoDate(latest.effectiveFrom)) {
      throw new BadRequestException(
        `The new version must take effect on or after version ${latest.version} (${formatDate(toIsoDate(latest.effectiveFrom))}).`,
      );
    }

    const id = randomUUID();
    const storageKey = `policies/${id}${detected.extension}`;
    await this.storage.put(storageKey, file.buffer, detected.mimeType);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.policyDocument.create({
          data: {
            id,
            // Keep the existing title's spelling and category so versions stay grouped.
            title: latest?.title ?? body.title,
            category: latest?.category ?? body.category,
            version: (latest?.version ?? 0) + 1,
            effectiveFrom: fromIsoDate(body.effectiveFrom),
            summary: body.summary || null,
            fileName: sanitizeFileName(file.originalname, `${body.title}${detected.extension}`),
            mimeType: detected.mimeType,
            sizeBytes: file.size,
            storageKey,
            publishedById: user.id,
          },
          include: policyInclude,
        });
        await this.audit.record(tx, {
          actor: user,
          action: 'policy.published',
          entityType: 'PolicyDocument',
          entityId: id,
          after: { title: row.title, version: row.version, effectiveFrom: body.effectiveFrom, fileName: row.fileName },
        });
        return toDto(row, body.effectiveFrom > todayIso() ? 'UPCOMING' : 'CURRENT');
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }
}

function toDto(row: PolicyRow, state: PolicyVersion['state']): PolicyVersion {
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: toIsoDate(row.effectiveFrom),
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    summary: row.summary,
    publishedBy: row.publishedBy,
    publishedAt: row.createdAt.toISOString(),
    state,
  };
}

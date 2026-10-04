import { Injectable } from '@nestjs/common';
import type {
  AuditEntityType,
  AuditLogEntry,
  AuditSearchQuery,
  Paginated,
} from '@hr/contracts';
import type { Prisma } from '@hr/db';
import type { AuthUser } from '../auth/auth.types.js';
import { currentAgentRunId, currentToolName } from '../common/agent-context.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

type Snapshot = Record<string, unknown>;

export interface AuditEvent {
  actor: AuthUser;
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  before?: Snapshot | null;
  after?: Snapshot | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a mutation. Call inside the same transaction as the change so the
   * audit entry and the change commit (or roll back) together.
   */
  async record(tx: Tx, event: AuditEvent): Promise<void> {
    const agentRunId = currentAgentRunId();
    await tx.auditLog.create({
      data: {
        // The agent acts as the user (their token), so the actor stays the user; AI marks how.
        actorType: agentRunId ? 'AI' : 'USER',
        actorId: event.actor.id,
        agentRunId,
        toolName: currentToolName(),
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: (event.before ?? undefined) as
          Prisma.InputJsonValue | undefined,
        after: (event.after ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async search(query: AuditSearchQuery): Promise<Paginated<AuditLogEntry>> {
    const where = {
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const actorIds = [
      ...new Set(rows.map((r) => r.actorId).filter((id) => id !== null)),
    ];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const actorNames = new Map(actors.map((a) => [a.id, a.name]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        actorType: r.actorType,
        actorId: r.actorId,
        agentRunId: r.agentRunId,
        toolName: r.toolName,
        actorName: r.actorId ? (actorNames.get(r.actorId) ?? null) : null,
        action: r.action,
        entityType: r.entityType as AuditEntityType,
        entityId: r.entityId,
        before: r.before as Snapshot | null,
        after: r.after as Snapshot | null,
        timestamp: r.timestamp.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

/**
 * Before/after pair containing only the fields that changed, so audit entries
 * stay readable. Returns null when nothing changed.
 */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
): { before: Snapshot; after: Snapshot } | null {
  const changedBefore: Snapshot = {};
  const changedAfter: Snapshot = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key] ?? null;
    }
  }
  return Object.keys(changedAfter).length
    ? { before: changedBefore, after: changedAfter }
    : null;
}

import { z } from 'zod';
import { paginationQuery } from './common.js';

export const ACTOR_TYPES = ['USER', 'AI', 'SYSTEM'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUDIT_ENTITY_TYPES = [
  'Employee',
  'Department',
  'LeaveRequest',
  'Document',
  'OnboardingTask',
  'AttendanceRecord',
  'AttendanceCorrection',
  'PolicyDocument',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const auditSearchSchema = paginationQuery.extend({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  actorId: z.uuid().optional(),
});
export type AuditSearchQuery = z.output<typeof auditSearchSchema>;

export interface AuditLogEntry {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  timestamp: string;
}

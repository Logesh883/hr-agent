import { z } from 'zod';
import { isoDate, type UserRef } from './common.js';

export const POLICY_CATEGORIES = [
  'LEAVE',
  'ATTENDANCE',
  'CONDUCT',
  'ONBOARDING',
  'BENEFITS',
  'PAYROLL',
  'IT_SECURITY',
  'OTHER',
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const POLICY_CATEGORY_LABELS: Record<PolicyCategory, string> = {
  LEAVE: 'Leave',
  ATTENDANCE: 'Attendance',
  CONDUCT: 'Conduct',
  ONBOARDING: 'Onboarding',
  BENEFITS: 'Benefits',
  PAYROLL: 'Payroll',
  IT_SECURITY: 'IT & security',
  OTHER: 'Other',
};

/** Policy sources accepted for publishing (and later RAG ingestion). */
export const POLICY_UPLOAD_RULES = {
  maxBytes: 10 * 1024 * 1024,
  extensions: ['.pdf', '.docx', '.md', '.txt'],
} as const;

/** Multipart fields sent alongside the policy file. */
export const publishPolicySchema = z.object({
  title: z.string().trim().min(3, 'Give the policy a title').max(120),
  category: z.enum(POLICY_CATEGORIES),
  effectiveFrom: isoDate,
  summary: z.string().trim().max(500).optional(),
});
export type PublishPolicyBody = z.output<typeof publishPolicySchema>;

export interface PolicyVersion {
  id: string;
  version: number;
  effectiveFrom: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  summary: string | null;
  publishedBy: UserRef;
  publishedAt: string;
  /** CURRENT: in force today · UPCOMING: effective later · SUPERSEDED: replaced. */
  state: 'CURRENT' | 'UPCOMING' | 'SUPERSEDED';
}

export interface Policy {
  title: string;
  category: PolicyCategory;
  /** The version in force today (null if every version is still upcoming). */
  current: PolicyVersion | null;
  /** All versions, newest first. */
  versions: PolicyVersion[];
}

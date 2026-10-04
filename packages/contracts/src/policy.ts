import { z } from 'zod';
import { isoDate, isoDateTime, userRefSchema } from './common.js';

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

export const POLICY_VERSION_STATES = ['CURRENT', 'UPCOMING', 'SUPERSEDED'] as const;

export const policyVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  effectiveFrom: isoDate,
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  summary: z.string().nullable(),
  publishedBy: userRefSchema,
  publishedAt: isoDateTime,
  /** CURRENT: in force today · UPCOMING: effective later · SUPERSEDED: replaced. */
  state: z.enum(POLICY_VERSION_STATES),
});
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

export const policySchema = z.object({
  title: z.string(),
  category: z.enum(POLICY_CATEGORIES),
  /** The version in force today (null if every version is still upcoming). */
  current: policyVersionSchema.nullable(),
  /** All versions, newest first. */
  versions: z.array(policyVersionSchema),
});
export type Policy = z.infer<typeof policySchema>;

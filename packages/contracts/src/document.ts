import { z } from 'zod';
import { isoDateTime, paginationQuery, userRefSchema } from './common.js';
import { employeeRefSchema } from './employee.js';

export const DOCUMENT_TYPES = [
  'OFFER_LETTER',
  'ID_PROOF',
  'ADDRESS_PROOF',
  'PAN_CARD',
  'BANK_DETAILS',
  'EDUCATION_CERTIFICATE',
  'EXPERIENCE_LETTER',
  'PHOTO',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  OFFER_LETTER: 'Offer letter',
  ID_PROOF: 'ID proof',
  ADDRESS_PROOF: 'Address proof',
  PAN_CARD: 'PAN card',
  BANK_DETAILS: 'Bank details',
  EDUCATION_CERTIFICATE: 'Education certificate',
  EXPERIENCE_LETTER: 'Experience letter',
  PHOTO: 'Photo',
  OTHER: 'Other',
};

/** Label for use mid-sentence: "the offer letter", but "the ID proof" and "the PAN card". */
export function documentLabelInSentence(type: DocumentType): string {
  return DOCUMENT_TYPE_LABELS[type].replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
}

/** Every employee needs these verified (onboarding checklist, payroll readiness). */
export const REQUIRED_DOCUMENT_TYPES: readonly DocumentType[] = [
  'OFFER_LETTER',
  'ID_PROOF',
  'PAN_CARD',
  'BANK_DETAILS',
];

export const DOCUMENT_STATUSES = ['PENDING', 'VERIFIED', 'FLAGGED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_UPLOAD_RULES = {
  maxBytes: 10 * 1024 * 1024,
  mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
} as const;

/** Multipart fields sent alongside the file. */
export const uploadDocumentSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
});

export const verifyDocumentSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type VerifyDocumentBody = z.output<typeof verifyDocumentSchema>;

export const flagDocumentSchema = z.object({
  note: z.string().trim().min(1, 'Explain what needs fixing').max(500),
});
export type FlagDocumentBody = z.output<typeof flagDocumentSchema>;

export const documentSearchSchema = paginationQuery.extend({
  employeeId: z.uuid().optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  type: z.enum(DOCUMENT_TYPES).optional(),
});
export type DocumentSearchQuery = z.output<typeof documentSearchSchema>;
export type DocumentSearchParams = Partial<DocumentSearchQuery>;

export const employeeDocumentSchema = z.object({
  id: z.uuid(),
  employee: employeeRefSchema,
  type: z.enum(DOCUMENT_TYPES),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(DOCUMENT_STATUSES),
  uploadedBy: userRefSchema,
  uploadedAt: isoDateTime,
  reviewedBy: userRefSchema.nullable(),
  reviewedAt: isoDateTime.nullable(),
  reviewNote: z.string().nullable(),
  /** Whether the caller may verify or flag it (HR, and never their own). */
  canReview: z.boolean(),
});
export type EmployeeDocument = z.infer<typeof employeeDocumentSchema>;

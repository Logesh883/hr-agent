import { z } from 'zod';
import { isoDate, isoDateTime, paginationQuery, userRefSchema } from './common.js';
import { DOCUMENT_TYPES } from './document.js';
import { employeeRefSchema, type EmployeeRef } from './employee.js';

export const ONBOARDING_TASK_STATUSES = ['PENDING', 'DONE', 'SKIPPED'] as const;
export type OnboardingTaskStatus = (typeof ONBOARDING_TASK_STATUSES)[number];

export const ONBOARDING_CATEGORIES = ['PAPERWORK', 'DOCUMENTS', 'IT_SETUP', 'ORIENTATION', 'TEAM'] as const;
export type OnboardingCategory = (typeof ONBOARDING_CATEGORIES)[number];

export const ONBOARDING_CATEGORY_LABELS: Record<OnboardingCategory, string> = {
  PAPERWORK: 'Paperwork',
  DOCUMENTS: 'Documents',
  IT_SETUP: 'IT setup',
  ORIENTATION: 'Orientation',
  TEAM: 'Team',
};

/** Who is expected to do the task. */
export const ONBOARDING_ASSIGNEES = ['HR', 'MANAGER', 'EMPLOYEE', 'IT'] as const;
export type OnboardingAssignee = (typeof ONBOARDING_ASSIGNEES)[number];

export const updateOnboardingTaskSchema = z
  .object({
    status: z.enum(ONBOARDING_TASK_STATUSES).optional(),
    notes: z.string().trim().max(1000).optional(),
    dueDate: isoDate.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOnboardingTaskBody = z.output<typeof updateOnboardingTaskSchema>;

export const ONBOARDING_STATES = ['active', 'completed', 'all'] as const;

export const onboardingSearchSchema = paginationQuery.extend({
  state: z.enum(ONBOARDING_STATES).default('active'),
});
export type OnboardingSearchQuery = z.output<typeof onboardingSearchSchema>;
export type OnboardingSearchParams = Partial<OnboardingSearchQuery>;

export const onboardingTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.enum(ONBOARDING_CATEGORIES),
  assignee: z.enum(ONBOARDING_ASSIGNEES),
  dueDate: isoDate,
  status: z.enum(ONBOARDING_TASK_STATUSES),
  /** Completes automatically when a document of this type is verified. */
  requiredDocumentType: z.enum(DOCUMENT_TYPES).nullable(),
  completedAt: isoDateTime.nullable(),
  completedBy: userRefSchema.nullable(),
  notes: z.string().nullable(),
  isOverdue: z.boolean(),
  /** Whether the caller may change this task (HR, or its manager/employee assignee). */
  canUpdate: z.boolean(),
});
export type OnboardingTask = z.infer<typeof onboardingTaskSchema>;

export const onboardingProgressSchema = z.object({
  total: z.number().int(),
  done: z.number().int(),
  skipped: z.number().int(),
  overdue: z.number().int(),
  /** Done or skipped, as a whole percentage. */
  percent: z.number(),
});
export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>;

/** Something HR should chase before or after day one. */
export const missingInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type MissingInfo = z.infer<typeof missingInfoSchema>;

export const employeeOnboardingSchema = z.object({
  employee: employeeRefSchema.extend({
    jobTitle: z.string(),
    joiningDate: isoDate,
    departmentName: z.string().nullable(),
  }),
  started: z.boolean(),
  tasks: z.array(onboardingTaskSchema),
  progress: onboardingProgressSchema,
  missingInfo: z.array(missingInfoSchema),
  canStart: z.boolean(),
});
export type EmployeeOnboarding = z.infer<typeof employeeOnboardingSchema>;

export interface OnboardingSummary {
  employee: EmployeeRef & { jobTitle: string; joiningDate: string; departmentName: string | null };
  progress: OnboardingProgress;
  nextTask: { title: string; dueDate: string; isOverdue: boolean } | null;
  missingInfoCount: number;
}

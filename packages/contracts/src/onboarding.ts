import { z } from 'zod';
import { isoDate, paginationQuery, type UserRef } from './common.js';
import type { DocumentType } from './document.js';
import type { EmployeeRef } from './employee.js';

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

export interface OnboardingTask {
  id: string;
  title: string;
  description: string | null;
  category: OnboardingCategory;
  assignee: OnboardingAssignee;
  dueDate: string;
  status: OnboardingTaskStatus;
  /** Completes automatically when a document of this type is verified. */
  requiredDocumentType: DocumentType | null;
  completedAt: string | null;
  completedBy: UserRef | null;
  notes: string | null;
  isOverdue: boolean;
  /** Whether the caller may change this task (HR, or its manager/employee assignee). */
  canUpdate: boolean;
}

export interface OnboardingProgress {
  total: number;
  done: number;
  skipped: number;
  overdue: number;
  /** Done or skipped, as a whole percentage. */
  percent: number;
}

/** Something HR should chase before or after day one. */
export interface MissingInfo {
  code: string;
  message: string;
}

export interface EmployeeOnboarding {
  employee: EmployeeRef & { jobTitle: string; joiningDate: string; departmentName: string | null };
  started: boolean;
  tasks: OnboardingTask[];
  progress: OnboardingProgress;
  missingInfo: MissingInfo[];
  canStart: boolean;
}

export interface OnboardingSummary {
  employee: EmployeeRef & { jobTitle: string; joiningDate: string; departmentName: string | null };
  progress: OnboardingProgress;
  nextTask: { title: string; dueDate: string; isOverdue: boolean } | null;
  missingInfoCount: number;
}

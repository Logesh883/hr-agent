import { z } from 'zod';
import { RISK_LEVELS } from './tools.js';

/**
 * A12.1: the contract between the web app's Command Center and the AI service's runs API
 * (`/agent/runs`). The AI service speaks snake_case JSON; these schemas describe exactly
 * that wire format. They're exported to JSON Schema and Python (contracts/generated.py),
 * and an AI-service test checks real responses against them.
 */

export const RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];


export const startRunSchema = z.object({
  request: z.string().trim().min(1, 'Ask for something').max(4000),
});
export type StartRunBody = z.output<typeof startRunSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'edit']),
  /** For "edit": the arguments that replace the proposed ones. */
  arguments: z.record(z.string(), z.unknown()).nullish(),
  comment: z.string().max(500).nullish(),
});
export type ApprovalDecision = z.output<typeof approvalDecisionSchema>;

/** A reply to the run's question: text, or an approval decision. Empty: just continue. */
export const resumeRunSchema = z.object({
  answer: z.union([z.string().max(2000), approvalDecisionSchema]).nullish(),
});
export type ResumeRunBody = z.output<typeof resumeRunSchema>;

// ---- the run's question (status "waiting") ---------------------------------------------

const planStepRefSchema = z.object({
  id: z.string(),
  tool: z.string(),
  reason: z.string().nullish(),
});

export const clarificationQuestionSchema = z.object({
  type: z.literal('clarification'),
  question: z.string(),
});

export const valueQuestionSchema = z.object({
  type: z.literal('value'),
  question: z.string(),
  step: z.string(),
  argument: z.string(),
  /** Why the previous answer was refused, if it was. */
  error: z.string().nullish(),
});

export const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  question: z.string(),
  options: z.array(z.string()),
});

export const approvalQuestionSchema = z.object({
  type: z.literal('approval'),
  question: z.string(),
  step: z.string(),
  tool: z.string(),
  risk: z.enum(RISK_LEVELS),
  reason: z.string().nullish(),
  summary: z.string().nullish(),
  before: z.record(z.string(), z.unknown()).nullish(),
  after: z.record(z.string(), z.unknown()).nullish(),
  /** Rule problems the preview found (the write would be refused). */
  problems: z.array(z.string()).default([]),
  arguments: z.record(z.string(), z.unknown()),
  plan: z.array(planStepRefSchema),
  /** Policy citations the plan relied on. */
  policy: z.array(z.string()).default([]),
  /** Why the previous decision (an invalid edit) was refused. */
  error: z.string().nullish(),
});

export const runQuestionSchema = z.discriminatedUnion('type', [
  clarificationQuestionSchema,
  valueQuestionSchema,
  choiceQuestionSchema,
  approvalQuestionSchema,
]);
export type RunQuestion = z.output<typeof runQuestionSchema>;
export type ApprovalQuestion = z.output<typeof approvalQuestionSchema>;

// ---- progress: what the run has done so far ---------------------------------------------

export const STEP_STATUSES = [
  'pending',
  'done',
  'verified',
  'failed',
  'mismatch',
  'skipped',
  'rejected',
  'compensated',
  'not run',
] as const;

export const runStepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  reason: z.string().nullish(),
  status: z.string(),
  error: z.string().nullish(),
  /** The tool's result, shortened: the evidence behind the answer. */
  result: z.string().nullish(),
});
export type RunStep = z.output<typeof runStepSchema>;

export const policyPassageSchema = z.object({
  citation: z.string(),
  text: z.string(),
  /** Set when instruction-like text was removed from the passage (A8.2). */
  warning: z.string().nullish(),
});
export type PolicyPassage = z.output<typeof policyPassageSchema>;

export const runApprovalSchema = z.object({
  step: z.string(),
  tool: z.string(),
  decision: z.enum(['approved', 'rejected', 'edited']),
  risk: z.string(),
  comment: z.string().nullish(),
});

export const completionLineSchema = z.object({
  step: z.string(),
  tool: z.string(),
  status: z.string().nullish(),
  detail: z.string().nullish(),
});

export const runProgressSchema = z.object({
  intent: z.string().nullish(),
  route: z.string().nullish(),
  clarifications: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  policy: z.array(z.string()).default([]),
  passages: z.array(policyPassageSchema).default([]),
  plan: z
    .object({ goal: z.string().nullish(), steps: z.array(runStepSchema) })
    .nullish(),
  verification: z
    .object({
      ok: z.boolean(),
      problems: z.array(z.string()),
      findings: z.array(z.string()),
    })
    .nullish(),
  summary: z.array(completionLineSchema).default([]),
  approvals: z.array(runApprovalSchema).default([]),
});
export type RunProgress = z.output<typeof runProgressSchema>;

export const runViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(RUN_STATUSES),
  request: z.string(),
  workflow_type: z.string().nullish(),
  question: runQuestionSchema.nullish(),
  answer: z.string().nullish(),
  error: z.string().nullish(),
  trace_ids: z.array(z.string()),
  started_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullish(),
  progress: runProgressSchema.nullish(),
});
export type RunView = z.output<typeof runViewSchema>;

export const runListSchema = z.object({ items: z.array(runViewSchema) });
export type RunList = z.output<typeof runListSchema>;

// ---- the event stream (GET /agent/runs/:id/events, SSE) ---------------------------------

const event = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) =>
  z.looseObject({ event: z.literal(name), ...shape });

export const runEventSchema = z.discriminatedUnion('event', [
  event('run_started', { request: z.string() }),
  event('run_resumed', { answer: z.unknown() }),
  event('node_started', { node: z.string() }),
  event('node_finished', {
    node: z.string(),
    summary: z.record(z.string(), z.unknown()),
  }),
  event('tool_started', { tool: z.string(), step: z.string(), attempt: z.number().optional() }),
  event('tool_finished', { tool: z.string(), step: z.string(), ok: z.boolean() }),
  event('tool_retry', { step: z.string(), after_s: z.number(), error: z.string().nullish() }),
  event('verified', { step: z.string(), ok: z.boolean(), mismatches: z.array(z.string()) }),
  event('compensated', { step: z.string(), note: z.string() }),
  event('approval_decided', { step: z.string(), tool: z.string(), decision: z.string() }),
  event('waiting', { type: z.string(), question: z.string() }),
  event('budget_exceeded', { reason: z.string() }),
  event('finished', { status: z.string().nullish(), answer: z.string().nullish() }),
  event('failed', { error: z.string() }),
]);
export type RunEvent = z.output<typeof runEventSchema>;
export type RunEventName = RunEvent['event'];

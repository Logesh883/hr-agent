import { z } from 'zod';
import {
  attendanceCorrectionSchema,
  correctionApproveSchema,
  monthlyAttendanceReportSchema,
  monthlyAttendanceSchema,
  proposeCorrectionSchema,
} from './attendance.js';
import { paginatedSchema } from './common.js';
import {
  EMPLOYMENT_TYPES,
  createEmployeeSchema,
  employeeSchema,
  employeeSearchSchema,
} from './employee.js';
import {
  leaveApproveSchema,
  leaveRejectSchema,
  leaveRequestRecordSchema,
  leaveRequestSchema,
} from './leave.js';
import {
  employeeOnboardingSchema,
  onboardingTaskSchema,
  updateOnboardingTaskSchema,
} from './onboarding.js';
import type { Permission } from './permissions.js';

/**
 * T3.1: the Tool API, the contract between the HR API and the AI agent (README §4).
 *
 * Each tool is one typed operation: `POST /tools/:name` with the input as the body,
 * answered with the output. The API runs it with the caller's own permissions and data
 * scope (the agent forwards the signed-in user's token), validates the input with the
 * schema below, honours `Idempotency-Key`, and audits it (`actorType: AI` and the tool's
 * name when the agent calls it). `GET /tools` lists the catalog.
 *
 * README §4 lists 13 tools. Three of them aren't here, deliberately:
 * - `upload_document` is a multipart file upload; it stays `POST /employees/:id/documents`.
 * - `send_email` is the AI service's outbox (a stub: nothing is ever sent).
 * - `generate_document` belongs to document AI (M9), which is deferred.
 * `reject_leave`, `cancel_leave`, `start_onboarding` and `update_onboarding_task` are added,
 * because the agent needs them.
 */

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const id = (description: string) => z.uuid().describe(description);
const version = z
  .number()
  .int()
  .min(1)
  .describe('The record version you read; a stale one is refused with 409');

export const updateEmployeeToolSchema = z.object({
  employeeId: id('The employee to update'),
  version,
  jobTitle: z.string().trim().min(1).max(150).optional(),
  location: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  status: z.enum(['ACTIVE', 'PROBATION']).optional(),
});

export const changeManagerToolSchema = z.object({
  employeeId: id('The employee whose manager changes'),
  version,
  managerId: z.uuid().nullable().describe('The new manager; null for none'),
});

export const changeDepartmentToolSchema = z.object({
  employeeId: id('The employee who moves'),
  version,
  departmentId: id('The new department'),
});

export const startOnboardingToolSchema = z.object({
  employeeId: id('The employee to onboard'),
});

export const updateOnboardingTaskToolSchema = updateOnboardingTaskSchema
  .safeExtend({ taskId: id('The onboarding task') })
  .refine(({ taskId: _, ...changes }) => Object.keys(changes).length > 0, {
    message: 'Nothing to update',
  });

export const approveLeaveToolSchema = leaveApproveSchema.extend({
  leaveRequestId: id('A pending leave request'),
});

export const rejectLeaveToolSchema = leaveRejectSchema.extend({
  leaveRequestId: id('A pending leave request'),
});

export const cancelLeaveToolSchema = z.object({
  leaveRequestId: id('A pending leave request'),
});

export const applyCorrectionToolSchema = correctionApproveSchema.extend({
  correctionId: id('A pending attendance correction'),
});

export interface ToolDefinition {
  name: string;
  description: string;
  /** read: no change; write: changes HR data (and is audited). */
  kind: 'read' | 'write';
  permission: Permission;
  input: z.ZodType;
  output: z.ZodType;
}

const tool = <const T extends ToolDefinition>(definition: T) => definition;

export const TOOLS = {
  search_employee: tool({
    name: 'search_employee',
    description: 'Find employees by name, code, email or attributes.',
    kind: 'read',
    permission: 'employee:read',
    input: employeeSearchSchema,
    output: paginatedSchema(employeeSchema),
  }),
  create_employee: tool({
    name: 'create_employee',
    description: 'Create an employee record.',
    kind: 'write',
    permission: 'employee:create',
    input: createEmployeeSchema,
    output: employeeSchema,
  }),
  update_employee: tool({
    name: 'update_employee',
    description: "Change an employee's job title, location, phone, employment type or status.",
    kind: 'write',
    permission: 'employee:update',
    input: updateEmployeeToolSchema,
    output: employeeSchema,
  }),
  change_manager: tool({
    name: 'change_manager',
    description: 'Change who an employee reports to.',
    kind: 'write',
    permission: 'employee:update',
    input: changeManagerToolSchema,
    output: employeeSchema,
  }),
  change_department: tool({
    name: 'change_department',
    description: 'Move an employee to another department.',
    kind: 'write',
    permission: 'employee:update',
    input: changeDepartmentToolSchema,
    output: employeeSchema,
  }),
  start_onboarding: tool({
    name: 'start_onboarding',
    description: "Create an employee's onboarding checklist.",
    kind: 'write',
    permission: 'onboarding:manage',
    input: startOnboardingToolSchema,
    output: employeeOnboardingSchema,
  }),
  update_onboarding_task: tool({
    name: 'update_onboarding_task',
    description: "Update an onboarding task's status, notes or due date.",
    kind: 'write',
    permission: 'onboarding:read',
    input: updateOnboardingTaskToolSchema,
    output: onboardingTaskSchema,
  }),
  create_leave_request: tool({
    name: 'create_leave_request',
    description: 'Submit a leave request; the leave rules are checked first.',
    kind: 'write',
    permission: 'leave:request',
    input: leaveRequestSchema,
    output: leaveRequestRecordSchema,
  }),
  approve_leave: tool({
    name: 'approve_leave',
    description: 'Approve a pending leave request.',
    kind: 'write',
    permission: 'leave:approve',
    input: approveLeaveToolSchema,
    output: leaveRequestRecordSchema,
  }),
  reject_leave: tool({
    name: 'reject_leave',
    description: 'Reject a pending leave request with a reason.',
    kind: 'write',
    permission: 'leave:approve',
    input: rejectLeaveToolSchema,
    output: leaveRequestRecordSchema,
  }),
  cancel_leave: tool({
    name: 'cancel_leave',
    description: 'Cancel a pending leave request (the agent uses it to undo its own request).',
    kind: 'write',
    permission: 'leave:request',
    input: cancelLeaveToolSchema,
    output: leaveRequestRecordSchema,
  }),
  read_attendance: tool({
    name: 'read_attendance',
    description: "A month's attendance: summary rows, anomalies, and day detail for one person.",
    kind: 'read',
    permission: 'attendance:read',
    input: monthlyAttendanceSchema,
    output: monthlyAttendanceReportSchema,
  }),
  propose_attendance_correction: tool({
    name: 'propose_attendance_correction',
    description: 'Propose a fix to an attendance record; nothing changes until HR approves it.',
    kind: 'write',
    permission: 'attendance:propose',
    input: proposeCorrectionSchema,
    output: attendanceCorrectionSchema,
  }),
  apply_attendance_correction: tool({
    name: 'apply_attendance_correction',
    description: 'Approve a proposed attendance correction, which changes the record.',
    kind: 'write',
    permission: 'attendance:approve',
    input: applyCorrectionToolSchema,
    output: attendanceCorrectionSchema,
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

export type ToolInput<N extends ToolName> = z.output<(typeof TOOLS)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.output<(typeof TOOLS)[N]['output']>;

/** `GET /tools`: one entry per tool, with JSON Schemas for its input and output. */
export interface ToolCatalogEntry {
  name: ToolName;
  description: string;
  kind: 'read' | 'write';
  permission: Permission;
  /** Whether the caller's role may call it. */
  allowed: boolean;
  /** What the agent's approval gate does with it by default (see TOOL_RISK). */
  risk: RiskLevel | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

// ---- T4.1: risk classification ----------------------------------------------------------

export interface RiskRule {
  default: RiskLevel;
  /** A riskier level when one of these fields is set: the riskiest field present wins. */
  fields?: Record<string, RiskLevel>;
}

/**
 * How risky each write the agent can make is, and so whether a person must approve it
 * first (README §8). One source for the agent's approval gate (exported to
 * json-schema/risk.json) and the Tool API's catalog.
 *
 *   low     runs without asking
 *   medium  asks when `approveMedium` is true (configurable)
 *   high    always asks
 *
 * Field names are the agent's (snake_case). Any write not listed is high.
 */
export const RISK_POLICY = {
  approveMedium: true,
  default: 'high' as RiskLevel,
  tools: {
    create_employee: { default: 'medium' },
    update_employee: {
      default: 'low',
      fields: { status: 'medium', employment_type: 'medium' },
    },
    change_manager: { default: 'medium' },
    change_department: { default: 'medium' },
    start_onboarding: { default: 'low' },
    update_onboarding_task: { default: 'low' },
    // Checked against the leave rules before it's sent.
    create_leave_request: { default: 'low' },
    approve_leave: { default: 'high' },
    reject_leave: { default: 'high' },
    // Only ever the agent undoing its own pending request (A7.4 compensation).
    cancel_leave: { default: 'low' },
    // Only a proposal: HR approves it in the app.
    propose_attendance_correction: { default: 'low' },
    apply_attendance_correction: { default: 'high' },
    // Leaves the company; a stub here, but treated as real.
    send_email: { default: 'high' },
  } satisfies Record<string, RiskRule>,
} as const;

/** The level for a call with the given argument names set (the riskiest one wins). */
export function riskOf(tool: string, fields: Iterable<string> = []): RiskLevel {
  const rule = (RISK_POLICY.tools as Record<string, RiskRule>)[tool];
  if (!rule) return RISK_POLICY.default;
  const order: RiskLevel[] = ['low', 'medium', 'high'];
  let level = rule.default;
  for (const field of fields) {
    const raised = rule.fields?.[field];
    if (raised && order.indexOf(raised) > order.indexOf(level)) level = raised;
  }
  return level;
}

/** Whether a call at this level waits for a person (high always does). */
export function needsApproval(level: RiskLevel): boolean {
  return level === 'high' || (level === 'medium' && RISK_POLICY.approveMedium);
}

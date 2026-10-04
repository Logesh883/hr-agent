/**
 * Exports the Zod contracts the AI service shares as one JSON Schema document
 * (json-schema/api.json). `pnpm contracts:generate` then turns it into Pydantic
 * models in apps/ai/contracts/generated.py.
 *
 * Every schema goes into one Zod registry, so a shape used in several places
 * (EmployeeRef, UserRef, …) becomes a single `$defs` entry referenced with
 * `$ref`, and a single Python class.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import * as contracts from '../dist/index.js';

/** Request bodies and query strings: what the API accepts. */
const requests = {
  LoginRequest: contracts.loginRequestSchema,
  ChangePassword: contracts.changePasswordSchema,
  GrantAccess: contracts.grantAccessSchema,
  UpdateAccess: contracts.updateAccessSchema,
  DailyAttendanceQuery: contracts.dailyAttendanceSchema,
  MonthlyAttendanceQuery: contracts.monthlyAttendanceSchema,
  ProposeCorrection: contracts.proposeCorrectionSchema,
  ApproveCorrection: contracts.correctionApproveSchema,
  RejectCorrection: contracts.correctionRejectSchema,
  CorrectionSearchQuery: contracts.correctionSearchSchema,
  AuditSearchQuery: contracts.auditSearchSchema,
  PublishPolicy: contracts.publishPolicySchema,
  CreateDepartment: contracts.createDepartmentSchema,
  UpdateDepartment: contracts.updateDepartmentSchema,
  UploadDocument: contracts.uploadDocumentSchema,
  VerifyDocument: contracts.verifyDocumentSchema,
  FlagDocument: contracts.flagDocumentSchema,
  DocumentSearchQuery: contracts.documentSearchSchema,
  CreateEmployee: contracts.createEmployeeSchema,
  UpdateEmployee: contracts.updateEmployeeSchema,
  ArchiveEmployee: contracts.archiveEmployeeSchema,
  EmployeeSearchQuery: contracts.employeeSearchSchema,
  CreateLeaveRequest: contracts.leaveRequestSchema,
  ApproveLeave: contracts.leaveApproveSchema,
  RejectLeave: contracts.leaveRejectSchema,
  LeaveSearchQuery: contracts.leaveSearchSchema,
  LeaveBalanceQuery: contracts.leaveBalanceQuerySchema,
  UpdateOnboardingTask: contracts.updateOnboardingTaskSchema,
  OnboardingSearchQuery: contracts.onboardingSearchSchema,
  PayrollReportQuery: contracts.payrollReportSchema,
};

/** Response bodies the AI service reads, and the shared shapes inside them. */
const responses = {
  UserRef: contracts.userRefSchema,
  EmployeeRef: contracts.employeeRefSchema,
  Employee: contracts.employeeSchema,
  EmployeePage: contracts.paginatedSchema(contracts.employeeSchema),
  LeaveProblem: contracts.leaveProblemSchema,
  LeaveBalance: contracts.leaveBalanceSchema,
  LeavePreview: contracts.leavePreviewSchema,
  LeaveRequest: contracts.leaveRequestRecordSchema,
  LeaveRequestPage: contracts.paginatedSchema(contracts.leaveRequestRecordSchema),
  AttendanceAnomaly: contracts.attendanceAnomalySchema,
  AttendanceEntry: contracts.attendanceEntrySchema,
  AttendanceDay: contracts.attendanceDaySchema,
  MonthlyAttendanceRow: contracts.monthlyAttendanceRowSchema,
  MonthlyAttendance: contracts.monthlyAttendanceReportSchema,
  OnboardingTask: contracts.onboardingTaskSchema,
  OnboardingProgress: contracts.onboardingProgressSchema,
  MissingInfo: contracts.missingInfoSchema,
  EmployeeOnboarding: contracts.employeeOnboardingSchema,
  EmployeeDocument: contracts.employeeDocumentSchema,
  PayrollFlag: contracts.payrollFlagSchema,
  PayrollRow: contracts.payrollRowSchema,
  PayrollChange: contracts.payrollChangeSchema,
  PayrollReport: contracts.payrollReportResponseSchema,
};

const registry = z.registry();
for (const [id, schema] of Object.entries({ ...requests, ...responses })) {
  registry.add(schema, { id });
}

const { schemas } = z.toJSONSchema(registry, {
  target: 'draft-2020-12',
  io: 'input',
  unrepresentable: 'any',
  uri: (id) => `#/$defs/${id}`,
});

// Zod adds a regex next to `format` for dates, UUIDs and emails. Pydantic already
// parses those formats into date/UUID/EmailStr, and refuses to apply a regex to a
// parsed date, so the format alone is kept.
const FORMATS_WITHOUT_PATTERN = new Set(['date', 'date-time', 'uuid', 'email']);
function dropFormatPatterns(node) {
  if (Array.isArray(node)) return node.map(dropFormatPatterns);
  if (node === null || typeof node !== 'object') return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' && FORMATS_WITHOUT_PATTERN.has(node.format)) continue;
    copy[key] = dropFormatPatterns(value);
  }
  return copy;
}

const definitions = Object.fromEntries(
  Object.entries(schemas).map(([id, schema]) => {
    const { $schema: _schema, $id: _id, ...rest } = dropFormatPatterns(schema);
    return [id, { title: id, ...rest }];
  }),
);

const outputPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'json-schema', 'api.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions }, null, 2)}\n`,
);
console.log(
  `Exported ${Object.keys(requests).length} request/query and ${Object.keys(responses).length} response schemas to ${outputPath}`,
);

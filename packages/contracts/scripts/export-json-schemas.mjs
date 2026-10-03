import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import * as contracts from '../dist/index.js';

const schemas = {
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

const definitions = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    { title: name, ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) },
  ]),
);

const outputPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'json-schema', 'api.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions }, null, 2)}\n`,
);
console.log(`Exported ${Object.keys(definitions).length} request/query schemas to ${outputPath}`);

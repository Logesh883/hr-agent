import { Injectable, NotFoundException } from '@nestjs/common';
import {
  TOOLS,
  isToolName,
  type ToolInput,
  type ToolName,
} from '@hr/contracts';
import { AttendanceService } from '../attendance/attendance.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { EmployeesService } from '../employees/employees.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

type Handlers = {
  [N in ToolName]: (user: AuthUser, input: ToolInput<N>) => Promise<unknown>;
};

/**
 * T3.3: each tool runs the same service method its REST endpoint does, so business rules,
 * data scope, locking and audit are identical whichever way it's called.
 */
@Injectable()
export class ToolsService {
  private readonly handlers: Handlers;

  constructor(
    employees: EmployeesService,
    leave: LeaveService,
    onboarding: OnboardingService,
    attendance: AttendanceService,
  ) {
    this.handlers = {
      search_employee: (_user, input) => employees.search(input),
      create_employee: (user, input) => employees.create(input, user),
      update_employee: (user, { employeeId, ...changes }) =>
        employees.update(employeeId, changes, user),
      change_manager: (user, { employeeId, managerId, version }) =>
        employees.update(employeeId, { managerId, version }, user),
      change_department: (user, { employeeId, departmentId, version }) =>
        employees.update(employeeId, { departmentId, version }, user),
      start_onboarding: (user, { employeeId }) =>
        onboarding.start(user, employeeId),
      update_onboarding_task: (user, { taskId, ...changes }) =>
        onboarding.updateTask(user, taskId, changes),
      create_leave_request: (user, input) => leave.create(user, input),
      approve_leave: (user, { leaveRequestId, ...body }) =>
        leave.approve(user, leaveRequestId, body),
      reject_leave: (user, { leaveRequestId, ...body }) =>
        leave.reject(user, leaveRequestId, body),
      cancel_leave: (user, { leaveRequestId }) =>
        leave.cancel(user, leaveRequestId),
      read_attendance: (user, input) => attendance.monthly(user, input),
      propose_attendance_correction: (user, input) =>
        attendance.propose(user, input),
      apply_attendance_correction: (user, { correctionId, comment }) =>
        attendance.approve(user, correctionId, comment),
    };
  }

  /** The tool's definition; 404 for a name that isn't a tool. */
  definition(name: string) {
    if (!isToolName(name))
      throw new NotFoundException(`Unknown tool '${name}'`);
    return TOOLS[name];
  }

  run<N extends ToolName>(
    name: N,
    user: AuthUser,
    input: ToolInput<N>,
  ): Promise<unknown> {
    return (this.handlers[name] as Handlers[N])(user, input);
  }
}

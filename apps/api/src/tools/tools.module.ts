import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { ToolsController } from './tools.controller.js';
import { ToolsService } from './tools.service.js';

@Module({
  imports: [EmployeesModule, LeaveModule, OnboardingModule, AttendanceModule],
  controllers: [ToolsController],
  providers: [ToolsService],
})
export class ToolsModule {}

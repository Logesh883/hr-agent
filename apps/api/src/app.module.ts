import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { PrismaExceptionFilter } from './common/prisma-exception.filter.js';
import { DepartmentsModule } from './departments/departments.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { EmployeesModule } from './employees/employees.module.js';
import { LeaveModule } from './leave/leave.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { PayrollModule } from './payroll/payroll.module.js';
import { PoliciesModule } from './policies/policies.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuditModule,
    AuthModule,
    EmployeesModule,
    DepartmentsModule,
    LeaveModule,
    DocumentsModule,
    OnboardingModule,
    AttendanceModule,
    PayrollModule,
    PoliciesModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_FILTER, useClass: PrismaExceptionFilter }],
})
export class AppModule {}

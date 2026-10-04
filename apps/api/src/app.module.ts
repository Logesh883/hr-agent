import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessModule } from './access/access.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AgentContextMiddleware } from './common/agent-context.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
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
    AccessModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AgentContextMiddleware).forRoutes('*path');
  }
}

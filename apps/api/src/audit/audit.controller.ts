import { Controller, Get, Query } from '@nestjs/common';
import {
  auditSearchSchema,
  type AuditLogEntry,
  type AuditSearchQuery,
  type Paginated,
} from '@hr/contracts';
import { RequirePermission } from '../auth/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  search(
    @Query(new ZodValidationPipe(auditSearchSchema)) query: AuditSearchQuery,
  ): Promise<Paginated<AuditLogEntry>> {
    return this.audit.search(query);
  }
}

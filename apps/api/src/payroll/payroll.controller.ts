import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import {
  payrollReportSchema,
  type PayrollReport,
  type PayrollReportQuery,
} from '@hr/contracts';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PayrollService } from './payroll.service.js';

@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('preparation')
  @RequirePermission('payroll:read')
  preparation(
    @Query(new ZodValidationPipe(payrollReportSchema)) query: PayrollReportQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<PayrollReport> {
    return this.payroll.preparation(user, query.month);
  }

  @Get('preparation.csv')
  @RequirePermission('payroll:read')
  async preparationCsv(
    @Query(new ZodValidationPipe(payrollReportSchema)) query: PayrollReportQuery,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const csv = await this.payroll.preparationCsv(user, query.month);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="payroll-preparation-${query.month}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }
}

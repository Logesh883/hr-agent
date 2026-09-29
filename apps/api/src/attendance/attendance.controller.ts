import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  correctionApproveSchema,
  correctionRejectSchema,
  correctionSearchSchema,
  dailyAttendanceSchema,
  monthlyAttendanceSchema,
  proposeCorrectionSchema,
  type AttendanceCorrection,
  type CorrectionSearchQuery,
  type DailyAttendance,
  type DailyAttendanceQuery,
  type MonthlyAttendance,
  type MonthlyAttendanceQuery,
  type Paginated,
  type ProposeCorrectionBody,
} from '@hr/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AttendanceService } from './attendance.service.js';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('daily')
  @RequirePermission('attendance:read')
  daily(
    @Query(new ZodValidationPipe(dailyAttendanceSchema)) query: DailyAttendanceQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<DailyAttendance> {
    return this.attendance.daily(user, query);
  }

  @Get('monthly')
  @RequirePermission('attendance:read')
  monthly(
    @Query(new ZodValidationPipe(monthlyAttendanceSchema)) query: MonthlyAttendanceQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<MonthlyAttendance> {
    return this.attendance.monthly(user, query);
  }

  @Get('corrections')
  @RequirePermission('attendance:read')
  corrections(
    @Query(new ZodValidationPipe(correctionSearchSchema)) query: CorrectionSearchQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<Paginated<AttendanceCorrection>> {
    return this.attendance.corrections(user, query);
  }

  @Post('corrections')
  @RequirePermission('attendance:propose')
  propose(
    @Body(new ZodValidationPipe(proposeCorrectionSchema)) body: ProposeCorrectionBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceCorrection> {
    return this.attendance.propose(user, body);
  }

  @Post('corrections/:id/approve')
  @HttpCode(200)
  @RequirePermission('attendance:approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(correctionApproveSchema)) body: { comment?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceCorrection> {
    return this.attendance.approve(user, id, body.comment);
  }

  @Post('corrections/:id/reject')
  @HttpCode(200)
  @RequirePermission('attendance:approve')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(correctionRejectSchema)) body: { reason: string },
    @CurrentUser() user: AuthUser,
  ): Promise<AttendanceCorrection> {
    return this.attendance.reject(user, id, body.reason);
  }
}

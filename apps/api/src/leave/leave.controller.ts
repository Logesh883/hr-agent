import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  leaveApproveSchema,
  leaveBalanceQuerySchema,
  leaveRejectSchema,
  leaveRequestSchema,
  leaveSearchSchema,
  type Holiday,
  type LeaveApproveBody,
  type LeaveBalance,
  type LeavePreview,
  type LeaveRejectBody,
  type LeaveRequest,
  type LeaveRequestBody,
  type LeaveSearchQuery,
  type Paginated,
} from '@hr/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { LeaveService } from './leave.service.js';

@Controller()
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('leave-requests')
  @RequirePermission('leave:request')
  list(
    @Query(new ZodValidationPipe(leaveSearchSchema)) query: LeaveSearchQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<Paginated<LeaveRequest>> {
    return this.leave.list(user, query);
  }

  @Post('leave-requests/preview')
  @HttpCode(200)
  @RequirePermission('leave:request')
  preview(
    @Body(new ZodValidationPipe(leaveRequestSchema)) body: LeaveRequestBody,
    @CurrentUser() user: AuthUser,
  ): Promise<LeavePreview> {
    return this.leave.preview(user, body);
  }

  @Get('leave-requests/:id')
  @RequirePermission('leave:request')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveRequest> {
    return this.leave.get(user, id);
  }

  @Post('leave-requests')
  @RequirePermission('leave:request')
  create(
    @Body(new ZodValidationPipe(leaveRequestSchema)) body: LeaveRequestBody,
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveRequest> {
    return this.leave.create(user, body);
  }

  @Post('leave-requests/:id/approve')
  @HttpCode(200)
  @RequirePermission('leave:approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(leaveApproveSchema)) body: LeaveApproveBody,
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveRequest> {
    return this.leave.approve(user, id, body);
  }

  @Post('leave-requests/:id/reject')
  @HttpCode(200)
  @RequirePermission('leave:approve')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(leaveRejectSchema)) body: LeaveRejectBody,
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveRequest> {
    return this.leave.reject(user, id, body);
  }

  @Post('leave-requests/:id/cancel')
  @HttpCode(200)
  @RequirePermission('leave:request')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveRequest> {
    return this.leave.cancel(user, id);
  }

  @Get('employees/:id/leave-balances')
  @RequirePermission('leave:request')
  balances(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(leaveBalanceQuerySchema)) query: { year?: number },
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveBalance[]> {
    return this.leave.balances(user, id, query.year);
  }

  /** Company holiday calendar; any signed-in user. */
  @Get('holidays')
  holidays(
    @Query(new ZodValidationPipe(leaveBalanceQuerySchema)) query: { year?: number },
  ): Promise<Holiday[]> {
    return this.leave.holidays(query.year);
  }
}

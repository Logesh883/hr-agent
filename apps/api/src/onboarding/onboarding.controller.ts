import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  onboardingSearchSchema,
  updateOnboardingTaskSchema,
  type EmployeeOnboarding,
  type OnboardingSearchQuery,
  type OnboardingSummary,
  type OnboardingTask,
  type Paginated,
  type UpdateOnboardingTaskBody,
} from '@hr/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OnboardingService } from './onboarding.service.js';

@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('onboarding')
  @RequirePermission('onboarding:read')
  list(
    @Query(new ZodValidationPipe(onboardingSearchSchema)) query: OnboardingSearchQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<Paginated<OnboardingSummary>> {
    return this.onboarding.list(user, query);
  }

  @Get('employees/:id/onboarding')
  @RequirePermission('onboarding:read')
  forEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeOnboarding> {
    return this.onboarding.forEmployee(user, id);
  }

  @Post('employees/:id/onboarding')
  @RequirePermission('onboarding:manage')
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeOnboarding> {
    return this.onboarding.start(user, id);
  }

  /** HR, or the manager/employee a task is assigned to (checked in the service). */
  @Patch('onboarding/tasks/:id')
  @RequirePermission('onboarding:read')
  updateTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateOnboardingTaskSchema)) body: UpdateOnboardingTaskBody,
    @CurrentUser() user: AuthUser,
  ): Promise<OnboardingTask> {
    return this.onboarding.updateTask(user, id, body);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  grantAccessSchema,
  updateAccessSchema,
  type EmployeeAccess,
  type GrantAccessBody,
  type TemporaryPasswordResponse,
  type UpdateAccessBody,
} from '@hr/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AccessService } from './access.service.js';

@Controller('employees/:id/access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get()
  @RequirePermission('access:manage')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<EmployeeAccess> {
    return this.access.get(user, id);
  }

  @Post()
  @RequirePermission('access:manage')
  grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(grantAccessSchema)) body: GrantAccessBody,
    @CurrentUser() user: AuthUser,
  ): Promise<TemporaryPasswordResponse> {
    return this.access.grant(user, id, body);
  }

  @Patch()
  @RequirePermission('access:manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAccessSchema)) body: UpdateAccessBody,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeAccess> {
    return this.access.update(user, id, body);
  }

  @Post('reset-password')
  @HttpCode(200)
  @RequirePermission('access:manage')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TemporaryPasswordResponse> {
    return this.access.resetPassword(user, id);
  }
}

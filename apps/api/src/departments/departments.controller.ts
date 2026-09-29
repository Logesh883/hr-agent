import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  type CreateDepartmentRequest,
  type Department,
  type UpdateDepartmentRequest,
} from '@hr/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DepartmentsService } from './departments.service.js';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequirePermission('department:read')
  list(): Promise<Department[]> {
    return this.departments.list();
  }

  @Get(':id')
  @RequirePermission('department:read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Department> {
    return this.departments.get(id);
  }

  @Post()
  @RequirePermission('department:manage')
  create(
    @Body(new ZodValidationPipe(createDepartmentSchema))
    body: CreateDepartmentRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Department> {
    return this.departments.create(body, user);
  }

  @Patch(':id')
  @RequirePermission('department:manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateDepartmentSchema))
    body: UpdateDepartmentRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Department> {
    return this.departments.update(id, body, user);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  archiveEmployeeSchema,
  createEmployeeSchema,
  employeeSearchSchema,
  updateEmployeeSchema,
  type ArchiveEmployeeRequest,
  type CreateEmployeeRequest,
  type Employee,
  type EmployeeSearchQuery,
  type Paginated,
  type UpdateEmployeeRequest,
} from '@hr/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { EmployeesService } from './employees.service.js';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employee:read')
  search(
    @Query(new ZodValidationPipe(employeeSearchSchema))
    query: EmployeeSearchQuery,
  ): Promise<Paginated<Employee>> {
    return this.employees.search(query);
  }

  @Get(':id')
  @RequirePermission('employee:read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Employee> {
    return this.employees.get(id);
  }

  @Post()
  @RequirePermission('employee:create')
  create(
    @Body(new ZodValidationPipe(createEmployeeSchema))
    body: CreateEmployeeRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Employee> {
    return this.employees.create(body, user);
  }

  @Patch(':id')
  @RequirePermission('employee:update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema))
    body: UpdateEmployeeRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Employee> {
    return this.employees.update(id, body, user);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('employee:archive')
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(archiveEmployeeSchema))
    body: ArchiveEmployeeRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Employee> {
    return this.employees.archive(id, body, user);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('employee:archive')
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(archiveEmployeeSchema))
    body: ArchiveEmployeeRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Employee> {
    return this.employees.reactivate(id, body, user);
  }
}

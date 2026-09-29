import { Module } from '@nestjs/common';
import { DepartmentsController } from './departments.controller.js';
import { DepartmentsService } from './departments.service.js';

@Module({
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
})
export class DepartmentsModule {}

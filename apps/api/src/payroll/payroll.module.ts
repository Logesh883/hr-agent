import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}

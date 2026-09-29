import { Controller, Get } from '@nestjs/common';
import type { HealthStatus } from '@hr/contracts';
import { AppService } from './app.service.js';
import { Public } from './auth/auth.decorators.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get('health')
  getHealth(): HealthStatus {
    return this.appService.getHealth();
  }
}

import { Injectable } from '@nestjs/common';
import type { HealthStatus } from '@hr/contracts';

@Injectable()
export class AppService {
  getHealth(): HealthStatus {
    return {
      status: 'ok',
      service: 'hr-api',
      timestamp: new Date().toISOString(),
    };
  }
}

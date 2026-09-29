import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller.js';
import { PoliciesService } from './policies.service.js';

@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService],
})
export class PoliciesModule {}

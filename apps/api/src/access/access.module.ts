import { Module } from '@nestjs/common';
import { AccessController } from './access.controller.js';
import { AccessService } from './access.service.js';

@Module({
  controllers: [AccessController],
  providers: [AccessService],
})
export class AccessModule {}

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, PrismaPg } from '@hr/db';
import { env } from '../config/env.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: env().DATABASE_URL }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** Client handed to callbacks of `prisma.$transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

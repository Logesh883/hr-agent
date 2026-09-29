import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

async function bootstrap() {
  const config = env();
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: config.WEB_ORIGIN });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}
await bootstrap();

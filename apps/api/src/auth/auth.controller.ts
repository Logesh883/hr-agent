import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  loginRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type SessionUser,
} from '@hr/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser, Public } from './auth.decorators.js';
import { AuthService, toSessionUser } from './auth.service.js';
import type { AuthUser } from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
  ): Promise<LoginResponse> {
    return this.auth.login(body);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): SessionUser {
    return toSessionUser(user);
  }
}

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import {
  permissionsForRole,
  type AccessTokenClaims,
  type LoginRequest,
  type LoginResponse,
  type SessionUser,
} from '@hr/contracts';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth.types.js';

// Compared against when the email is unknown, so response time doesn't
// reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login({ email, password }: LoginRequest): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const valid = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !valid || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const expiresIn = env().JWT_EXPIRES_IN_SECONDS;
    const accessToken = await this.jwt.signAsync(claims, { expiresIn });

    return {
      accessToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      user: toSessionUser(user),
    };
  }
}

export function toSessionUser(user: AuthUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    employeeId: user.employeeId,
    permissions: permissionsForRole(user.role),
  };
}

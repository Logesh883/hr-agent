import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import {
  permissionsForRole,
  type AccessTokenClaims,
  type ApiError,
  type ChangePasswordBody,
  type LoginRequest,
  type LoginResponse,
  type SessionUser,
} from '@hr/contracts';
import { AuditService } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth.types.js';

// Compared against when the email is unknown, so response time doesn't
// reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
export const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
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
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issue(user);
  }

  /**
   * Replaces the caller's password (including a temporary one). Earlier
   * sessions stop working, so a fresh token is returned for this one.
   */
  async changePassword(actor: AuthUser, body: ChangePasswordBody): Promise<LoginResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      // 400, not 401: the session itself is fine.
      const error: ApiError = {
        statusCode: 400,
        message: 'Your current password is incorrect.',
        issues: [{ path: 'currentPassword', message: 'Incorrect password' }],
      };
      throw new BadRequestException(error);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS),
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        actor,
        action: user.mustChangePassword ? 'access.temporary_password_replaced' : 'access.password_changed',
        entityType: user.employeeId ? 'Employee' : 'User',
        entityId: user.employeeId ?? user.id,
      });
      return row;
    });
    return this.issue(updated);
  }

  private async issue(user: AuthUser): Promise<LoginResponse> {
    const claims: AccessTokenClaims = { sub: user.id, email: user.email, role: user.role };
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
    mustChangePassword: user.mustChangePassword,
  };
}

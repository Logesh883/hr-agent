import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenClaims } from '@hr/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';

/**
 * Global guard: every route needs a valid bearer token unless marked @Public().
 * The user is re-loaded on each request so deactivation and role changes
 * take effect immediately rather than when the token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        employeeId: true,
        isActive: true,
      },
    });
    if (!user?.isActive) {
      throw new UnauthorizedException('Account is inactive');
    }

    request.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      employeeId: user.employeeId,
    };
    return true;
  }
}

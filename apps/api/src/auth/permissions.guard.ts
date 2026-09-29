import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHasPermission, type Permission } from '@hr/contracts';
import { PERMISSIONS_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';

/** Global guard: enforces @RequirePermission() against the role map in @hr/contracts. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const missing = required.filter((p) => !roleHasPermission(user.role, p));
    if (missing.length) {
      throw new ForbiddenException(
        `Your role (${user.role}) lacks permission: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}

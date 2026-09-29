import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Permission } from '@hr/contracts';
import type { AuthenticatedRequest, AuthUser } from './auth.types.js';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';

/** Skips authentication for this route. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires the caller's role to grant every listed permission. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** The authenticated user making the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

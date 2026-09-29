import { z } from 'zod';
import type { Role } from './permissions.js';
import { ROLES } from './permissions.js';

export const grantAccessSchema = z.object({
  role: z.enum(ROLES),
});
export type GrantAccessBody = z.output<typeof grantAccessSchema>;

export const updateAccessSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, { message: 'Nothing to update' });
export type UpdateAccessBody = z.output<typeof updateAccessSchema>;

/** An employee's app login, as HR sees it. Passwords are never returned. */
export interface EmployeeAccess {
  hasAccess: boolean;
  /** Login email: always the employee's work email. */
  email: string;
  role: Role | null;
  isActive: boolean;
  /** Still on a temporary password. */
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  grantedAt: string | null;
  /** Whether the caller may change this login (not their own, and within their grantable roles). */
  canManage: boolean;
  /** Roles the caller may assign here. */
  grantableRoles: Role[];
}

/** Returned once when access is granted or a password is reset. */
export interface TemporaryPasswordResponse {
  access: EmployeeAccess;
  temporaryPassword: string;
}

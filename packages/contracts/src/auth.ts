import { z } from 'zod';
import type { Permission, Role } from './permissions.js';

export const loginRequestSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  employeeId: string | null;
  permissions: Permission[];
  /** Signed in with a temporary password; everything else is blocked until it's changed. */
  mustChangePassword: boolean;
}

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: SessionUser;
}

/** Claims carried in the API access token. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
}

/** Password rules for passwords people choose (temporary ones are generated). */
export const PASSWORD_RULES = { minLength: 10 } as const;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_RULES.minLength, `Use at least ${PASSWORD_RULES.minLength} characters`)
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: newPasswordSchema,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a different password from your current one',
  });
export type ChangePasswordBody = z.output<typeof changePasswordSchema>;

/** Error code the API returns while a temporary password is still in use. */
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

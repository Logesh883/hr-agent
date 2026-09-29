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

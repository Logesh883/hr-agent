import type { Role } from '@hr/contracts';
import type { Request } from 'express';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  employeeId: string | null;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

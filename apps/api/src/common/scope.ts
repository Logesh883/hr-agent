import { NotFoundException } from '@nestjs/common';
import { isOrgWide } from '@hr/contracts';
import type { Prisma } from '@hr/db';
import type { AuthUser } from '../auth/auth.types.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';

/**
 * Whose records a user may see, independent of what they may do with them.
 * - team: HR/admins see everyone; managers see themselves and direct reports; others see themselves.
 * - self: HR/admins see everyone; everyone else sees only themselves.
 */
export type ScopeKind = 'team' | 'self';

/** Prisma filter over employees, or undefined for "no restriction". */
export function employeeScope(
  user: AuthUser,
  kind: ScopeKind,
): Prisma.EmployeeWhereInput | undefined {
  if (isOrgWide(user.role)) return undefined;
  if (!user.employeeId) return { id: { in: [] } };
  if (kind === 'team' && user.role === 'MANAGER') {
    return { OR: [{ id: user.employeeId }, { managerId: user.employeeId }] };
  }
  return { id: user.employeeId };
}

/**
 * Throws 404 (not 403) when the employee is outside the user's scope, so the
 * API doesn't reveal which records exist.
 */
export async function assertEmployeeInScope(
  prisma: PrismaService | Tx,
  user: AuthUser,
  employeeId: string,
  kind: ScopeKind,
): Promise<void> {
  const scope = employeeScope(user, kind);
  const found = await prisma.employee.findFirst({
    where: { AND: [{ id: employeeId }, scope ?? {}] },
    select: { id: true },
  });
  if (!found) throw new NotFoundException('Employee not found');
}

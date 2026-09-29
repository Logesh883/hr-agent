export const ROLES = ['ADMIN', 'HR_OPS', 'MANAGER', 'EMPLOYEE'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'employee:read',
  'employee:create',
  'employee:update',
  'employee:archive',
  'department:read',
  'department:manage',
  'audit:read',
  /** Request leave for yourself. */
  'leave:request',
  /** Approve or reject leave (managers: direct reports only). */
  'leave:approve',
  /** See and act on everyone's leave, and request leave on someone's behalf. */
  'leave:manage',
  'onboarding:read',
  'onboarding:manage',
  'document:read',
  'document:upload',
  'document:verify',
  'attendance:read',
  'attendance:propose',
  'attendance:approve',
  'payroll:read',
  'policy:read',
  'policy:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Single source of truth for RBAC. The API enforces it; the web app only uses
 * it to hide actions the user cannot perform.
 *
 * Permissions say *what* a role may do. *Whose* records it applies to is
 * decided by data scope (see ORG_WIDE_ROLES): HR and admins see everyone,
 * managers see themselves and their direct reports (leave, attendance,
 * onboarding), and everyone else sees only their own records. Documents are
 * never team-visible: managers see only their own.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  HR_OPS: PERMISSIONS,
  MANAGER: [
    'employee:read',
    'department:read',
    'leave:request',
    'leave:approve',
    'onboarding:read',
    'document:read',
    'document:upload',
    'attendance:read',
    'attendance:propose',
    'policy:read',
  ],
  EMPLOYEE: [
    'department:read',
    'leave:request',
    'onboarding:read',
    'document:read',
    'document:upload',
    'attendance:read',
    'policy:read',
  ],
};

/** Roles whose data scope is the whole organisation. */
export const ORG_WIDE_ROLES: readonly Role[] = ['ADMIN', 'HR_OPS'];

export function isOrgWide(role: Role): boolean {
  return ORG_WIDE_ROLES.includes(role);
}

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

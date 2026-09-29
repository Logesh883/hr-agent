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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Single source of truth for RBAC. The API enforces it; the web app only uses
 * it to hide actions the user cannot perform.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  HR_OPS: [
    'employee:read',
    'employee:create',
    'employee:update',
    'employee:archive',
    'department:read',
    'department:manage',
    'audit:read',
  ],
  MANAGER: ['employee:read', 'department:read'],
  EMPLOYEE: ['department:read'],
};

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Workspace roles and the permission matrix.
 *
 * This table is the single source of truth. The API enforces it server-side on
 * every workspace-scoped route; the web and mobile clients only use it to hide
 * controls a user could not use anyway. See docs/permissions.md.
 */
export const ROLES = ['owner', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  'workspace.read': ['owner', 'developer', 'viewer'],
  'workspace.update': ['owner'],
  'workspace.delete': ['owner'],
  'members.read': ['owner', 'developer', 'viewer'],
  'members.manage': ['owner'],
  'project.create': ['owner', 'developer'],
  'project.update': ['owner', 'developer'],
  'project.delete': ['owner'],
  'app.read': ['owner', 'developer', 'viewer'],
  'app.create': ['owner', 'developer'],
  'app.update': ['owner', 'developer'],
  'app.delete': ['owner'],
  'app.lifecycle': ['owner', 'developer'],
  'deployment.read': ['owner', 'developer', 'viewer'],
  'deployment.create': ['owner', 'developer'],
  'deployment.cancel': ['owner', 'developer'],
  'deployment.rollback': ['owner', 'developer'],
  'logs.read': ['owner', 'developer', 'viewer'],
  'metrics.read': ['owner', 'developer', 'viewer'],
  'env.read': ['owner', 'developer', 'viewer'],
  'env.write': ['owner', 'developer'],
  'domain.read': ['owner', 'developer', 'viewer'],
  'domain.write': ['owner', 'developer'],
  'github.connect': ['owner'],
  'github.read': ['owner', 'developer'],
  'audit.read': ['owner', 'developer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

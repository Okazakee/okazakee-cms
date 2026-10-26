/**
 * CMS role vocabulary and hierarchy — the single source of truth shared by
 * server actions and client components.
 *
 * `editor` < `admin` < `superadmin`. `superadmin` is bootstrap-only: no CMS
 * action may grant, change, or remove it, so it can never be assigned from a
 * client payload. Client-safe: no server-only imports.
 */
export const CMS_ROLES = ['editor', 'admin', 'superadmin'] as const;

export type CmsRole = (typeof CMS_ROLES)[number];

/**
 * Runtime guard for untrusted input (server-action payloads, DB columns).
 * Only an exact role token passes: a truthy string such as 'owner' is not a
 * role and must fail closed.
 */
export function isCmsRole(value: unknown): value is CmsRole {
  return (
    typeof value === 'string' &&
    (CMS_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Admin-level access (system content, private inbox, user management):
 * admin and superadmin qualify; an editor never does.
 */
export function isCmsAdminRole(role: unknown): boolean {
  return role === 'admin' || role === 'superadmin';
}

/**
 * Who may change or remove an existing allowlist target:
 * superadmin manages admin/editor, admin manages editor only, and no role
 * (not even superadmin) may manage a superadmin row.
 */
export function canManageCmsRole(actor: CmsRole, target: CmsRole): boolean {
  if (target === 'superadmin') return false;
  if (actor === 'superadmin') return true;
  return actor === 'admin' && target === 'editor';
}

/**
 * Role assignment rules for add/role-update writes: only editor/admin are
 * assignable (superadmin is SQL-bootstrap only), and an admin may assign only
 * editor. Unknown target values fail closed.
 */
export function canAssignCmsRole(actor: CmsRole, target: unknown): boolean {
  if (!isCmsRole(target) || target === 'superadmin') return false;
  return canManageCmsRole(actor, target);
}

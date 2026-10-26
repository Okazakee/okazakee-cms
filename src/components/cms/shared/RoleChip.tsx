import { Dropdown } from '@/components/cms/shared/Dropdown';
import { canAssignCmsRole, type CmsRole } from '@/utils/cms/roles';

/**
 * Role pill for an allowlisted CMS user.
 *
 * One source of truth for how a role reads. `RoleChip` is display-only (the
 * sidebar profile card); `RoleSelect` is the same pill made editable, so an
 * admin changing a role sees the exact object the rest of the UI shows. A
 * colour or spacing change here lands in both places at once.
 *
 * The three roles are displayed, but only `editor` and `admin` are ever
 * assignable: `superadmin` is provisioned out of band, so a superadmin target
 * degrades to the read-only chip instead of an editable control.
 */
export type { CmsRole };

export type RoleChipLabels = {
  admin: string;
  editor: string;
};

/** The subset of roles a CMS action can grant. */
export type AssignableCmsRole = Exclude<CmsRole, 'superadmin'>;

const ROLE_CHIP_CLASS: Record<CmsRole, string> = {
  superadmin: 'bg-accent-violet/20 text-accent-violet',
  admin: 'bg-yellow-500/20 text-yellow-500',
  editor: 'bg-blue-500/20 text-blue-400',
};

export function roleChipClass(role: CmsRole): string {
  return `px-2 py-0.5 rounded text-xs ${ROLE_CHIP_CLASS[role]}`;
}

export function RoleChip({ cmsRole }: { cmsRole: CmsRole }) {
  return <span className={roleChipClass(cmsRole)}>{cmsRole}</span>;
}

export function RoleSelect({
  cmsRole,
  labels,
  onChange,
  disabled,
  editorDisabled,
  actorRole,
  label,
}: {
  /** Current role of the target user (may be a non-editable superadmin). */
  cmsRole: CmsRole;
  labels: RoleChipLabels;
  /** Never emits `superadmin`: that role cannot be granted by any CMS API. */
  onChange: (role: AssignableCmsRole) => void;
  disabled?: boolean;
  editorDisabled?: boolean;
  /**
   * Role of the acting user. When provided, the options (and the control for
   * an unmanageable target) are disabled by the shared role policy, so an
   * admin can never be offered the power to grant admin.
   */
  actorRole?: CmsRole;
  label?: string;
}) {
  // Nothing to select: superadmin is never a target of role management.
  if (cmsRole === 'superadmin') return <RoleChip cmsRole={cmsRole} />;

  const targetLocked = actorRole
    ? !canAssignCmsRole(actorRole, cmsRole)
    : false;
  const adminDisabled = actorRole
    ? !canAssignCmsRole(actorRole, 'admin')
    : false;

  return (
    <Dropdown
      className="relative inline-block"
      triggerClassName={roleChipClass(cmsRole)}
      label={label}
      value={cmsRole}
      disabled={disabled || targetLocked}
      onChange={(value) => onChange(value as AssignableCmsRole)}
      options={[
        { value: 'editor', label: labels.editor, disabled: editorDisabled },
        { value: 'admin', label: labels.admin, disabled: adminDisabled },
      ]}
    />
  );
}

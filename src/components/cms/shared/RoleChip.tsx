import { Dropdown } from '@/components/cms/shared/Dropdown';

/**
 * Role pill for an allowlisted CMS user.
 *
 * One source of truth for how a role reads. `RoleChip` is display-only (the
 * sidebar profile card); `RoleSelect` is the same pill made editable, so an
 * admin changing a role sees the exact object the rest of the UI shows. A
 * colour or spacing change here lands in both places at once.
 */
export type CmsRole = 'admin' | 'editor';

export type RoleChipLabels = {
  admin: string;
  editor: string;
};

export function roleChipClass(role: CmsRole): string {
  return `px-2 py-0.5 rounded text-xs ${
    role === 'admin'
      ? 'bg-yellow-500/20 text-yellow-500'
      : 'bg-blue-500/20 text-blue-400'
  }`;
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
  label,
}: {
  cmsRole: CmsRole;
  labels: RoleChipLabels;
  onChange: (role: CmsRole) => void;
  disabled?: boolean;
  editorDisabled?: boolean;
  label?: string;
}) {
  return (
    <Dropdown
      className="relative inline-block"
      triggerClassName={roleChipClass(cmsRole)}
      label={label}
      value={cmsRole}
      disabled={disabled}
      onChange={(value) => onChange(value as CmsRole)}
      options={[
        { value: 'editor', label: labels.editor, disabled: editorDisabled },
        { value: 'admin', label: labels.admin },
      ]}
    />
  );
}
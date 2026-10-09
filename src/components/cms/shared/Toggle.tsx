'use client';

/**
 * Accessible switch toggle (role="switch"). Used for boolean post flags
 * like visibility where a checkbox undersells the action.
 */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={`inline-flex min-h-11 items-center gap-3 rounded-lg px-1 py-2 text-sm font-medium transition-colors ${
        checked ? 'text-text-main' : 'text-text-muted hover:text-text-main'
      }`}
    >
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent-violet-deep' : 'bg-surface-raised'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </span>
      {label}
    </button>
  );
}

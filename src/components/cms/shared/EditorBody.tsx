'use client';

import { type ReactNode, useId } from 'react';

export const editorInputClass =
  'w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main outline-none focus:border-accent-violet';
export const editorLabelClass = 'mb-1 block text-sm font-medium text-text-main';
export const editorRowClass =
  'rounded-xl border border-border-subtle bg-surface-card p-4';
export const editorPrimaryButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent-violet-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-violet disabled:cursor-not-allowed disabled:opacity-50';
export const editorSecondaryButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-base px-4 py-2 text-sm font-medium text-text-main transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50';

interface EditorGroupProps {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Anchor id for in-page section navigation. */
  id?: string;
}

export function EditorGroup({
  title,
  description,
  count,
  actions,
  children,
  className = '',
  id,
}: EditorGroupProps) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      id={id}
      className={`rounded-2xl border border-border-subtle bg-surface-card p-4 sm:p-6 ${className}`}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 id={headingId} className="text-lg font-bold text-text-white">
              {title}
            </h2>
            {count !== undefined && (
              <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs tabular-nums text-text-muted">
                {count}
              </span>
            )}
          </div>
          {description && (
            <div className="mt-1 text-sm text-text-muted">{description}</div>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

interface EditorToolbarProps {
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  description?: ReactNode;
}

export function EditorToolbar({
  title,
  count,
  actions,
  description,
}: EditorToolbarProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-text-white">{title}</h2>
          {count !== undefined && (
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs tabular-nums text-text-muted">
              {count}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-sm text-text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

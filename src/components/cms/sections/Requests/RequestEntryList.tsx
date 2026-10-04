import { Archive, ArchiveRestore, Globe, Mail, Trash2 } from 'lucide-react';
import type { RequestEntry } from '@/types/requestEntry.types';

/** Translator for the `cms.requests.*` subtree, injected so the list renders in isolation. */
export type RequestsTranslator = (key: string) => string;

/** Per-entry archive/delete handlers, injected so the list stays presentational. */
export type RequestEntryActions = {
  setArchived: (id: string, archived: boolean) => void;
  remove: (id: string) => void;
  busyId: string | null;
};

function ActionButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  icon: typeof Mail;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'text-red-400 hover:border-red-500/60'
          : 'text-text-muted hover:border-accent-violet/50 hover:text-text-main'
      }`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function formatReceivedAt(iso: string, locale: 'en' | 'it'): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded border border-border-subtle bg-surface-raised px-2 py-0.5 font-mono text-xs text-text-muted">
      {children}
    </span>
  );
}

function LinkRow({
  href,
  children,
  icon: Icon,
}: {
  href: string;
  children: string;
  icon: typeof Mail;
}) {
  return (
    <a
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-accent-violet-light underline-offset-2 hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </a>
  );
}

/**
 * One stored request. The card displays the submitter, the browsing locale,
 * the receipt timestamp, the three option selections and the free text, and
 * owns the two inbox mutations: archive/restore and delete.
 */
function RequestEntryCard({
  entry,
  t,
  actions,
}: {
  entry: RequestEntry;
  t: RequestsTranslator;
  actions: RequestEntryActions;
}) {
  const receivedAt = formatReceivedAt(entry.createdAt, entry.locale);

  return (
    <article className="space-y-3 rounded-xl bg-surface-card p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 className="font-heading text-base font-semibold text-text-white">
            {entry.name}
          </h3>
          {entry.company && (
            <span className="truncate text-sm text-text-muted">
              {entry.company}
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-text-dim">
          <Globe className="h-3.5 w-3.5" />
          {entry.locale.toUpperCase()}
          {receivedAt && (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={entry.createdAt}>{receivedAt}</time>
            </>
          )}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <LinkRow href={`mailto:${entry.email}`} icon={Mail}>
          {entry.email}
        </LinkRow>
        {entry.website && (
          <LinkRow href={entry.website} icon={Globe}>
            {entry.website}
          </LinkRow>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip>{entry.type}</Chip>
        <Chip>{entry.budget}</Chip>
        <Chip>{entry.timeline}</Chip>
        {entry.archived && <Chip>{t('archivedBadge')}</Chip>}
      </div>

      {entry.request && (
        <p className="border-l-2 border-border-subtle pl-3 text-sm leading-relaxed whitespace-pre-wrap text-text-main">
          {entry.request}
        </p>
      )}

      <p className="font-mono text-xs text-text-dim">
        {t(entry.consent ? 'consentGiven' : 'consentMissing')}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-3">
        <ActionButton
          disabled={actions.busyId === entry.id}
          icon={entry.archived ? ArchiveRestore : Archive}
          label={t(entry.archived ? 'restore' : 'archive')}
          onClick={() => actions.setArchived(entry.id, !entry.archived)}
        />
        <ActionButton
          danger
          disabled={actions.busyId === entry.id}
          icon={Trash2}
          label={t('delete')}
          onClick={() => actions.remove(entry.id)}
        />
      </div>
    </article>
  );
}

export function RequestEntryList({
  entries,
  t,
  actions,
}: {
  entries: RequestEntry[];
  t: RequestsTranslator;
  actions: RequestEntryActions;
}) {
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <RequestEntryCard
          actions={actions}
          entry={entry}
          key={entry.id}
          t={t}
        />
      ))}
    </div>
  );
}

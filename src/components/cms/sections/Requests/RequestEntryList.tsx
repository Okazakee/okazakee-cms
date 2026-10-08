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
      className={`inline-flex min-h-11 items-center gap-1 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
 * One stored request as a compact summary row: the submitter identity, the
 * browsing locale, the receipt timestamp and the option chips stay visible,
 * while the contact links, the free text and the consent line expand through
 * a native details/summary. Archive/restore and delete sit in the summary row
 * so both inbox mutations stay reachable without expanding, and both commit
 * immediately rather than through Publish All.
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
  const busy = actions.busyId === entry.id;

  return (
    <article className="rounded-xl bg-surface-card p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
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
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-text-dim">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            {entry.locale.toUpperCase()}
            {receivedAt && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={entry.createdAt}>{receivedAt}</time>
              </>
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Chip>{entry.type}</Chip>
            <Chip>{entry.budget}</Chip>
            <Chip>{entry.timeline}</Chip>
            {entry.archived && <Chip>{t('archivedBadge')}</Chip>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ActionButton
            disabled={busy}
            icon={entry.archived ? ArchiveRestore : Archive}
            label={t(entry.archived ? 'restore' : 'archive')}
            onClick={() => actions.setArchived(entry.id, !entry.archived)}
          />
          <ActionButton
            danger
            disabled={busy}
            icon={Trash2}
            label={t('delete')}
            onClick={() => actions.remove(entry.id)}
          />
        </div>
      </div>

      <details className="mt-2 border-t border-border-subtle pt-2">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted transition-colors hover:text-text-main">
          {t('details')}
        </summary>
        <div className="space-y-3 pt-3">
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
          {entry.request && (
            <p className="border-l-2 border-border-subtle pl-3 text-sm leading-relaxed whitespace-pre-wrap text-text-main">
              {entry.request}
            </p>
          )}
          <p className="font-mono text-xs text-text-dim">
            {t(entry.consent ? 'consentGiven' : 'consentMissing')}
          </p>
        </div>
      </details>
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

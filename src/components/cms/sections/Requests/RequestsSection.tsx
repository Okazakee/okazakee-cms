'use client';

import { Inbox } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { EditorToolbar } from '@/components/cms/shared/EditorBody';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useRequestEntries } from '@/hooks/cms/useRequestEntries';
import type { RequestEntryFilter } from '@/types/requestEntry.types';
import { RequestEntryList } from './RequestEntryList';

/**
 * Incoming project requests: the real inbox.
 *
 * Reads and mutates through `useRequestEntries` (admin-only Server Actions —
 * the section registers no publish callback, because archiving and deleting
 * commit immediately rather than through Publish All).
 *
 * A failed load renders as an error, never as "no requests yet": an absent
 * table or a denied grant must be visible instead of looking like an empty
 * inbox.
 */
export default function RequestsSection() {
  const t = useTranslations('cms');
  const {
    entries,
    filter,
    isLoading,
    error,
    setFilter,
    setArchived,
    clearError,
    remove,
  } = useRequestEntries();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const tr = (key: string) => t(`requests.${key}`);

  const run = useCallback(
    async (id: string, action: () => Promise<string | null>) => {
      setBusyId(id);
      await action();
      setBusyId(null);
    },
    []
  );

  const confirmDelete = useCallback(() => {
    const id = pendingDeleteId;

    if (id === null) return;
    setPendingDeleteId(null);
    void run(id, () => remove(id));
  }, [pendingDeleteId, remove, run]);

  const filters: RequestEntryFilter[] = ['active', 'archived'];

  return (
    <div className="space-y-6">
      <SectionHeader title={tr('title')} description={tr('subtitle')} />

      <EditorToolbar
        actions={
          <div className="flex gap-2">
            {filters.map((value) => (
              <button
                aria-pressed={filter === value}
                className={`min-h-11 rounded-lg border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${
                  filter === value
                    ? 'border-accent-violet/60 bg-accent-violet text-text-on-accent'
                    : 'border-border-subtle bg-surface-raised text-text-muted hover:text-text-main'
                }`}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {tr(value === 'active' ? 'filterActive' : 'filterArchived')}
              </button>
            ))}
          </div>
        }
        count={entries.length}
        description={t('editor.immediateHint')}
        title={tr(filter === 'active' ? 'filterActive' : 'filterArchived')}
      />

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      {isLoading ? (
        <p className="text-center text-sm text-text-dim" role="status">
          {tr('loading')}
        </p>
      ) : error && entries.length === 0 ? null : entries.length === 0 ? (
        <EmptyState
          icon={Inbox}
          message={tr(filter === 'active' ? 'emptyActive' : 'emptyArchived')}
        />
      ) : (
        <RequestEntryList
          actions={{
            busyId,
            remove: (id) => setPendingDeleteId(id),
            setArchived: (id, archived) => {
              void run(id, () => setArchived(id, archived));
            },
          }}
          entries={entries}
          t={tr}
        />
      )}

      <ConfirmDialog
        confirmLabel={tr('confirmDelete')}
        isOpen={pendingDeleteId !== null}
        message={tr('confirmDeleteMessage')}
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={confirmDelete}
        title={tr('deleteTitle')}
      />
    </div>
  );
}

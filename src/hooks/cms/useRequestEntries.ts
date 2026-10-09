'use client';

import { useCallback, useEffect, useState } from 'react';
import { requestEntriesActions } from '@/app/actions/cms/sections/requestEntriesActions';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { demoRequests } from '@/libs/demo/fixtures';
import { useCmsStore } from '@/store/cmsStore';
import type {
  RequestEntry,
  RequestEntryFilter,
} from '@/types/requestEntry.types';

export type RequestEntriesState = {
  entries: RequestEntry[];
  filter: RequestEntryFilter;
  isLoading: boolean;
  /** Last load or mutation error, already actionable for the UI. */
  error: string | null;
  setFilter: (filter: RequestEntryFilter) => void;
  /** Archive (true) or restore (false) one entry. Resolves to the error, or null. */
  setArchived: (id: string, archived: boolean) => Promise<string | null>;
  /** Permanently delete one entry. Resolves to the error, or null. */
  remove: (id: string) => Promise<string | null>;
  /** Clears the last load/mutation error without reloading. */
  clearError: () => void;
  reload: () => Promise<void>;
};

/**
 * Loads the project-request inbox and owns its archive/delete mutations.
 *
 * There are no local drafts here: archiving and deleting are direct,
 * single-row mutations, so this hook commits through the Server Action and
 * then reconciles from the returned commit evidence instead of registering a
 * Publish All callback (`useSectionCallbacks` / `useSectionDirty` would only
 * invent a draft model the section does not have).
 *
 * Load ordering goes through `useLatestRequest`: a stale list must never
 * replace a newer one nor clear its spinner after a filter switch.
 */
export function useRequestEntries(): RequestEntriesState {
  const [entries, setEntries] = useState<RequestEntry[]>([]);
  const [filter, setFilterState] = useState<RequestEntryFilter>('active');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const beginLoad = useLatestRequest();
  const demoMode = useCmsStore((state) => state.demoMode);

  const applyDemoFilter = useCallback((nextFilter: RequestEntryFilter) => {
    setEntries(
      demoRequests.filter((entry) =>
        nextFilter === 'active' ? !entry.archived : entry.archived
      )
    );
    setIsLoading(false);
    setError(null);
  }, []);

  const load = useCallback(
    async (nextFilter: RequestEntryFilter) => {
      const current = beginLoad();
      setIsLoading(true);
      setError(null);
      try {
        const result = await requestEntriesActions({
          type: 'LIST',
          filter: nextFilter,
        });
        if (!current()) return;
        if (!result.success) {
          // A missing table or a denied grant must read as a failure here,
          // never as an empty inbox.
          setError(result.error ?? 'Failed to load project requests');
          return;
        }
        const rows = Array.isArray(result.data) ? result.data : [];
        setEntries(rows);
        if (result.malformed && result.malformed.length > 0) {
          setError(
            `${result.malformed.length} stored request(s) could not be read and are not listed.`
          );
        }
      } catch (err) {
        if (!current()) return;
        setError(
          err instanceof Error ? err.message : 'Failed to load project requests'
        );
      } finally {
        if (current()) setIsLoading(false);
      }
    },
    [beginLoad]
  );

  useEffect(() => {
    if (demoMode) {
      applyDemoFilter(filter);
      return;
    }
    void load(filter);
  }, [filter, load, demoMode, applyDemoFilter]);

  const setFilter = useCallback((next: RequestEntryFilter) => {
    setFilterState(next);
  }, []);

  const setArchived = useCallback(
    async (id: string, archived: boolean) => {
      if (useCmsStore.getState().demoMode) {
        // Offline showcase: flip locally; the row leaves this filter slice.
        await new Promise((resolve) => setTimeout(resolve, 250));
        setError(null);
        setEntries((previous) =>
          previous
            .map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    archived,
                    archivedAt: archived
                      ? new Date().toISOString()
                      : null,
                  }
                : entry
            )
            .filter((entry) => entry.id !== id)
        );
        return null;
      }
      const rowId = Number.parseInt(id, 10);
      setError(null);
      const result = await requestEntriesActions({
        type: 'ARCHIVE',
        id: rowId,
        archived,
      });
      if (!result.success) {
        const message = result.error ?? 'Failed to update the request';
        setError(message);
        return message;
      }
      // The row left this filter's slice: drop it locally rather than
      // refetching a list that no longer contains it.
      setEntries((previous) => previous.filter((entry) => entry.id !== id));
      return null;
    },
    []
  );

  const remove = useCallback(
    async (id: string) => {
      if (useCmsStore.getState().demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        setError(null);
        setEntries((previous) =>
          previous.filter((entry) => entry.id !== id)
        );
        return null;
      }
      const rowId = Number.parseInt(id, 10);
      setError(null);
      const result = await requestEntriesActions({
        type: 'DELETE',
        id: rowId,
      });
      if (!result.success) {
        const message = result.error ?? 'Failed to delete the request';
        setError(message);
        return message;
      }
      setEntries((previous) => previous.filter((entry) => entry.id !== id));
      return null;
    },
    []
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    entries,
    filter,
    isLoading,
    error,
    setFilter,
    setArchived,
    remove,
    clearError,
    reload: () => load(filter),
  };
}

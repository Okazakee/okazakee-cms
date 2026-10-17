'use client';

import { useCallback, useState } from 'react';
import type { LoadedBodies } from '@/hooks/cms/postBodyState';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';

/**
 * Phase 9B: per-post Markdown loading for the CMS editors.
 *
 * One shared implementation of the editor loading safety rules:
 * - only the latest request may populate the editor (a response for a post the
 *   user has already left is dropped);
 * - the response id must match the requested post;
 * - a failure NEVER yields a body: the caller gets `null` and must keep the
 *   editor closed, so a missing body can never become an empty-body save;
 * - the caller can retry by calling `load` again.
 */

export type BodyLoadFailure = { id: number; error: string };

export type PostBodiesLoader = (
  id: number
) => Promise<{ success: boolean; data?: unknown; error?: string }>;

/** Editor-facing surface of the shared loader. */
export type PostBodiesLoaderApi = {
  /** Post id whose bodies are in flight, or null. */
  loadingId: number | null;
  /** Last failed body load, for the editor banner / retry affordance. */
  failure: BodyLoadFailure | null;
  /** Resolves the bodies, or null on any failure (never an empty body). */
  load: (id: number) => Promise<LoadedBodies | null>;
  clearFailure: () => void;
};

export function usePostBodies(
  fetcher: PostBodiesLoader
): PostBodiesLoaderApi {
  const beginLoad = useLatestRequest();
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [failure, setFailure] = useState<BodyLoadFailure | null>(null);

  const load = useCallback(
    async (id: number): Promise<LoadedBodies | null> => {
      const current = beginLoad();
      setLoadingId(id);
      setFailure(null);
      try {
        const result = await fetcher(id);
        // A superseded request (another post opened, editor closed, unmount)
        // must not touch editor state or clear a newer spinner.
        if (!current()) return null;
        if (!result.success) {
          setFailure({ id, error: result.error ?? 'Failed to load markdown' });
          setLoadingId(null);
          return null;
        }
        const data = result.data as
          | { id?: unknown; body_en?: unknown; body_it?: unknown }
          | undefined;
        if (
          !data ||
          data.id !== id ||
          typeof data.body_en !== 'string' ||
          typeof data.body_it !== 'string'
        ) {
          setFailure({ id, error: 'Unexpected markdown response' });
          setLoadingId(null);
          return null;
        }
        setLoadingId(null);
        return { en: data.body_en, it: data.body_it };
      } catch (error) {
        if (current()) {
          setFailure({
            id,
            error: error instanceof Error ? error.message : 'Failed to load markdown',
          });
          setLoadingId(null);
        }
        return null;
      }
    },
    [beginLoad, fetcher]
  );

  const clearFailure = useCallback(() => setFailure(null), []);

  return {
    /** Post id whose bodies are in flight, or null. */
    loadingId,
    /** Last failed body load, for the editor banner / retry affordance. */
    failure,
    load,
    clearFailure,
  };
}

'use client';

import { useEffect, useRef } from 'react';
import { useCmsStore } from '@/store/cmsStore';

/**
 * Registers a section's publish/revert handlers in the global store keyed by
 * section. `publishAll` then runs every dirty section sequentially. The
 * handlers are kept in refs so changing callbacks never re-registers (and
 * never churns the publish queue).
 */
export function useSectionCallbacks(
  sectionKey: string,
  publish: () => Promise<void>,
  revert: () => void
) {
  const publishRef = useRef(publish);
  const revertRef = useRef(revert);
  publishRef.current = publish;
  revertRef.current = revert;

  useEffect(() => {
    useCmsStore.getState().registerSectionCallbacks(sectionKey, {
      publish: () => publishRef.current(),
      revert: () => revertRef.current(),
    });
    return () => {
      useCmsStore.getState().unregisterSectionCallbacks(sectionKey);
    };
  }, [sectionKey]);
}

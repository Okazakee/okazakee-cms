'use client';

import { useEffect, useRef } from 'react';
import { useCmsStore } from '@/store/cmsStore';

export function useSectionCallbacks(publish: () => Promise<void>, revert: () => void) {
  const publishRef = useRef(publish);
  const revertRef = useRef(revert);
  publishRef.current = publish;
  revertRef.current = revert;

  useEffect(() => {
    const store = useCmsStore.getState();
    store.setSectionCallbacks(
      async () => publishRef.current(),
      () => revertRef.current()
    );
    return () => {
      useCmsStore.getState().clearSectionCallbacks();
    };
  }, []);
}

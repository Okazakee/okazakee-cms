'use client';

import { useEffect, useRef } from 'react';
import { useLayoutStore } from '@/store/layoutStore';

export function useSectionCallbacks(publish: () => Promise<void>, revert: () => void) {
  const publishRef = useRef(publish);
  const revertRef = useRef(revert);
  publishRef.current = publish;
  revertRef.current = revert;

  useEffect(() => {
    const store = useLayoutStore.getState();
    store.setSectionCallbacks(
      async () => publishRef.current(),
      () => revertRef.current()
    );
    return () => {
      useLayoutStore.getState().clearSectionCallbacks();
    };
  }, []);
}

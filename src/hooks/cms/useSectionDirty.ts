'use client';

import { useEffect } from 'react';
import { useLayoutStore } from '@/store/layoutStore';

export function useSectionDirty(sectionKey: string, isDirty: boolean) {
  const register = useLayoutStore((s) => s.registerPublishState);
  const unregister = useLayoutStore((s) => s.unregisterPublishState);

  useEffect(() => {
    if (!isDirty) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  useEffect(() => {
    register(sectionKey, {
      isDirty,
      changeCount: isDirty ? 1 : 0,
      lastModified: Date.now(),
    });
  }, [sectionKey, isDirty, register]);

  useEffect(() => {
    return () => unregister(sectionKey);
  }, [sectionKey, unregister]);
}

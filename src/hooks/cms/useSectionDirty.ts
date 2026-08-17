'use client';

import { useEffect } from 'react';
import { useCmsStore } from '@/store/cmsStore';

export function useSectionDirty(sectionKey: string, isDirty: boolean) {
  const register = useCmsStore((s) => s.registerPublishState);
  const unregister = useCmsStore((s) => s.unregisterPublishState);

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

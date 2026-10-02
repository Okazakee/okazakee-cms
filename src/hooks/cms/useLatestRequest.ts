'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Only the latest live load may replace editor state or clear its spinner. */
export function useLatestRequest() {
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  return useCallback(() => {
    const request = ++sequence.current;
    return () => mounted.current && sequence.current === request;
  }, []);
}

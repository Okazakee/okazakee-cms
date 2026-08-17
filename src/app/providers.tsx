'use client';

import type React from 'react';
import { useEffect } from 'react';
import useThemeStore from '../store/themeStore';

type IdleHandle = number | ReturnType<typeof setTimeout>;
type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback) => IdleHandle;
  cancelIdleCallback?: (handle: IdleHandle) => void;
};

const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { initializeTheme } = useThemeStore();

  useEffect(() => {
    const idleWindow = window as IdleWindow;
    let idleHandle: IdleHandle;

    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleHandle = idleWindow.requestIdleCallback(() => initializeTheme());

      return () => idleWindow.cancelIdleCallback?.(idleHandle);
    }

    idleHandle = globalThis.setTimeout(() => initializeTheme(), 1);
    return () => globalThis.clearTimeout(idleHandle);
  }, [initializeTheme]);

  useEffect(() => {
    const pathLocale = window.location.pathname.split('/')[1];
    if (['en', 'it'].includes(pathLocale)) {
      document.documentElement.lang = pathLocale;
    }
  }, []);

  return <>{children}</>;
};

export function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

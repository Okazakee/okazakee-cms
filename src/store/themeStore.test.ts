// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import useThemeStore from '@/store/themeStore';

type ChangeListener = (event: { matches: boolean }) => void;

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  listeners: Set<ChangeListener>;
  addEventListener: (type: string, listener: ChangeListener) => void;
  removeEventListener: (type: string, listener: ChangeListener) => void;
  addListener: (listener: ChangeListener) => void;
  removeListener: (listener: ChangeListener) => void;
}

const createFakeMediaQuery = (matches: boolean): FakeMediaQueryList => {
  const listeners = new Set<ChangeListener>();
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    listeners,
    addEventListener: (_type: string, listener: ChangeListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: ChangeListener) => {
      listeners.delete(listener);
    },
    addListener: (listener: ChangeListener) => {
      listeners.add(listener);
    },
    removeListener: (listener: ChangeListener) => {
      listeners.delete(listener);
    },
  };
};

const installFakeMediaQuery = (matches: boolean): FakeMediaQueryList => {
  const fake = createFakeMediaQuery(matches);
  // The store only reads `.matches` and the listener methods.
  window.matchMedia = (() => fake) as unknown as typeof window.matchMedia;
  return fake;
};

const clearCookies = (): void => {
  document.cookie.split(';').forEach((pair) => {
    const key = pair.split('=')[0]?.trim();
    if (key) {
      document.cookie = `${key}=; path=/; max-age=0`;
    }
  });
};

const dispatchSystemChange = (
  fake: FakeMediaQueryList,
  matches: boolean
): void => {
  fake.matches = matches;
  fake.listeners.forEach((listener) => {
    listener({ matches });
  });
};

describe('themeStore DOM application', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    clearCookies();
    useThemeStore.setState({ mode: 'auto', isDark: false });
    installFakeMediaQuery(false);
  });

  it('applies the dark class on setThemeMode("dark")', () => {
    useThemeStore.getState().setThemeMode('dark');

    expect(useThemeStore.getState().mode).toBe('dark');
    expect(useThemeStore.getState().isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes the dark class on setThemeMode("light")', () => {
    useThemeStore.getState().setThemeMode('dark');
    useThemeStore.getState().setThemeMode('light');

    expect(useThemeStore.getState().mode).toBe('light');
    expect(useThemeStore.getState().isDark).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applies dark when auto mode and the system prefers dark', () => {
    localStorage.setItem('themeMode', 'auto');
    installFakeMediaQuery(true);
    useThemeStore.getState().initializeTheme();

    expect(useThemeStore.getState().mode).toBe('auto');
    expect(useThemeStore.getState().isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not apply dark when auto mode and the system prefers light', () => {
    localStorage.setItem('themeMode', 'auto');
    installFakeMediaQuery(false);
    useThemeStore.getState().initializeTheme();

    expect(useThemeStore.getState().isDark).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('updates the DOM class immediately when the system preference changes', () => {
    localStorage.setItem('themeMode', 'auto');
    const fake = installFakeMediaQuery(false);
    useThemeStore.getState().initializeTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    dispatchSystemChange(fake, true);
    expect(useThemeStore.getState().isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.cookie).toContain('resolvedTheme=dark');

    dispatchSystemChange(fake, false);
    expect(useThemeStore.getState().isDark).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.cookie).toContain('resolvedTheme=light');
  });

  it('ignores system changes when not in auto mode', () => {
    localStorage.setItem('themeMode', 'auto');
    const fake = installFakeMediaQuery(false);
    useThemeStore.getState().initializeTheme();
    useThemeStore.getState().setThemeMode('dark');

    dispatchSystemChange(fake, false);
    expect(useThemeStore.getState().isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists mode and resolved theme to localStorage and cookies', () => {
    useThemeStore.getState().setThemeMode('dark');
    expect(localStorage.getItem('themeMode')).toBe('dark');
    expect(document.cookie).toContain('themeMode=dark');
    expect(document.cookie).toContain('resolvedTheme=dark');

    useThemeStore.getState().setThemeMode('light');
    expect(localStorage.getItem('themeMode')).toBe('light');
    expect(document.cookie).toContain('themeMode=light');
    expect(document.cookie).toContain('resolvedTheme=light');
  });

  it('toggles between light and dark with the DOM class', () => {
    useThemeStore.getState().setThemeMode('light');
    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().mode).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('initializes from the system preference on first visit', () => {
    installFakeMediaQuery(true);
    useThemeStore.getState().initializeTheme();

    expect(useThemeStore.getState().mode).toBe('dark');
    expect(localStorage.getItem('themeMode')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies the theme synchronously without reload or navigation', () => {
    const reloadSpy = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => {});

    useThemeStore.getState().setThemeMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    useThemeStore.getState().setThemeMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does not leak duplicate matchMedia listeners when initialized twice', () => {
    localStorage.setItem('themeMode', 'auto');
    const fake = installFakeMediaQuery(false);

    useThemeStore.getState().initializeTheme();
    useThemeStore.getState().initializeTheme();

    expect(fake.listeners.size).toBe(1);
  });

  it('falls back to legacy addListener when addEventListener is missing', () => {
    localStorage.setItem('themeMode', 'auto');
    const fake = createFakeMediaQuery(false);
    // Simulate a legacy MediaQueryList that only supports addListener.
    const legacyView = fake as {
      addEventListener?: unknown;
      removeEventListener?: unknown;
    };
    delete legacyView.addEventListener;
    delete legacyView.removeEventListener;
    window.matchMedia = (() => fake) as unknown as typeof window.matchMedia;

    useThemeStore.getState().initializeTheme();
    expect(fake.listeners.size).toBe(1);

    dispatchSystemChange(fake, true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

import { create } from 'zustand';

export type ThemeMode = 'auto' | 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  initializeTheme: () => void;
}

type LegacyMediaQueryList = Omit<
  MediaQueryList,
  'addListener' | 'removeListener'
> & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

const cookieMaxAge = 365 * 24 * 60 * 60;

// Handles from the most recent initializeTheme() run. Re-initialization
// detaches the previous listener before attaching a new one, so repeated
// calls (e.g. provider remounts) never leak duplicate matchMedia listeners.
let mediaQuery: LegacyMediaQueryList | null = null;
let mediaChangeHandler: (() => void) | null = null;

const useThemeStore = create<ThemeState>((set, get) => {
  // Canonical theme application: mirror the resolved theme onto the DOM so
  // Tailwind's `darkMode: 'selector'` (`dark:` variants) follows without a
  // reload. The blocking pre-paint script in the layout applies the same
  // class for the first paint.
  const applyResolvedTheme = (isDark: boolean): void => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', isDark);
  };

  const writeModeCookie = (mode: ThemeMode): void => {
    if (typeof document === 'undefined') return;
    document.cookie = `themeMode=${mode}; path=/; max-age=${cookieMaxAge}`;
  };

  const writeResolvedThemeCookie = (isDark: boolean): void => {
    if (typeof document === 'undefined') return;
    const resolvedTheme = isDark ? 'dark' : 'light';
    document.cookie = `resolvedTheme=${resolvedTheme}; path=/; max-age=${cookieMaxAge}`;
  };

  // Helper function to determine if dark mode is active
  const isDarkActive = (mode: ThemeMode): boolean => {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    // For 'auto' mode, check system preference
    return (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  };

  // Initialize with safe defaults for SSR
  const initialMode: ThemeMode = 'auto';
  const initialIsDark = false; // Safe default for SSR

  return {
    mode: initialMode,
    isDark: initialIsDark,

    initializeTheme: () => {
      if (typeof window === 'undefined') return;

      // Get stored mode or default to 'auto'
      const storedMode = localStorage.getItem('themeMode') as ThemeMode;
      let mode: ThemeMode;

      if (storedMode && ['auto', 'light', 'dark'].includes(storedMode)) {
        // User has a saved preference
        mode = storedMode;
      } else {
        // First-time user - detect system preference
        const systemPrefersDark = window.matchMedia(
          '(prefers-color-scheme: dark)'
        ).matches;
        mode = systemPrefersDark ? 'dark' : 'light';
        // Save system preference to localStorage
        localStorage.setItem('themeMode', mode);
      }

      const isDark = isDarkActive(mode);
      set({ mode, isDark });
      applyResolvedTheme(isDark);

      // Sync with cookie for SSR - store the resolved theme, not the mode
      writeModeCookie(mode);
      writeResolvedThemeCookie(isDark);

      // Detach any listener from a previous initialization before
      // registering a new one (prevents duplicate matchMedia listeners).
      if (mediaQuery && mediaChangeHandler) {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', mediaChangeHandler);
        } else if (typeof mediaQuery.removeListener === 'function') {
          mediaQuery.removeListener(mediaChangeHandler);
        }
      }

      // Listen for system theme changes when in auto mode
      const newMediaQuery = window.matchMedia(
        '(prefers-color-scheme: dark)'
      ) as LegacyMediaQueryList;
      const handleSystemThemeChange = () => {
        if (get().mode !== 'auto') return;
        const isDark = newMediaQuery.matches;
        set({ isDark });
        applyResolvedTheme(isDark);
        writeResolvedThemeCookie(isDark);
      };

      mediaQuery = newMediaQuery;
      mediaChangeHandler = handleSystemThemeChange;

      if (typeof newMediaQuery.addEventListener === 'function') {
        newMediaQuery.addEventListener('change', handleSystemThemeChange);
        return;
      }

      if (typeof newMediaQuery.addListener === 'function') {
        newMediaQuery.addListener(handleSystemThemeChange);
      }
    },

    setThemeMode: (newMode: ThemeMode) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('themeMode', newMode);
        // Also set cookie for SSR
        writeModeCookie(newMode);
      }
      const isDark = isDarkActive(newMode);
      set({ mode: newMode, isDark });
      applyResolvedTheme(isDark);
      writeResolvedThemeCookie(isDark);
    },

    toggleTheme: () => {
      const { mode } = get();
      const newMode: ThemeMode = mode === 'light' ? 'dark' : 'light';
      if (typeof window !== 'undefined') {
        localStorage.setItem('themeMode', newMode);
        // Also set cookie for SSR
        writeModeCookie(newMode);
      }
      const isDark = isDarkActive(newMode);
      set({ mode: newMode, isDark });
      applyResolvedTheme(isDark);
      writeResolvedThemeCookie(isDark);
    },
  };
});

export default useThemeStore;

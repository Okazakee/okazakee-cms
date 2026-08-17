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

const useThemeStore = create<ThemeState>((set, get) => {
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

      // Sync with cookie for SSR - store the resolved theme, not the mode
      const resolvedTheme = isDark ? 'dark' : 'light';
      document.cookie = `themeMode=${mode}; path=/; max-age=${365 * 24 * 60 * 60}`;
      document.cookie = `resolvedTheme=${resolvedTheme}; path=/; max-age=${365 * 24 * 60 * 60}`;

      // Listen for system theme changes when in auto mode
      const mediaQuery = window.matchMedia(
        '(prefers-color-scheme: dark)'
      ) as LegacyMediaQueryList;
      const handleSystemThemeChange = () => {
        const currentMode = get().mode;
        if (currentMode === 'auto') {
          const isDark = mediaQuery.matches;
          set({ isDark });
          // Update resolved theme cookie
          const resolvedTheme = isDark ? 'dark' : 'light';
          document.cookie = `resolvedTheme=${resolvedTheme}; path=/; max-age=${365 * 24 * 60 * 60}`;
        }
      };

      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleSystemThemeChange);
        return;
      }

      if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handleSystemThemeChange);
      }
    },

    setThemeMode: (newMode: ThemeMode) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('themeMode', newMode);
        // Also set cookie for SSR
        document.cookie = `themeMode=${newMode}; path=/; max-age=${365 * 24 * 60 * 60}`;
      }
      const isDark = isDarkActive(newMode);
      set({ mode: newMode, isDark });

      // Update resolved theme cookie
      if (typeof window !== 'undefined') {
        const resolvedTheme = isDark ? 'dark' : 'light';
        document.cookie = `resolvedTheme=${resolvedTheme}; path=/; max-age=${365 * 24 * 60 * 60}`;
      }
    },

    toggleTheme: () => {
      const { mode } = get();
      const newMode: ThemeMode = mode === 'light' ? 'dark' : 'light';
      if (typeof window !== 'undefined') {
        localStorage.setItem('themeMode', newMode);
        // Also set cookie for SSR
        document.cookie = `themeMode=${newMode}; path=/; max-age=${365 * 24 * 60 * 60}`;
      }
      const isDark = isDarkActive(newMode);
      set({ mode: newMode, isDark });

      // Update resolved theme cookie
      if (typeof window !== 'undefined') {
        const resolvedTheme = isDark ? 'dark' : 'light';
        document.cookie = `resolvedTheme=${resolvedTheme}; path=/; max-age=${365 * 24 * 60 * 60}`;
      }
    },
  };
});

export default useThemeStore;

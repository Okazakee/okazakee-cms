import { create } from 'zustand';
import type { AppLocale } from '@/i18n/routing';

interface UiLocaleState {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  initializeLocale: () => void;
}

const STORAGE_KEY = 'cms_ui_locale';

// CMS UI language without URL locales: the selector mutates this store and
// CmsIntlProvider re-renders every useTranslations() consumer. SSR-safe
// default ('en'); the persisted choice is applied after mount (same pattern
// as themeStore, so hydration always matches).
const useUiLocaleStore = create<UiLocaleState>((set) => ({
  locale: 'en',
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Private mode / storage full: keep the in-memory switch only.
    }
    set({ locale });
  },
  initializeLocale: () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'it') {
        set({ locale: stored });
      }
    } catch {
      // Storage unavailable: default locale stays.
    }
  },
}));

export default useUiLocaleStore;

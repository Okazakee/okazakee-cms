'use client';

import { Languages } from 'lucide-react';
import type { AppLocale } from '@/i18n/routing';
import useUiLocaleStore from '@/store/uiLocaleStore';

// CMS UI language selector. Switching mutates uiLocaleStore: CmsIntlProvider
// re-renders every useTranslations() consumer in place — no navigation, no
// URL locale. The choice persists in localStorage (cms_ui_locale).
export default function LanguageToggle({
  compact = false,
  sidebar = false,
}: {
  compact?: boolean;
  sidebar?: boolean;
}) {
  const locale = useUiLocaleStore((s) => s.locale);
  const setLocale = useUiLocaleStore((s) => s.setLocale);
  const isItalian = locale === 'it';

  const switchLanguage = () => {
    const newLocale: AppLocale = isItalian ? 'en' : 'it';
    setLocale(newLocale);
  };

  if (sidebar) {
    return (
      <button
        type="button"
        onClick={switchLanguage}
        className="w-full flex items-center gap-3 p-3 rounded-lg bg-surface-card hover:bg-surface-raised text-text-main hover:text-text-main transition-all duration-200"
        data-umami-event="Language toggle"
      >
        <Languages className="w-4 h-4 flex-shrink-0" />
        <span className="font-medium text-sm truncate">
          {isItalian ? 'Italiano' : 'English'}
        </span>
      </button>
    );
  }

  // Use compact styling when in desktop header
  const buttonClass = compact
    ? 'flex items-center justify-center border-2 border-accent-violet rounded-2xl transition-all duration-300 ease-in-out w-fit px-3 h-10'
    : 'space-x-2 relative flex justify-center items-center border-2 border-white rounded-2xl transition-all duration-300 ease-in-out h-16 w-48 lg:h-10 lg:w-32 lg:border-accent-violet';

  return (
    <button
      type="button"
      onClick={switchLanguage}
      className={buttonClass}
      data-umami-event="Language toggle"
    >
      {compact ? (
        <span className="text-sm font-medium text-text-main transition-all duration-300 ease-in-out">
          {isItalian ? 'IT' : 'EN'}
        </span>
      ) : (
        <div className="text-xl lg:text-lg text-text-main transition-all duration-300 ease-in-out flex items-center justify-center w-full">
          {isItalian ? 'Italiano' : 'English'}
        </div>
      )}
    </button>
  );
}

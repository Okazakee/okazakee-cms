'use client';

import { Languages } from 'lucide-react';
import useUiLocaleStore from '@/store/uiLocaleStore';
import type { AppLocale } from '@/i18n/routing';

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
        className="w-full flex items-center gap-3 p-3 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-darkergray dark:hover:bg-darkgray text-darktext dark:text-lighttext hover:text-darktext dark:hover:text-white transition-all duration-200"
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
    ? 'flex items-center justify-center border-2 border-main rounded-2xl transition-all duration-300 ease-in-out w-fit px-3 h-10'
    : 'space-x-2 relative flex justify-center items-center border-2 border-white dark:border-white rounded-2xl transition-all duration-300 ease-in-out h-16 w-48 lg:h-10 lg:w-32 lg:border-main';

  return (
    <button
      type="button"
      onClick={switchLanguage}
      className={buttonClass}
      data-umami-event="Language toggle"
    >
      {compact ? (
        <span className="text-sm font-medium text-darktext dark:text-lighttext transition-all duration-300 ease-in-out">
          {isItalian ? 'IT' : 'EN'}
        </span>
      ) : (
        <div className="text-xl lg:text-lg text-darktext dark:text-lighttext dark:text-lighttext transition-all duration-300 ease-in-out flex items-center justify-center w-full">
          {isItalian ? 'Italiano' : 'English'}
        </div>
      )}
    </button>
  );
}

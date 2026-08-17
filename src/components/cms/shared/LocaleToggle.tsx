'use client';

import { useTranslations } from 'next-intl';

interface LocaleToggleProps {
  activeLocale: 'en' | 'it';
  onChange: (locale: 'en' | 'it') => void;
}

export function LocaleToggle({ activeLocale, onChange }: LocaleToggleProps) {
  const t = useTranslations('cms');

  return (
    <div className="flex gap-1 bg-gray-200 dark:bg-darkgray rounded-lg p-0.5">
      {(['en', 'it'] as const).map((loc) => (
        <button
          key={loc}
          type="button"
          onClick={() => onChange(loc)}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            activeLocale === loc
              ? 'bg-white dark:bg-darkestgray text-main shadow-sm'
              : 'text-gray-500 dark:text-lighttext2 hover:text-darktext dark:hover:text-lighttext'
          }`}
        >
          {loc === 'en' ? t('common.english') : t('common.italian')}
        </button>
      ))}
    </div>
  );
}

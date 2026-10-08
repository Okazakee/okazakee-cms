'use client';

import { useTranslations } from 'next-intl';

interface LocaleToggleProps {
  activeLocale: 'en' | 'it';
  onChange: (locale: 'en' | 'it') => void;
}

export function LocaleToggle({ activeLocale, onChange }: LocaleToggleProps) {
  const t = useTranslations('cms');

  return (
    <fieldset
      aria-label={t('common.translations')}
      className="m-0 flex min-w-0 gap-1 rounded-lg border-0 bg-surface-raised p-0.5"
    >
      {(['en', 'it'] as const).map((loc) => (
        <button
          key={loc}
          type="button"
          onClick={() => onChange(loc)}
          aria-pressed={activeLocale === loc}
          className={`min-h-11 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
            activeLocale === loc
              ? 'bg-surface-base text-accent-violet shadow-sm'
              : 'text-text-muted hover:text-text-main '
          }`}
        >
          {loc === 'en' ? t('common.english') : t('common.italian')}
        </button>
      ))}
    </fieldset>
  );
}

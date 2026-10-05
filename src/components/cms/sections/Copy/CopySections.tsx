'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';

const requestFields = [
  'eyebrow',
  'title',
  'subtitle',
  'name',
  'namePlaceholder',
  'email',
  'emailPlaceholder',
  'company',
  'companyPlaceholder',
  'website',
  'websitePlaceholder',
  'type',
  'typeOptions.0',
  'budget',
  'budgetOptions.0',
  'timeline',
  'timelineOptions.0',
  'request',
  'requestPlaceholder',
  'consent',
  'submit',
  'comingSoon',
];

export function CopyEditor({
  namespace,
  sectionKey,
  fields,
  showAll = false,
}: {
  namespace: string;
  sectionKey: string;
  fields: string[];
  showAll?: boolean;
}) {
  const t = useTranslations('cms');
  const tr = useSectionTranslations(namespace);
  const [locale, setLocale] = useState<'en' | 'it'>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSectionDirty(sectionKey, tr.isDirty);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const errors = await tr.saveTranslations();
      if (errors.length) throw new Error(errors.join('\n'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.saveFailed'));
      throw err;
    } finally {
      setBusy(false);
    }
  }, [tr, t]);
  const revert = () => {
    tr.revertTranslations();
    setError(null);
  };
  useSectionCallbacks(sectionKey, publish, revert);

  const keys = Array.from(
    new Set([
      ...fields,
      ...(showAll
        ? [
            ...Object.keys(tr.translations.en),
            ...Object.keys(tr.translations.it),
          ]
        : fields.flatMap((field) =>
            [
              ...Object.keys(tr.translations.en),
              ...Object.keys(tr.translations.it),
            ].filter((key) => key.startsWith(`${field.split('.')[0]}.`))
          )),
    ])
  ).sort();

  return (
    <fieldset
      disabled={busy || tr.isLoading}
      className="min-w-0 rounded-2xl border border-border-subtle bg-surface-card p-6"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text-white">
          {t(`copy.namespaces.${namespace || 'common'}`)}
        </h2>
        <LocaleToggle activeLocale={locale} onChange={setLocale} />
      </div>
      <ErrorBanner
        message={error || tr.error}
        onDismiss={() => setError(null)}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        {keys.map((key) => (
          <label
            key={key}
            className="block min-w-0 space-y-2 text-xs text-text-muted"
          >
            <span className="break-words">{key}</span>
            <textarea
              aria-label={`${namespace || 'common'}.${key} (${locale.toUpperCase()})`}
              value={tr.getField(locale, key)}
              onChange={(e) => tr.setField(locale, key, e.target.value)}
              rows={/subtitle|Text|description|consent/.test(key) ? 3 : 1}
              className="min-h-11 w-full resize-y rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
            />
          </label>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={revert}
          className="min-h-11 rounded-lg border border-border-subtle px-4 text-sm text-text-muted"
        >
          {t('common.revert')}
        </button>
        <button
          type="button"
          onClick={() => void publish().catch(() => {})}
          disabled={!tr.isDirty}
          className="min-h-11 rounded-lg bg-accent-violet-deep px-4 text-sm text-white disabled:opacity-50"
        >
          {busy ? t('common.publishing') : t('common.publish')}
        </button>
      </div>
    </fieldset>
  );
}

export function RequestCopySection() {
  const t = useTranslations('cms');
  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('copy.requestTitle')}
        description={t('copy.requestDescription')}
      />
      <CopyEditor
        namespace="request-form"
        sectionKey="request-form"
        fields={requestFields}
        showAll
      />
    </div>
  );
}

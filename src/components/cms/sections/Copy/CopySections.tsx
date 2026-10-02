'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { RequestFormPreview } from '@/components/common/cms/previews/canonical/RequestForm';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useCmsStore } from '@/store/cmsStore';

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
const siteGroups = [
  {
    namespace: 'posts-section',
    fields: [
      'button',
      'no-posts',
      'source',
      'demo',
      'store',
      'fdroid',
      'ios',
      'preCopy',
      'ratelimit',
    ],
  },
  {
    namespace: 'errors',
    fields: [
      'code',
      'notFoundLabel',
      'notFoundTitle',
      'notFoundText',
      'goBack',
      'home',
      'errorLabel',
      'errorTitle',
      'errorText',
      'retry',
      'postErrorTitle',
      'postErrorText',
      'postNotFoundText',
    ],
  },
  { namespace: 'privacyPolicy', fields: ['description'] },
];

function CopyEditor({
  namespace,
  sectionKey,
  fields,
  showAll = false,
  preview = false,
}: {
  namespace: string;
  sectionKey: string;
  fields: string[];
  showAll?: boolean;
  preview?: boolean;
}) {
  const t = useTranslations('cms');
  const tr = useSectionTranslations(namespace);
  const [locale, setLocale] = useState<'en' | 'it'>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
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
        {preview && (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="min-h-11 rounded-lg border border-border-subtle px-4 text-sm text-text-muted"
          >
            {t('common.preview')}
          </button>
        )}
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
      {preview && (
        <PreviewModal
          isOpen={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title={t('copy.requestTitle')}
          copy={{ locale, namespace, drafts: tr.translations }}
        >
          <div className="mx-auto max-w-5xl">
            <RequestFormPreview />
          </div>
        </PreviewModal>
      )}
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
        preview
      />
    </div>
  );
}

export function SiteCopySection() {
  const t = useTranslations('cms');
  const publishAll = useCmsStore((s) => s.publishAll);
  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('copy.siteTitle')}
        description={t('copy.siteDescription')}
        actions={
          <button
            type="button"
            onClick={() => void publishAll()}
            className="min-h-11 rounded-lg bg-accent-violet-deep px-4 text-sm text-white"
          >
            {t('sidebar.publishAll')}
          </button>
        }
      />
      {siteGroups.map((group) => (
        <CopyEditor
          key={group.namespace}
          namespace={group.namespace}
          sectionKey={`site-copy:${group.namespace || 'common'}`}
          fields={group.fields}
        />
      ))}
    </div>
  );
}

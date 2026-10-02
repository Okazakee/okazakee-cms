'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import {
  italianNavLabels,
  LayoutPreview,
} from '@/components/common/cms/previews/LayoutPreview';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';

const navSections = [
  'home',
  'skills',
  'career',
  'portfolio',
  'blog',
  'contacts',
] as const;
const footerFields = [
  'left',
  'middle',
  'source',
  'buttonTitle',
  'privacyPolicy',
] as const;

export default function LayoutSection() {
  const t = useTranslations('cms');
  const [locale, setLocale] = useState<'en' | 'it'>('en');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const header = useSectionTranslations('header');
  const footer = useSectionTranslations('footer');
  useSectionDirty('layout', header.isDirty || footer.isDirty);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const errors = [
        ...(await header.saveTranslations()),
        ...(await footer.saveTranslations()),
      ];
      if (errors.length) throw new Error(errors.join('\n'));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('common.saveFailed');
      setError(message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [header, footer, t]);
  const revert = () => {
    header.revertTranslations();
    footer.revertTranslations();
    setError(null);
  };
  useSectionCallbacks('layout', publish, revert);

  const drafts = Object.fromEntries(
    (['en', 'it'] as const).map((language) => [
      language,
      Object.fromEntries([
        ...Object.entries(header.translations[language]).map(([key, value]) => [
          `header.${key}`,
          value,
        ]),
        ...Object.entries(footer.translations[language]).map(([key, value]) => [
          `footer.${key}`,
          value,
        ]),
      ]),
    ])
  ) as Record<'en' | 'it', Record<string, string>>;

  const field = (
    path: string,
    tr: typeof header,
    label: string,
    fixedValue?: string
  ) => (
    <label key={path} className="block space-y-2 text-xs text-text-muted">
      <span>{label}</span>
      <input
        type="text"
        value={fixedValue ?? tr.getField(locale, path)}
        disabled={fixedValue !== undefined}
        onChange={(e) => tr.setField(locale, path, e.target.value)}
        className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
      />
    </label>
  );

  return (
    <fieldset
      disabled={busy || header.isLoading || footer.isLoading}
      className="min-w-0 space-y-6"
    >
      <SectionHeader
        title={t('layout.title')}
        description={t('layout.subtitle')}
        actions={
          <SectionActions
            isDirty={header.isDirty || footer.isDirty}
            busy={busy}
            onPublish={() => publish().catch(() => {})}
            onRevert={revert}
            onPreview={() => setPreviewOpen(true)}
          />
        }
      />
      <ErrorBanner
        message={error || header.error || footer.error}
        onDismiss={() => setError(null)}
      />
      <LocaleToggle activeLocale={locale} onChange={setLocale} />
      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.headerTranslationsTitle')}
        </h2>
        <h3 className="mb-4 text-xs uppercase tracking-widest text-text-dim">
          {t('layout.headerNavButtonsLabel')}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {navSections.map((section, index) =>
            field(
              `buttons.${index}`,
              header,
              t(`layout.nav.${section}`),
              locale === 'it' ? italianNavLabels[index] : undefined
            )
          )}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-text-dim">
          {t('layout.fixedNavigation')}
        </p>
      </section>
      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.footerTranslationsTitle')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {footerFields.map((key) =>
            field(
              key,
              footer,
              t(
                `layout.footer${key.charAt(0).toUpperCase()}${key.slice(1)}Label`
              )
            )
          )}
        </div>
      </section>
      <PreviewModal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('layout.previewTitle')}
        copy={{ locale, namespace: '', drafts }}
      >
        <LayoutPreview />
      </PreviewModal>
    </fieldset>
  );
}

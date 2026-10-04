'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { LayoutPreview } from '@/components/common/cms/previews/LayoutPreview';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';

const footerFields = [
  'left',
  'middle',
  'right',
  'source',
  'buttonTitle',
  'privacyPolicy',
] as const;

/**
 * The public footer on its own page position. The site reads every key here
 * directly (`Footer` for the credit/source/links, `ScrollTop` for `right`).
 */
export default function FooterSection() {
  const t = useTranslations('cms');
  const [locale, setLocale] = useState<'en' | 'it'>('en');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const footer = useSectionTranslations('footer');
  useSectionDirty('footer', footer.isDirty);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const errors = await footer.saveTranslations();
      if (errors.length) throw new Error(errors.join('\n'));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('common.saveFailed');
      setError(message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [footer, t]);
  const revert = () => {
    footer.revertTranslations();
    setError(null);
  };
  useSectionCallbacks('footer', publish, revert);

  const drafts = Object.fromEntries(
    (['en', 'it'] as const).map((language) => [
      language,
      Object.fromEntries(
        Object.entries(footer.translations[language]).map(([key, value]) => [
          `footer.${key}`,
          value,
        ])
      ),
    ])
  ) as Record<'en' | 'it', Record<string, string>>;

  const field = (key: (typeof footerFields)[number]) => (
    <label key={key} className="block space-y-2 text-xs text-text-muted">
      <span>
        {t(`layout.footer${key.charAt(0).toUpperCase()}${key.slice(1)}Label`)}
      </span>
      <input
        type="text"
        value={footer.getField(locale, key)}
        onChange={(e) => footer.setField(locale, key, e.target.value)}
        className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
      />
    </label>
  );

  return (
    <fieldset disabled={busy || footer.isLoading} className="min-w-0 space-y-6">
      <SectionHeader
        title={t('footerSection.title')}
        description={t('footerSection.subtitle')}
        actions={
          <SectionActions
            isDirty={footer.isDirty}
            busy={busy}
            onPublish={() => publish().catch(() => {})}
            onRevert={revert}
            onPreview={() => setPreviewOpen(true)}
          />
        }
      />
      <ErrorBanner
        message={error || footer.error}
        onDismiss={() => setError(null)}
      />
      <LocaleToggle activeLocale={locale} onChange={setLocale} />
      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.footerTranslationsTitle')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {footerFields.map(field)}
        </div>
      </section>
      <PreviewModal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('layout.previewTitle')}
        copy={{ locale, namespace: '', drafts }}
      >
        <LayoutPreview part="footer" />
      </PreviewModal>
    </fieldset>
  );
}

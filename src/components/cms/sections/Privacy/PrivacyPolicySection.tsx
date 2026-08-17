'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { i18nActions } from '@/app/actions/cms/sections/i18nActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import MarkdownRenderer from '@/components/layout/MarkdownRenderer';

export default function PrivacyPolicySection() {
  const t = useTranslations('cms');
  const [enMarkdown, setEnMarkdown] = useState('');
  const [itMarkdown, setItMarkdown] = useState('');
  const [original, setOriginal] = useState({ en: '', it: '' });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_isUpdating, setIsUpdating] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');

  const isDirty = enMarkdown !== original.en || itMarkdown !== original.it;
  useSectionDirty('privacy-policy', isDirty);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const r = await i18nActions({ type: 'GET' });
      if (r.success && r.data) {
        const d = r.data as Array<{ language: string; privacy_policy: string }>;
        const en = d.find((x) => x.language === 'en')?.privacy_policy || '';
        const it = d.find((x) => x.language === 'it')?.privacy_policy || '';
        setEnMarkdown(en);
        setItMarkdown(it);
        setOriginal({ en, it });
      }
    } catch {
      setError(t('privacy.errorFetch'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePublish = useCallback(async () => {
    setIsUpdating(true);
    setError(null);
    const errors: string[] = [];
    for (const locale of ['en', 'it'] as const) {
      const r = await i18nActions({
        type: 'UPDATE_PRIVACY',
        locale,
        markdown: locale === 'en' ? enMarkdown : itMarkdown,
      });
      if (!r.success) errors.push(`${locale}: ${r.error}`);
      else {
        const warning = revalidationWarning(r);
        if (warning) errors.push(warning);
      }
    }
    if (errors.length === 0) setOriginal({ en: enMarkdown, it: itMarkdown });
    else setError(errors.join('\n'));
    setIsUpdating(false);
  }, [enMarkdown, itMarkdown]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    setEnMarkdown(original.en);
    setItMarkdown(original.it);
    setError(null);
  };

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const textareaClass =
    'w-full px-4 py-3 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none font-mono text-sm resize-y';

  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" />
      </div>
    );

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader
        title={t('privacy.title')}
        description={t('privacy.subtitle')}
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="flex items-center justify-between gap-2">
        <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
        <button
          type="button"
          onClick={() => setShowPreview((p) => !p)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 dark:bg-darkergray hover:bg-gray-200 dark:hover:bg-darkgray text-darktext dark:text-lighttext rounded-lg transition-colors"
        >
          {showPreview ? (
            <EyeOff className="w-4 h-4" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
          {showPreview ? 'Hide Preview' : 'Show Preview'}
        </button>
      </div>

      <div>
        <h2 className="text-lg font-bold text-main mb-3">
          {activeLocale === 'en' ? t('common.english') : t('common.italian')}
        </h2>
        <textarea
          value={activeLocale === 'en' ? enMarkdown : itMarkdown}
          onChange={(e) => {
            if (activeLocale === 'en') setEnMarkdown(e.target.value);
            else setItMarkdown(e.target.value);
          }}
          className={textareaClass}
          rows={showPreview ? 12 : 20}
          placeholder={
            activeLocale === 'en'
              ? '# Privacy Policy'
              : '# Informativa sulla Privacy'
          }
        />
      </div>

      {showPreview && (
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
          <h3 className="text-lg font-bold text-main mb-4">Live Preview</h3>
          <div className="prose dark:prose-invert max-w-none bg-white dark:bg-darkestgray rounded-lg p-4 md:p-6 border border-gray-200 dark:border-darkgray/50">
            <MarkdownRenderer
              markdown={activeLocale === 'en' ? enMarkdown : itMarkdown}
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={showConfirmRevert}
        title={t('common.revertAll')}
        message={t('common.confirmRevertAll')}
        confirmLabel={t('common.revert')}
        confirmVariant="primary"
        onConfirm={handleRevert}
        onCancel={() => setShowConfirmRevert(false)}
      />
    </div>
  );
}

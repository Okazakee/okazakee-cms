'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { i18nActions } from '@/app/actions/cms/sections/i18nActions';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';

export default function PrivacyPolicySection() {
  const t = useTranslations('cms');
  const fetchLabels = useRef(t);
  fetchLabels.current = t;
  const [enMarkdown, setEnMarkdown] = useState('');
  const [itMarkdown, setItMarkdown] = useState('');
  const [original, setOriginal] = useState({ en: '', it: '' });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');

  const isDirty = enMarkdown !== original.en || itMarkdown !== original.it;
  useSectionDirty('privacy-policy', isDirty);

  const beginLoad = useLatestRequest();
  const fetchData = useCallback(async () => {
    const current = beginLoad();
    setIsLoading(true);
    try {
      const r = await i18nActions({ type: 'GET' });
      if (!current()) return;
      if (!r.success)
        throw new Error(r.error || fetchLabels.current('privacy.errorFetch'));
      if (r.data) {
        const d = r.data as Array<{ language: string; privacy_policy: string }>;
        const en = d.find((x) => x.language === 'en')?.privacy_policy || '';
        const it = d.find((x) => x.language === 'it')?.privacy_policy || '';
        setEnMarkdown(en);
        setItMarkdown(it);
        setOriginal({ en, it });
      }
    } catch {
      if (current()) setError(fetchLabels.current('privacy.errorFetch'));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [beginLoad]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePublish = useCallback(async () => {
    setIsUpdating(true);
    setError(null);
    useCmsStore.getState().setError(null);
    const errors: string[] = [];
    const submitted = { en: enMarkdown, it: itMarkdown };
    try {
      for (const locale of ['en', 'it'] as const) {
        if (submitted[locale] === original[locale]) continue;
        try {
          const r = await i18nActions({
            type: 'UPDATE_PRIVACY',
            locale,
            markdown: submitted[locale],
          });
          if (!r.success)
            errors.push(`${locale}: ${r.error || 'Failed to save'}`);
          else {
            setOriginal((prev) => ({ ...prev, [locale]: submitted[locale] }));
            const warning = revalidationWarning(r);
            if (warning) useCmsStore.getState().setWarning(warning);
          }
        } catch (err) {
          errors.push(
            `${locale}: ${err instanceof Error ? err.message : 'Failed to save'}`
          );
        }
      }
      if (errors.length > 0) {
        const message = errors.join('\n');
        setError(message);
        useCmsStore.getState().setError(message);
      }
    } finally {
      setIsUpdating(false);
    }
  }, [enMarkdown, itMarkdown, original]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    setEnMarkdown(original.en);
    setItMarkdown(original.it);
    setError(null);
  };

  useSectionCallbacks('privacy-policy', handlePublish, handleRevert);

  const textareaClass =
    'w-full px-4 py-3 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none font-mono text-sm resize-y';

  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );

  return (
    <fieldset
      disabled={isUpdating}
      className="space-y-6 md:space-y-8 border-0 p-0 m-0 min-w-0"
    >
      <SectionHeader
        title={t('privacy.title')}
        description={t('privacy.subtitle')}
        actions={
          <SectionActions
            isDirty={isDirty}
            busy={isUpdating}
            onPublish={handlePublish}
            onRevert={() => setShowConfirmRevert(true)}
          />
        }
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <div className="flex items-center justify-between gap-2">
        <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
      </div>

      <div>
        <h2 className="text-lg font-bold text-accent-violet mb-3">
          {activeLocale === 'en' ? t('common.english') : t('common.italian')}
        </h2>
        <textarea
          aria-label={t('privacy.bodyLabel')}
          value={activeLocale === 'en' ? enMarkdown : itMarkdown}
          onChange={(e) => {
            if (activeLocale === 'en') setEnMarkdown(e.target.value);
            else setItMarkdown(e.target.value);
          }}
          className={textareaClass}
          rows={20}
          placeholder={
            activeLocale === 'en'
              ? '# Privacy Policy'
              : '# Informativa sulla Privacy'
          }
        />
      </div>

      <ConfirmDialog
        isOpen={showConfirmRevert}
        title={t('common.revertAll')}
        message={t('common.confirmRevertAll')}
        confirmLabel={t('common.revert')}
        confirmVariant="primary"
        onConfirm={handleRevert}
        onCancel={() => setShowConfirmRevert(false)}
      />
    </fieldset>
  );
}

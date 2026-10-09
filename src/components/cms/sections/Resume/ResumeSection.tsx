'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resumeActions } from '@/app/actions/cms/sections/resumeActions';
import { EditorGroup } from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { DEFAULT_RESUME_CSS } from '@/libs/resume/defaultCss';
import { renderResumeHtml } from '@/libs/resume/template';
import type { ResumeData, ResumeLocale } from '@/libs/resume/types';
import { mergeHeroSettings, useCmsStore } from '@/store/cmsStore';
import { TextArea } from './ResumeFields';
import { ResumeLocaleForm } from './ResumeLocaleForm';
import { ResumePreview } from './ResumePreview';

type ResumeDraft = {
  en: ResumeData;
  it: ResumeData;
  css: string;
};

type ResumeTab = ResumeLocale | 'css';

const TABS: ResumeTab[] = ['en', 'it', 'css'];

export function ResumeSection() {
  const t = useTranslations('cms.resume');
  const tb = useTranslations('cms.resume.builder');
  const heroSection = useCmsStore((state) => state.heroSection);
  const [draft, setDraft] = useState<ResumeDraft | null>(null);
  const [saved, setSaved] = useState<ResumeDraft | null>(null);
  const [tab, setTab] = useState<ResumeTab>('en');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    void resumeActions({ type: 'GET' })
      .then((result) => {
        if (!result.success) throw new Error(result.error);
        const data = result.data as {
          en: ResumeData;
          it: ResumeData;
          css: string;
        };
        const initial = { en: data.en, it: data.it, css: data.css ?? '' };
        setDraft(initial);
        setSaved(initial);
      })
      .catch((cause: unknown) => {
        setLoadError(
          cause instanceof Error ? cause.message : t('builder.errorLoad')
        );
      })
      .finally(() => setLoading(false));
  }, [t]);

  const isDirty = useMemo(() => {
    if (!draft || !saved) return false;
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }, [draft, saved]);
  useSectionDirty('resume', isDirty);

  const publish = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    useCmsStore.getState().setError(null);
    try {
      const result = await resumeActions({ type: 'PUBLISH', data: draft });
      if (!result.success) throw new Error(result.error || t('errorSave'));
      const data = result.data as {
        resume_en: string;
        resume_it: string;
      };
      const store = useCmsStore.getState();
      store.setHeroSection(
        mergeHeroSettings(store.heroSection, {
          resume_en: data.resume_en,
          resume_it: data.resume_it,
        })
      );
      const warning = revalidationWarning(result);
      if (warning) store.setWarning(warning);
      setSaved(draft);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('errorSave');
      setError(message);
      useCmsStore.getState().setError(message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [draft, t]);

  const revert = useCallback(() => {
    setDraft(saved);
    setError(null);
  }, [saved]);
  useSectionCallbacks('resume', publish, revert);

  const effectiveCss = useMemo(() => {
    const css = draft?.css.trim() ?? '';
    return css === '' ? DEFAULT_RESUME_CSS : css;
  }, [draft]);

  const previewHtml = useMemo(() => {
    if (!draft) return '';
    const locale = tab === 'css' ? 'en' : tab;
    return renderResumeHtml(draft[locale], effectiveCss, {
      locale,
      docTitle: locale === 'en' ? 'Resume' : 'Curriculum',
    });
  }, [draft, effectiveCss, tab]);

  const downloadHtml = useCallback(
    (locale: ResumeLocale) => {
      if (!draft) return;
      const html = renderResumeHtml(draft[locale], effectiveCss, {
        locale,
        docTitle: locale === 'en' ? 'Resume' : 'Curriculum',
      });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `resume_${locale}.html`;
      link.click();
      URL.revokeObjectURL(url);
    },
    [draft, effectiveCss]
  );

  const downloadPdf = async (url: string, locale: string) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Download failed');
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `resume_${locale}.pdf`;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setError(t('errorDownload'));
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <SectionHeader title={t('title')} description={t('subtitle')} />
        <p className="text-sm text-text-muted" role="status">
          {tb('loading')}
        </p>
      </div>
    );
  }

  if (loadError || !draft) {
    return (
      <div className="space-y-6">
        <SectionHeader title={t('title')} description={t('subtitle')} />
        <ErrorBanner
          message={loadError ?? tb('errorLoad')}
          onDismiss={() => setLoadError(null)}
        />
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-11 rounded-lg bg-accent-violet-deep px-4 text-sm text-white"
        >
          {tb('loading')}
        </button>
      </div>
    );
  }

  const published = (
    [
      { locale: 'en', url: heroSection?.resume_en ?? null },
      { locale: 'it', url: heroSection?.resume_it ?? null },
    ] as const
  ).filter((entry) => entry.url !== null);

  return (
    <fieldset disabled={busy} className="min-w-0 space-y-6">
      <SectionHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <SectionActions
            busy={busy}
            isDirty={isDirty}
            onPublish={publish}
            onRevert={revert}
          />
        }
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div
        role="tablist"
        aria-label={t('title')}
        className="flex flex-wrap gap-2"
      >
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            onClick={() => setTab(entry)}
            className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === entry
                ? 'bg-accent-violet-deep text-white'
                : 'border border-border-subtle bg-surface-card text-text-muted hover:text-text-main'
            }`}
          >
            {entry === 'en'
              ? tb('tabEn')
              : entry === 'it'
                ? tb('tabIt')
                : tb('tabCss')}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">
          {tab === 'css' ? (
            <EditorGroup title={tb('cssLabel')} description={tb('cssHint')}>
              <TextArea
                mono
                rows={24}
                value={draft.css}
                onChange={(css) => setDraft({ ...draft, css })}
              />
              {draft.css.trim() !== '' && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, css: '' })}
                  className="min-h-11 rounded-lg border border-border-subtle bg-surface-base px-4 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
                >
                  {tb('cssReset')}
                </button>
              )}
            </EditorGroup>
          ) : (
            <ResumeLocaleForm
              data={draft[tab]}
              onChange={(next) => setDraft({ ...draft, [tab]: next })}
            />
          )}
        </div>

        <div className="min-w-0 xl:sticky xl:top-4">
          <EditorGroup
            title={tb('previewTitle')}
            actions={
              <button
                type="button"
                onClick={() => downloadHtml(tab === 'css' ? 'en' : tab)}
                className="min-h-11 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
              >
                {tb('downloadHtml')}
              </button>
            }
          >
            <ResumePreview
              html={previewHtml}
              title={tb('previewTitle')}
              overflowMessage={tb('previewOverflow')}
            />
          </EditorGroup>
        </div>
      </div>

      {published.length > 0 && (
        <EditorGroup
          title={tb('publishedGroup')}
          description={tb('publishedHint')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {published.map((entry) => (
              <div
                key={entry.locale}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface-base p-3"
              >
                <span className="text-sm font-medium text-text-main">
                  {entry.locale === 'en'
                    ? t('englishLabel')
                    : t('italianLabel')}
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      window.open(entry.url ?? '', '_blank', 'noopener')
                    }
                    className="min-h-11 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main hover:bg-surface-raised"
                  >
                    {t('openLabel')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      entry.url &&
                      navigator.clipboard
                        .writeText(entry.url)
                        .catch(() => setError(t('errorCopy')))
                    }
                    className="min-h-11 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main hover:bg-surface-raised"
                  >
                    {t('copyUrl')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      entry.url && void downloadPdf(entry.url, entry.locale)
                    }
                    className="min-h-11 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main hover:bg-surface-raised"
                  >
                    {t('download')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </EditorGroup>
      )}
    </fieldset>
  );
}

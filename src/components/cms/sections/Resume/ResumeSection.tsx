'use client';

import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resumeActions } from '@/app/actions/cms/sections/resumeActions';
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
import { ResumePreviewModal } from './ResumePreviewModal';

type ResumeDraft = {
  en: ResumeData;
  it: ResumeData;
  css: string;
};

const TABS: ResumeLocale[] = ['en', 'it'];

export function ResumeSection() {
  const t = useTranslations('cms.resume');
  const tb = useTranslations('cms.resume.builder');
  const tc = useTranslations('cms.common');
  const heroSection = useCmsStore((state) => state.heroSection);
  const [draft, setDraft] = useState<ResumeDraft | null>(null);
  const [saved, setSaved] = useState<ResumeDraft | null>(null);
  const [tab, setTab] = useState<ResumeLocale>('en');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [cssOpen, setCssOpen] = useState(false);
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
        const initial = {
          en: data.en,
          it: data.it,
          // The styling editor always shows the full raw stylesheet, so a
          // tweak never starts from an empty box.
          css:
            data.css && data.css.trim() !== ''
              ? data.css
              : DEFAULT_RESUME_CSS,
        };
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
    return renderResumeHtml(draft[tab], effectiveCss, {
      locale: tab,
      docTitle: tab === 'en' ? 'Resume' : 'Curriculum',
    });
  }, [draft, effectiveCss, tab]);

  const closePreview = useCallback(() => setPreviewOpen(false), []);

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

  const publishedUrl =
    heroSection?.[tab === 'en' ? 'resume_en' : 'resume_it'] ?? null;

  const navItems = [
    { id: 'resume-header', label: tb('headerGroup') },
    { id: 'resume-summary', label: tb('summaryGroup') },
    { id: 'resume-skills', label: tb('skillsGroup') },
    { id: 'resume-experience', label: tb('experienceGroup') },
    { id: 'resume-projects', label: tb('projectsGroup') },
    { id: 'resume-education', label: tb('educationGroup') },
    { id: 'resume-languages', label: tb('languagesGroup') },
    { id: 'resume-styling', label: tb('tabCss') },
  ];

  const scrollToSection = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const main = document.getElementById('cms-workspace');
    if (main) {
      const top =
        target.getBoundingClientRect().top -
        main.getBoundingClientRect().top +
        main.scrollTop -
        12;
      main.scrollTo({ top, behavior: 'smooth' });
    } else {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

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

      <div className="space-y-2">
        <div
          role="tablist"
          aria-label={t('title')}
          className="grid grid-cols-2 gap-2 sm:flex sm:justify-center"
        >
          {TABS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              onClick={() => setTab(entry)}
              className={`inline-flex min-h-11 items-center justify-center rounded-lg px-2 py-2 text-sm font-medium transition-colors sm:px-4 ${
                tab === entry
                  ? 'bg-accent-violet-deep text-white'
                  : 'border border-border-subtle bg-surface-card text-text-muted hover:text-text-main'
              }`}
            >
              {entry === 'en' ? tb('tabEn') : tb('tabIt')}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:flex sm:justify-center">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-2 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text-main sm:w-auto sm:px-4"
          >
            <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{tb('previewTitle')}</span>
          </button>
          <div className="grid grid-cols-3 gap-2 sm:flex">
            <span aria-hidden="true" className="hidden w-px self-stretch bg-border-subtle sm:block" />
            <button
              type="button"
              disabled={!publishedUrl}
              onClick={() => publishedUrl && window.open(publishedUrl, '_blank', 'noopener')}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border-subtle bg-surface-card px-2 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text-main disabled:opacity-40 sm:px-4"
            >
              {t('openLabel')}
            </button>
            <button
              type="button"
              disabled={!publishedUrl}
              onClick={() =>
                publishedUrl &&
                navigator.clipboard
                  .writeText(publishedUrl)
                  .catch(() => setError(t('errorCopy')))
              }
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border-subtle bg-surface-card px-2 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text-main disabled:opacity-40 sm:px-4"
            >
              {t('copyUrl')}
            </button>
            <button
              type="button"
              disabled={!publishedUrl}
              onClick={() => publishedUrl && void downloadPdf(publishedUrl, tab)}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border-subtle bg-surface-card px-2 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text-main disabled:opacity-40 sm:px-4"
            >
              {t('download')}
            </button>
          </div>
        </div>
      </div>

      <nav
        aria-label={tb('sectionNav')}
        className="sticky top-0 z-10 mx-auto flex w-fit max-w-full justify-safe-center gap-1 overflow-x-auto rounded-xl bg-surface-base/95 py-1 backdrop-blur"
      >
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => scrollToSection(item.id)}
            className="min-h-10 shrink-0 rounded-full border border-border-subtle bg-surface-card px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-raised hover:text-text-main"
          >
            {item.label}
          </button>
        ))}
      </nav>

      <ResumeLocaleForm
        data={draft[tab]}
        onChange={(next) => setDraft({ ...draft, [tab]: next })}
      />

      <div
        id="resume-styling"
        className="rounded-2xl border border-border-subtle bg-surface-card"
      >
        <button
          type="button"
          aria-expanded={cssOpen}
          onClick={() => setCssOpen((open) => !open)}
          className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left sm:p-6"
        >
          <span>
            <span className="block text-lg font-bold text-text-white">
              {tb('tabCss')}
            </span>
            <span className="mt-1 block text-sm text-text-muted">
              {tb('cssHint')}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={`shrink-0 text-text-muted transition-transform ${cssOpen ? 'rotate-180' : ''}`}
          >
            ▾
          </span>
        </button>
        {cssOpen && (
          <div className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
            <TextArea
              mono
              rows={18}
              value={draft.css}
              onChange={(css) => setDraft({ ...draft, css })}
            />
            <button
              type="button"
              onClick={() => setDraft({ ...draft, css: DEFAULT_RESUME_CSS })}
              className="min-h-11 rounded-lg border border-border-subtle bg-surface-base px-4 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
            >
              {tb('cssReset')}
            </button>
          </div>
        )}
      </div>

      {previewOpen && (
        <ResumePreviewModal
          html={previewHtml}
          title={tb('previewTitle')}
          overflowMessage={tb('previewOverflow')}
          downloadLabel={tb('downloadHtml')}
          closeLabel={tc('close')}
          onDownloadHtml={() => downloadHtml(tab)}
          onClose={closePreview}
        />
      )}

    </fieldset>
  );
}

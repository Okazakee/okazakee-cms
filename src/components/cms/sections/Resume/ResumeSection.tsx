'use client';

import { Copy, Download, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { mergeHeroSettings, useCmsStore } from '@/store/cmsStore';

export function ResumeSection() {
  const t = useTranslations('cms');
  const heroSection = useCmsStore((state) => state.heroSection);
  const enUpload = useFileUpload({ accept: '.pdf', maxSizeMB: 10 });
  const itUpload = useFileUpload({ accept: '.pdf', maxSizeMB: 10 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDirty = enUpload.file !== null || itUpload.file !== null;
  useSectionDirty('resume', isDirty);

  const publish = useCallback(async () => {
    if (!enUpload.file && !itUpload.file) return;
    setBusy(true);
    setError(null);
    useCmsStore.getState().setError(null);
    try {
      const result = await heroActions({
        type: 'UPDATE_WITH_FILES',
        files: {
          ...(enUpload.file ? { resume_en: enUpload.file } : {}),
          ...(itUpload.file ? { resume_it: itUpload.file } : {}),
        },
      });
      if (!result.success)
        throw new Error(result.error || t('resume.errorSave'));
      const data = result.data as { resume_en?: string; resume_it?: string };
      const store = useCmsStore.getState();
      store.setHeroSection(mergeHeroSettings(store.heroSection, data));
      const warning = revalidationWarning(result);
      if (warning) store.setWarning(warning);
      enUpload.clearFile();
      itUpload.clearFile();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : t('resume.errorSave');
      setError(message);
      useCmsStore.getState().setError(message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [enUpload, itUpload, t]);

  const revert = useCallback(() => {
    enUpload.clearFile();
    itUpload.clearFile();
    setError(null);
  }, [enUpload, itUpload]);
  useSectionCallbacks('resume', publish, revert);

  const download = async (url: string, locale: string) => {
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
      setError(t('resume.errorDownload'));
    }
  };

  return (
    <fieldset disabled={busy} className="min-w-0 space-y-6">
      <SectionHeader
        title={t('resume.title')}
        description={t('resume.subtitle')}
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
      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <div className="grid gap-6 md:grid-cols-2">
          {(['en', 'it'] as const).map((locale) => {
            const upload = locale === 'en' ? enUpload : itUpload;
            const currentUrl =
              heroSection?.[locale === 'en' ? 'resume_en' : 'resume_it'] ??
              null;
            return (
              <div key={locale}>
                <h2 className="mb-2 text-sm font-medium text-text-main">
                  {t(
                    locale === 'en'
                      ? 'resume.englishLabel'
                      : 'resume.italianLabel'
                  )}
                </h2>
                <FileDropzone
                  compact
                  currentUrl={currentUrl}
                  dropzoneProps={upload.dropzoneProps}
                  error={upload.error}
                  fileInputProps={{ ...upload.fileInputProps, accept: '.pdf' }}
                  fileInputRef={upload.fileInputRef}
                  isDragging={upload.isDragging}
                  isProcessing={upload.isProcessing}
                  onBrowse={upload.openFileDialog}
                  onClear={upload.clearFile}
                  previewUrl={upload.previewUrl}
                />
                {currentUrl && (
                  <div className="mt-2 flex flex-wrap gap-2 text-sm">
                    <a
                      href={currentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-surface-base px-3"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t('resume.openLabel')}
                    </a>
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-surface-base px-3"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(currentUrl)
                          .catch(() => setError(t('resume.errorCopy')))
                      }
                    >
                      <Copy className="h-3 w-3" />
                      {t('resume.copyUrl')}
                    </button>
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-surface-base px-3"
                      onClick={() => download(currentUrl, locale)}
                    >
                      <Download className="h-3 w-3" />
                      {t('resume.download')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-text-muted">{t('resume.pdfNote')}</p>
      </section>
    </fieldset>
  );
}

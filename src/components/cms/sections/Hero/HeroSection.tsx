'use client';

import { Copy, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useCmsStore } from '@/store/cmsStore';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { HeroPreview } from '@/components/common/cms/previews/HeroPreview';

export default function HeroSection() {
  const t = useTranslations('cms');
  const { heroSection, setHeroSection } = useCmsStore();

  const [_isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');

  const imgUpload = useFileUpload({
    accept: 'image/*',
    maxSizeMB: 10,
    imageProcessing: { maxWidth: 512, maxHeight: 512, quality: 0.85 },
    generateBlurhash: true,
  });

  const {
    isDirty: transDirty,
    isLoading: transLoading,
    getField,
    setField,
    saveTranslations,
    revertTranslations,
  } = useSectionTranslations('hero-section');

  const initRef = useRef(false);

  useEffect(() => {
    if (!heroSection || initRef.current) return;
    initRef.current = true;
    if (heroSection.mainImage) {
      imgUpload.setFileFromUrl(heroSection.mainImage);
    }
  }, [heroSection, imgUpload]);

  const mainImageUrl = imgUpload.previewUrl ?? heroSection?.mainImage ?? '';
  const isDirty = imgUpload.file !== null || transDirty;

  useSectionDirty('hero', isDirty);

  const handlePublish = useCallback(async () => {
    setIsUpdating(true);
    setError(null);

    try {
      if (imgUpload.file) {
        const result = await heroActions({
          type: 'UPDATE_WITH_FILES',
          files: {
            mainImage: imgUpload.file,
          },
          currentData: {
            mainImage: heroSection?.mainImage || '',
            resume_en: heroSection?.resume_en || '',
            resume_it: heroSection?.resume_it || '',
          },
          blurhashURL: imgUpload.blurhash ?? undefined,
        });

        if (!result.success) {
          setError(result.error || t('hero.errorUpdateHero'));
          setIsUpdating(false);
          return;
        }

        const data = result.data as {
          propic?: string;
          blurhashURL?: string;
          resume_en?: string;
          resume_it?: string;
        };

        setHeroSection({
          mainImage: data.propic || heroSection?.mainImage || null,
          blurhashURL: data.blurhashURL || heroSection?.blurhashURL || null,
          resume_en: data.resume_en || heroSection?.resume_en || null,
          resume_it: data.resume_it || heroSection?.resume_it || null,
        });

        imgUpload.clearFile();
        if (data.propic) {
          imgUpload.setFileFromUrl(data.propic);
        }
      }

      const transErrors = await saveTranslations();
      if (transErrors.length > 0) {
        setError(transErrors.join('\n'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('hero.errorUpdateHero'));
    } finally {
      setIsUpdating(false);
    }
  }, [
    imgUpload,
    heroSection, saveTranslations, setHeroSection, t,
  ]);

  const handleRevert = useCallback(() => {
    setShowConfirmRevert(false);
    imgUpload.clearFile();
    revertTranslations();
    if (heroSection?.mainImage) {
      imgUpload.setFileFromUrl(heroSection.mainImage);
    }
    setError(null);
  }, [imgUpload, revertTranslations, heroSection]);

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).catch(() => setError(t('hero.errorCopyUrl')));
  };

  const downloadImage = async (url: string) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = 'hero-image.jpg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    } catch {
      setError(t('hero.errorDownloadImage'));
    }
  };

  if (!heroSection) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" />
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader
        title={t('hero.title')}
        description={t('hero.subtitle')}
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Hero Image */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <h2 className="text-lg md:text-xl font-bold text-main mb-4">
          {t('hero.heroImageTitle')}
        </h2>
        <div className="flex flex-col lg:flex-row items-start gap-6">
          <div className="w-full lg:w-72 flex-shrink-0">
            <FileDropzone
              previewUrl={imgUpload.previewUrl}
              blurhash={imgUpload.blurhash}
              isDragging={imgUpload.isDragging}
              isProcessing={imgUpload.isProcessing}
              error={imgUpload.error}
              currentUrl={heroSection.mainImage}
              dropzoneProps={{
                onDragOver: imgUpload.dropzoneProps.onDragOver,
                onDragLeave: imgUpload.dropzoneProps.onDragLeave,
                onDrop: imgUpload.dropzoneProps.onDrop,
              }}
              fileInputProps={imgUpload.fileInputProps}
              fileInputRef={imgUpload.fileInputRef}
              onClear={imgUpload.clearFile}
              onBrowse={imgUpload.openFileDialog}
            />
          </div>
          {mainImageUrl && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => copyUrl(mainImageUrl)}
                className="px-3 py-1.5 text-sm bg-white dark:bg-darkestgray text-darktext dark:text-lighttext rounded-lg hover:bg-gray-100 dark:hover:bg-darkgray transition-colors"
              >
                <Copy className="w-3 h-3 inline mr-1" />
                {t('hero.copyUrl')}
              </button>
              <button
                type="button"
                onClick={() => downloadImage(mainImageUrl)}
                className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
              >
                <Download className="w-3 h-3 inline mr-1" />
                {t('hero.download')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Translations */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-main">
            {t('hero.translationsSection')}
          </h2>
          <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
        </div>

        {transLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-main" />
          </div>
        ) : (
          <div className="space-y-6">
            <h3 className="text-base font-semibold text-darktext dark:text-lighttext">
              {t('hero.topSection')}
            </h3>
            <TranslationField
              label={t('hero.nameLabel')}
              enValue={getField('en', 'top.name')}
              itValue={getField('it', 'top.name')}
              onChangeEn={(v) => setField('en', 'top.name', v)}
              onChangeIt={(v) => setField('it', 'top.name', v)}
              activeLocale={activeLocale}
            />
            <TranslationField
              label={t('hero.roleLabel')}
              enValue={getField('en', 'top.role')}
              itValue={getField('it', 'top.role')}
              onChangeEn={(v) => setField('en', 'top.role', v)}
              onChangeIt={(v) => setField('it', 'top.role', v)}
              activeLocale={activeLocale}
            />

            <h3 className="text-base font-semibold text-darktext dark:text-lighttext pt-2">
              {t('hero.aboutMeSection')}
            </h3>
            <TranslationField
              label={t('hero.aboutMeTitleLabel')}
              enValue={getField('en', 'aboutme.title')}
              itValue={getField('it', 'aboutme.title')}
              onChangeEn={(v) => setField('en', 'aboutme.title', v)}
              onChangeIt={(v) => setField('it', 'aboutme.title', v)}
              activeLocale={activeLocale}
            />
            <TranslationField
              label={t('hero.aboutMeParagraphLabel')}
              enValue={getField('en', 'aboutme.paragraph')}
              itValue={getField('it', 'aboutme.paragraph')}
              onChangeEn={(v) => setField('en', 'aboutme.paragraph', v)}
              onChangeIt={(v) => setField('it', 'aboutme.paragraph', v)}
              activeLocale={activeLocale}
              type="textarea"
              rows={8}
            />
          </div>
        )}
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

      <PreviewModal
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        title={t('hero.previewTitle')}
      >
        <HeroPreview
          mainImage={mainImageUrl}
          blurhashURL={imgUpload.blurhash ?? heroSection.blurhashURL ?? ''}
        />
      </PreviewModal>
    </div>
  );
}

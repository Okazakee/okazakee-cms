'use client';

import { ArrowDown, ArrowUp, Copy, Download, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { Dropdown } from '@/components/cms/shared/Dropdown';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { mergeHeroSettings, useCmsStore } from '@/store/cmsStore';
import type { HeroShape } from '@/types/fetchedData.types';
import {
  countHeroRoleEntries,
  heroRolePath,
  heroShapes,
  normalizeHeroShape,
} from '@/utils/heroDisplay';

const locales = ['en', 'it'] as const;
const inputClass =
  'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none';
const iconButtonClass =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-raised disabled:opacity-30';

export default function HeroSection() {
  const t = useTranslations('cms');
  const { heroSection, setHeroSection } = useCmsStore();

  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');
  const [shape, setShape] = useState<HeroShape>('pebble');

  const imgUpload = useFileUpload({
    accept: 'image/*',
    maxSizeMB: 10,
    imageProcessing: { maxWidth: 512, maxHeight: 512, quality: 0.85 },
    generateBlurhash: true,
  });

  const {
    translations,
    isDirty: transDirty,
    isLoading: transLoading,
    getField,
    setField,
    deleteField,
    saveTranslations,
    revertTranslations,
  } = useSectionTranslations('hero-section');

  const initRef = useRef(false);

  useEffect(() => {
    if (!heroSection || initRef.current) return;
    initRef.current = true;
    setShape(normalizeHeroShape(heroSection.shape));
    if (heroSection.mainImage) {
      imgUpload.setFileFromUrl(heroSection.mainImage);
    }
  }, [heroSection, imgUpload]);

  const mainImageUrl = imgUpload.previewUrl ?? heroSection?.mainImage ?? '';
  const roleCount = Math.max(
    countHeroRoleEntries(translations.en),
    countHeroRoleEntries(translations.it)
  );
  const displayDirty = shape !== normalizeHeroShape(heroSection?.shape);
  const isDirty = imgUpload.file !== null || transDirty || displayDirty;

  useSectionDirty('hero', isDirty);

  const addRole = () => {
    for (const locale of locales) setField(locale, heroRolePath(roleCount), '');
  };

  const removeRole = (index: number) => {
    for (const locale of locales) {
      for (let slot = index; slot < roleCount - 1; slot++) {
        setField(
          locale,
          heroRolePath(slot),
          getField(locale, heroRolePath(slot + 1))
        );
      }
      deleteField(locale, heroRolePath(roleCount - 1));
    }
  };

  const moveRole = (index: number, direction: -1 | 1) => {
    const swap = index + direction;
    if (swap < 0 || swap >= roleCount) return;

    for (const locale of locales) {
      const current = getField(locale, heroRolePath(index));
      setField(
        locale,
        heroRolePath(index),
        getField(locale, heroRolePath(swap))
      );
      setField(locale, heroRolePath(swap), current);
    }
  };

  const handlePublish = useCallback(async () => {
    setIsUpdating(true);
    setError(null);
    useCmsStore.getState().setError(null);

    try {
      let revalidationMessage: string | null = null;
      if (imgUpload.file) {
        const result = await heroActions({
          type: 'UPDATE_WITH_FILES',
          files: {
            mainImage: imgUpload.file,
          },
          blurhashURL: imgUpload.blurhash ?? undefined,
        });

        if (!result.success) {
          const message = result.error || t('hero.errorUpdateHero');
          setError(message);
          useCmsStore.getState().setError(message);
          return;
        }

        revalidationMessage = revalidationWarning(result);

        const data = result.data as {
          propic?: string;
          blurhashURL?: string;
        };

        setHeroSection(
          mergeHeroSettings(useCmsStore.getState().heroSection, {
            mainImage:
              data.propic ??
              useCmsStore.getState().heroSection?.mainImage ??
              null,
            blurhashURL:
              data.blurhashURL ??
              useCmsStore.getState().heroSection?.blurhashURL ??
              null,
          })
        );

        imgUpload.clearFile();
        if (data.propic) {
          imgUpload.setFileFromUrl(data.propic);
        }
      }

      // Written after the asset commit so the store always ends on the newest
      // display draft instead of the snapshot this callback closed over.
      if (displayDirty) {
        const result = await heroActions({
          type: 'UPDATE_DISPLAY',
          data: { shape },
        });

        if (!result.success) {
          const message = result.error || t('hero.errorUpdateHero');
          setError(message);
          useCmsStore.getState().setError(message);
          return;
        }

        revalidationMessage =
          revalidationWarning(result) ?? revalidationMessage;

        setHeroSection(
          mergeHeroSettings(useCmsStore.getState().heroSection, { shape })
        );
      }

      const transErrors = await saveTranslations();
      if (transErrors.length > 0) {
        const message = transErrors.join('\n');
        setError(message);
        useCmsStore.getState().setError(message);
      }
      if (revalidationMessage)
        useCmsStore.getState().setWarning(revalidationMessage);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('hero.errorUpdateHero');
      setError(message);
      useCmsStore.getState().setError(message);
    } finally {
      setIsUpdating(false);
    }
  }, [
    displayDirty,
    heroSection,
    imgUpload,
    saveTranslations,
    setHeroSection,
    shape,
    t,
  ]);

  const handleRevert = useCallback(() => {
    setShowConfirmRevert(false);
    imgUpload.clearFile();
    revertTranslations();
    setShape(normalizeHeroShape(heroSection?.shape));
    if (heroSection?.mainImage) {
      imgUpload.setFileFromUrl(heroSection.mainImage);
    }
    setError(null);
  }, [heroSection, imgUpload, revertTranslations]);

  useSectionCallbacks('hero', handlePublish, handleRevert);

  const copyUrl = (url: string) => {
    navigator.clipboard
      .writeText(url)
      .catch(() => setError(t('hero.errorCopyUrl')));
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );
  }

  return (
    <fieldset
      disabled={isUpdating}
      className="space-y-6 md:space-y-8 border-0 p-0 m-0 min-w-0"
    >
      <SectionHeader
        title={t('hero.title')}
        description={t('hero.subtitle')}
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

      {/* Hero Image */}
      <div className="bg-surface-card rounded-xl p-4 md:p-6">
        <h2 className="text-lg md:text-xl font-bold text-accent-violet mb-4">
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
                className="px-3 py-1.5 text-sm bg-surface-base text-text-main rounded-lg hover:bg-surface-card transition-colors"
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

      {/* Portrait shape */}
      <div className="bg-surface-card rounded-xl p-4 md:p-6 space-y-4">
        <h2 className="text-lg md:text-xl font-bold text-accent-violet">
          {t('hero.portraitSection')}
        </h2>

        <div>
          <label
            htmlFor="hero-shape"
            className="block text-sm font-medium text-text-main mb-1"
          >
            {t('hero.shapeLabel')}
          </label>
          <Dropdown
            id="hero-shape"
            triggerClassName={inputClass}
            onChange={(value) => setShape(normalizeHeroShape(value))}
            value={shape}
            options={heroShapes.map((preset) => ({
              value: preset,
              label: t(`hero.shapeOptions.${preset}`),
            }))}
          />
          <p className="mt-2 text-xs text-text-muted">{t('hero.shapeHint')}</p>
        </div>
      </div>

      {/* Identity and content */}
      <div className="bg-surface-card rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-accent-violet">
            {t('hero.identitySection')}
          </h2>
          <LocaleToggle
            activeLocale={activeLocale}
            onChange={setActiveLocale}
          />
        </div>

        {transLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-violet" />
          </div>
        ) : (
          <div className="space-y-6">
            <h3 className="text-base font-semibold text-text-main ">
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

            <div className="space-y-3">
              {Array.from({ length: roleCount }, (_, index) => (
                <div className="flex items-end gap-2" key={heroRolePath(index)}>
                  <div className="min-w-0 flex-1">
                    <TranslationField
                      label={`${t('hero.roleLabel')} ${index + 1}`}
                      enValue={getField('en', heroRolePath(index))}
                      itValue={getField('it', heroRolePath(index))}
                      onChangeEn={(v) => setField('en', heroRolePath(index), v)}
                      onChangeIt={(v) => setField('it', heroRolePath(index), v)}
                      activeLocale={activeLocale}
                    />
                  </div>
                  <div className="flex items-center gap-1 pb-1">
                    <button
                      aria-label={`${t('common.moveUp')}: ${index + 1}`}
                      className={`${iconButtonClass} hover:text-accent-violet`}
                      disabled={index === 0}
                      onClick={() => moveRole(index, -1)}
                      title={t('common.moveUp')}
                      type="button"
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button
                      aria-label={`${t('common.moveDown')}: ${index + 1}`}
                      className={`${iconButtonClass} hover:text-accent-violet`}
                      disabled={index === roleCount - 1}
                      onClick={() => moveRole(index, 1)}
                      title={t('common.moveDown')}
                      type="button"
                    >
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <button
                      aria-label={`${t('hero.removeRole')}: ${index + 1}`}
                      className={`${iconButtonClass} hover:text-red-400`}
                      onClick={() => removeRole(index)}
                      title={t('hero.removeRole')}
                      type="button"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs text-text-muted">{t('hero.rolesHint')}</p>
            <button
              className="inline-flex items-center gap-2 min-h-11 px-4 text-sm bg-surface-raised text-text-main rounded-lg hover:bg-surface-card"
              onClick={addRole}
              type="button"
            >
              <Plus className="w-4 h-4" />
              {t('hero.addRole')}
            </button>

            <h3 className="text-base font-semibold text-text-main pt-2">
              {t('hero.aboutMeSection')}
            </h3>
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
    </fieldset>
  );
}

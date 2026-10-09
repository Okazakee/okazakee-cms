'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { Dropdown } from '@/components/cms/shared/Dropdown';
import {
  EditorGroup,
  editorInputClass,
  editorPrimaryButtonClass,
} from '@/components/cms/shared/EditorBody';
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

  const openImage = useCallback(() => {
    if (mainImageUrl)
      window.open(mainImageUrl, '_blank', 'noopener,noreferrer');
  }, [mainImageUrl]);

  const copyImageUrl = useCallback(() => {
    if (!mainImageUrl) return;
    navigator.clipboard
      .writeText(mainImageUrl)
      .catch(() => setError(t('hero.errorCopyUrl')));
  }, [mainImageUrl, t]);

  const downloadPortrait = useCallback(async () => {
    if (!mainImageUrl) return;
    try {
      const res = await fetch(mainImageUrl);
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
  }, [mainImageUrl, t]);

  if (!heroSection) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-violet border-t-transparent" />
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

      <div className="flex justify-end">
        <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
      </div>

      <div className="flex flex-col gap-6">
        <EditorGroup
          title={t('editor.groups.portrait')}
          description={t('hero.shapeHint')}
        >
          <div className="w-full">
            <FileDropzone
              label={t('hero.heroImageTitle')}
              previewUrl={imgUpload.previewUrl}
              blurhash={imgUpload.blurhash}
              isDragging={imgUpload.isDragging}
              isProcessing={imgUpload.isProcessing}
              hasPendingFile={Boolean(imgUpload.file)}
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
              onCopyUrl={copyImageUrl}
              onOpen={openImage}
              onDownload={downloadPortrait}
              showUrl={mainImageUrl || null}
              actionsLayout="side"
            />
          </div>
          <div className="max-w-md">
            <label
              htmlFor="hero-shape"
              className="block text-sm font-medium text-text-main mb-1"
            >
              {t('hero.shapeLabel')}
            </label>
            <Dropdown
              id="hero-shape"
              triggerClassName={editorInputClass}
              onChange={(value) => setShape(normalizeHeroShape(value))}
              value={shape}
              options={heroShapes.map((preset) => ({
                value: preset,
                label: t(`hero.shapeOptions.${preset}`),
              }))}
            />
          </div>
        </EditorGroup>

        <EditorGroup
          title={t('editor.groups.identity')}
          description={t('hero.topSection')}
        >
          {transLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent-violet border-t-transparent" />
            </div>
          ) : (
            <TranslationField
              label={t('hero.nameLabel')}
              enValue={getField('en', 'top.name')}
              itValue={getField('it', 'top.name')}
              onChangeEn={(v) => setField('en', 'top.name', v)}
              onChangeIt={(v) => setField('it', 'top.name', v)}
              enPlaceholder={t('hero.namePlaceholder')}
              itPlaceholder={t('hero.namePlaceholder')}
              activeLocale={activeLocale}
              markerHighlight
            />
          )}
        </EditorGroup>

        <EditorGroup
          title={t('editor.groups.roles')}
          description={t('hero.rolesHint')}
          count={roleCount}
          actions={
            !transLoading ? (
              <button
                className={editorPrimaryButtonClass}
                onClick={addRole}
                type="button"
              >
                <Plus className="w-4 h-4" />
                {t('hero.addRole')}
              </button>
            ) : undefined
          }
        >
          {transLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent-violet border-t-transparent" />
            </div>
          ) : (
            <div className="space-y-3">
              {Array.from({ length: roleCount }, (_, index) => (
                <div
                  className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
                  key={heroRolePath(index)}
                >
                  <div className="min-w-0 flex-1">
                    <TranslationField
                      label={`${t('hero.roleLabel')} ${index + 1}`}
                      enValue={getField('en', heroRolePath(index))}
                      itValue={getField('it', heroRolePath(index))}
                      onChangeEn={(v) => setField('en', heroRolePath(index), v)}
                      onChangeIt={(v) => setField('it', heroRolePath(index), v)}
                      enPlaceholder={t('hero.rolePlaceholder')}
                      itPlaceholder={t('hero.rolePlaceholder')}
                      activeLocale={activeLocale}
                      markerHighlight
                    />
                  </div>
                  <div className="self-end pb-1">
                    <CardToolbar
                      showReorder
                      onMoveUp={() => moveRole(index, -1)}
                      onMoveDown={() => moveRole(index, 1)}
                      onDelete={() => removeRole(index)}
                      isFirst={index === 0}
                      isLast={index === roleCount - 1}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </EditorGroup>

        <EditorGroup
          title={t('editor.groups.about')}
          description={t('hero.aboutMeSection')}
        >
          {transLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent-violet border-t-transparent" />
            </div>
          ) : (
            <TranslationField
              label={t('hero.aboutMeParagraphLabel')}
              enValue={getField('en', 'aboutme.paragraph')}
              itValue={getField('it', 'aboutme.paragraph')}
              onChangeEn={(v) => setField('en', 'aboutme.paragraph', v)}
              onChangeIt={(v) => setField('it', 'aboutme.paragraph', v)}
              enPlaceholder={t('hero.aboutMeParagraphPlaceholder')}
              itPlaceholder={t('hero.aboutMeParagraphPlaceholder')}
              activeLocale={activeLocale}
              type="textarea"
              rows={8}
              markerHighlight
            />
          )}
        </EditorGroup>
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

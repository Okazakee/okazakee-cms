'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type LogoVariant,
  siteSettingsActions,
} from '@/app/actions/cms/sections/siteSettingsActions';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import {
  italianNavLabels,
  LayoutPreview,
} from '@/components/common/cms/previews/LayoutPreview';
import {
  type UseFileUploadReturn,
  useFileUpload,
} from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import type { SiteSettings } from '@/types/fetchedData.types';
import {
  type NavAnchorDraft,
  navItemIds,
  parseNavAnchorDrafts,
} from '@/utils/cms/navAnchors';

const EMPTY_SETTINGS: SiteSettings = {
  header_logo_dark: null,
  header_logo_light: null,
  nav_anchors: parseNavAnchorDrafts(null),
};

/**
 * The public header: the six navigation labels plus the two chrome labels the
 * site reads straight from this namespace (`NavMenu` uses `header.theme` for
 * the theme toggle's accessible name and `header.language` for the language
 * row), plus the header's own configuration — the per-theme logo and the
 * anchor each nav item points at.
 *
 * Anchors are index-aligned with the labels because both are index-addressed;
 * they are applied by `id` on the public side.
 */
export default function HeaderSection() {
  const t = useTranslations('cms');
  const [locale, setLocale] = useState<'en' | 'it'>('en');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<SiteSettings>(EMPTY_SETTINGS);
  const [savedSettings, setSavedSettings] =
    useState<SiteSettings>(EMPTY_SETTINGS);
  const [anchors, setAnchors] = useState<NavAnchorDraft[]>(
    EMPTY_SETTINGS.nav_anchors
  );
  const [savedAnchors, setSavedAnchors] = useState<NavAnchorDraft[]>(
    EMPTY_SETTINGS.nav_anchors
  );
  const [cleared, setCleared] = useState<Record<LogoVariant, boolean>>({
    dark: false,
    light: false,
  });
  const header = useSectionTranslations('header');

  const darkUpload = useFileUpload({
    accept: 'image/*',
    maxSizeMB: 10,
    imageProcessing: { maxWidth: 1024, maxHeight: 256, quality: 0.9 },
  });
  const lightUpload = useFileUpload({
    accept: 'image/*',
    maxSizeMB: 10,
    imageProcessing: { maxWidth: 1024, maxHeight: 256, quality: 0.9 },
  });
  const logoInitRef = useRef(false);

  const anchorsDirty = anchors.some(
    (entry, index) => entry.anchor !== savedAnchors[index]?.anchor
  );
  const isDirty =
    header.isDirty ||
    anchorsDirty ||
    cleared.dark ||
    cleared.light ||
    darkUpload.file !== null ||
    lightUpload.file !== null;
  useSectionDirty('header', isDirty);

  const beginLoad = useLatestRequest();
  const fetchSettings = useCallback(async () => {
    const current = beginLoad();
    setIsLoading(true);
    try {
      const r = await siteSettingsActions({ type: 'GET' });
      if (!current()) return;
      if (!r.success) throw new Error(r.error || 'Failed to fetch');
      const server = (r.data as SiteSettings | null) ?? EMPTY_SETTINGS;
      setSettings(server);
      setSavedSettings(server);
      setAnchors(server.nav_anchors);
      setSavedAnchors(server.nav_anchors);
      setCleared({ dark: false, light: false });
    } catch (err) {
      if (current())
        setError(err instanceof Error ? err.message : t('layout.errorFetch'));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [beginLoad, t]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (logoInitRef.current) return;
    logoInitRef.current = true;
    if (settings.header_logo_dark)
      darkUpload.setFileFromUrl(settings.header_logo_dark);
    if (settings.header_logo_light)
      lightUpload.setFileFromUrl(settings.header_logo_light);
  }, [settings, darkUpload, lightUpload]);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    useCmsStore.getState().setError(null);
    try {
      const failures: string[] = [];
      let warning: string | null = null;
      let committed = settings;

      // Logos first: an upload stages a new object and commits the row, so a
      // failed anchor write must not undo it silently.
      for (const variant of ['dark', 'light'] as const) {
        const upload = variant === 'dark' ? darkUpload : lightUpload;
        const column =
          variant === 'dark' ? 'header_logo_dark' : 'header_logo_light';
        const file = upload.file;
        if (!file && !(cleared[variant] && committed[column])) continue;

        const result = file
          ? await siteSettingsActions({ type: 'UPLOAD_LOGO', variant, file })
          : await siteSettingsActions({ type: 'CLEAR_LOGO', variant });

        if (!result.success) {
          failures.push(result.error || `Failed to save the ${variant} logo`);
          continue;
        }
        warning = revalidationWarning(result) ?? warning;
        committed = (result.data as SiteSettings) ?? committed;
        upload.clearFile();
      }

      if (failures.length > 0) {
        const message = failures.join('\n');
        setError(message);
        useCmsStore.getState().setError(message);
        throw new Error(message);
      }

      if (anchorsDirty) {
        const result = await siteSettingsActions({
          type: 'UPDATE_ANCHORS',
          anchors,
        });
        if (!result.success) {
          const message = result.error || t('layout.errorAnchors');
          setError(message);
          useCmsStore.getState().setError(message);
          throw new Error(message);
        }
        warning = revalidationWarning(result) ?? warning;
        committed = (result.data as SiteSettings) ?? committed;
      }

      setSettings(committed);
      setSavedSettings(committed);
      setAnchors(committed.nav_anchors);
      setSavedAnchors(committed.nav_anchors);
      setCleared({ dark: false, light: false });
      if (committed.header_logo_dark)
        darkUpload.setFileFromUrl(committed.header_logo_dark);
      if (committed.header_logo_light)
        lightUpload.setFileFromUrl(committed.header_logo_light);

      const errors = await header.saveTranslations();
      if (errors.length) throw new Error(errors.join('\n'));
      if (warning) useCmsStore.getState().setWarning(warning);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('common.saveFailed');
      setError(message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [
    anchors,
    anchorsDirty,
    cleared,
    darkUpload,
    header,
    lightUpload,
    settings,
    t,
  ]);

  const revert = () => {
    header.revertTranslations();
    darkUpload.clearFile();
    lightUpload.clearFile();
    setAnchors(savedSettings.nav_anchors);
    setCleared({ dark: false, light: false });
    setError(null);
    if (savedSettings.header_logo_dark)
      darkUpload.setFileFromUrl(savedSettings.header_logo_dark);
    if (savedSettings.header_logo_light)
      lightUpload.setFileFromUrl(savedSettings.header_logo_light);
  };
  useSectionCallbacks('header', publish, revert);

  const drafts = Object.fromEntries(
    (['en', 'it'] as const).map((language) => [
      language,
      Object.fromEntries(
        Object.entries(header.translations[language]).map(([key, value]) => [
          `header.${key}`,
          value,
        ])
      ),
    ])
  ) as Record<'en' | 'it', Record<string, string>>;

  const field = (path: string, label: string, fixedValue?: string) => (
    <label key={path} className="block space-y-2 text-xs text-text-muted">
      <span>{label}</span>
      <input
        type="text"
        value={fixedValue ?? header.getField(locale, path)}
        disabled={fixedValue !== undefined}
        onChange={(e) => header.setField(locale, path, e.target.value)}
        className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
      />
    </label>
  );

  const setAnchor = (index: number, anchor: string) =>
    setAnchors((previous) =>
      previous.map((entry, position) =>
        position === index ? { ...entry, anchor } : entry
      )
    );

  const logoDropzone = (
    variant: LogoVariant,
    label: string,
    storedUrl: string | null,
    upload: UseFileUploadReturn
  ) => (
    <div>
      <FileDropzone
        compact
        currentUrl={storedUrl}
        dropzoneProps={{
          onDragOver: upload.dropzoneProps.onDragOver,
          onDragLeave: upload.dropzoneProps.onDragLeave,
          onDrop: upload.dropzoneProps.onDrop,
        }}
        error={upload.error}
        fileInputProps={upload.fileInputProps}
        fileInputRef={upload.fileInputRef}
        isDragging={upload.isDragging}
        isProcessing={upload.isProcessing}
        label={label}
        onBrowse={upload.openFileDialog}
        onClear={() => {
          upload.clearFile();
          setCleared((previous) => ({ ...previous, [variant]: true }));
        }}
        previewUrl={upload.previewUrl}
      />
      <p className="mt-2 text-xs text-text-dim">
        {storedUrl
          ? t('layout.headerLogoStoredNote')
          : t('layout.headerLogoFallbackNote')}
      </p>
    </div>
  );

  return (
    <fieldset disabled={busy || header.isLoading} className="min-w-0 space-y-6">
      <SectionHeader
        title={t('headerSection.title')}
        description={t('headerSection.subtitle')}
        actions={
          <SectionActions
            isDirty={isDirty}
            busy={busy}
            onPublish={() => publish().catch(() => {})}
            onRevert={revert}
            onPreview={() => setPreviewOpen(true)}
          />
        }
      />
      <ErrorBanner
        message={error || header.error}
        onDismiss={() => setError(null)}
      />
      <LocaleToggle activeLocale={locale} onChange={setLocale} />
      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.headerLogosTitle')}
        </h2>
        {isLoading ? (
          <p className="text-xs text-text-dim">{t('common.loading')}</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            {logoDropzone(
              'dark',
              t('layout.headerLogoDarkLabel'),
              settings.header_logo_dark,
              darkUpload
            )}
            {logoDropzone(
              'light',
              t('layout.headerLogoLightLabel'),
              settings.header_logo_light,
              lightUpload
            )}
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.headerTranslationsTitle')}
        </h2>
        <h3 className="mb-4 text-xs uppercase tracking-widest text-text-dim">
          {t('layout.headerNavButtonsLabel')}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {navItemIds.map((section, index) =>
            field(
              `buttons.${index}`,
              t(`layout.nav.${section}`),
              locale === 'it' ? italianNavLabels[index] : undefined
            )
          )}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-text-dim">
          {t('layout.fixedNavigation')}
        </p>
        <h3 className="mt-8 mb-1 text-xs uppercase tracking-widest text-text-dim">
          {t('layout.headerAnchorsLabel')}
        </h3>
        <p className="mb-4 text-xs leading-relaxed text-text-dim">
          {t('layout.headerAnchorsNote')}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {anchors.map((entry, index) => {
            const id = entry.id as (typeof navItemIds)[number];
            // An anchor equal to the item id is the un-arranged default, so the
            // site renders exactly the href it always has.
            const isDefault = entry.anchor === id;
            return (
              <label
                key={entry.id}
                className="block space-y-2 text-xs text-text-muted"
              >
                <span>{t(`layout.nav.${id}`)}</span>
                <input
                  type="text"
                  value={entry.anchor}
                  onChange={(e) => setAnchor(index, e.target.value)}
                  className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
                />
                {isDefault && (
                  <span className="block font-mono text-[11px] text-text-dim">
                    {t('layout.headerAnchorDefaultLabel')}: #{id}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <h3 className="mt-8 mb-4 text-xs uppercase tracking-widest text-text-dim">
          {t('layout.headerSettingsLabel')}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('theme', t('layout.headerThemeLabel'))}
          {field('language', t('layout.headerLanguageLabel'))}
          {field('resume', t('layout.headerResumeLabel'))}
        </div>
      </section>
      <PreviewModal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('layout.previewTitle')}
        copy={{ locale, namespace: '', drafts }}
      >
        <LayoutPreview
          part="header"
          logos={{
            dark: darkUpload.previewUrl ?? settings.header_logo_dark,
            light: lightUpload.previewUrl ?? settings.header_logo_light,
          }}
          anchors={anchors}
        />
      </PreviewModal>
    </fieldset>
  );
}

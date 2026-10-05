'use client';

import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import {
  type LogoVariant,
  siteSettingsActions,
} from '@/app/actions/cms/sections/siteSettingsActions';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { LayoutPreview } from '@/components/common/cms/previews/LayoutPreview';
import {
  type UseFileUploadReturn,
  useFileUpload,
} from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { mergeHeroSettings, useCmsStore } from '@/store/cmsStore';
import type { SiteSettings } from '@/types/fetchedData.types';
import {
  type NavAnchorDraft,
  type navItemIds,
  parseNavAnchorDrafts,
} from '@/utils/cms/navAnchors';

const EMPTY_SETTINGS: SiteSettings = {
  header_logo_dark: null,
  header_logo_light: null,
  nav_anchors: parseNavAnchorDrafts(null),
  footer_name: null,
  footer_vat_number: null,
};

interface FooterDraft {
  name: string;
  vatNumber: string;
}

const EMPTY_FOOTER: FooterDraft = { name: '', vatNumber: '' };

/**
 * The committed footer row as editable text: a null column is an empty field,
 * which is exactly the state that publishes back as null.
 */
const footerFromSettings = (settings: SiteSettings): FooterDraft => ({
  name: settings.footer_name ?? '',
  vatNumber: settings.footer_vat_number ?? '',
});

/**
 * Layout owns the chrome that frames the page: the per-theme logo, the anchor
 * each of the six fixed nav items points at, the résumé PDFs behind the hero
 * download button, and the footer identity (display name + VAT number).
 *
 * The header/footer chrome copy itself is frozen on the site and read from
 * local message files, so there is nothing to translate here — every field
 * below is data, not chrome wording.
 *
 * Each group (logos → anchors → footer → résumé) commits on its own and is
 * synchronised the moment it succeeds, so a later failure can never look like
 * the earlier writes were rolled back, and a retry never re-uploads a file
 * that already landed.
 */
export function LayoutSection() {
  const t = useTranslations('cms');
  const { heroSection, setHeroSection } = useCmsStore();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<SiteSettings>(EMPTY_SETTINGS);
  const settingsRef = useRef<SiteSettings>(settings);
  const [anchors, setAnchors] = useState<NavAnchorDraft[]>(
    EMPTY_SETTINGS.nav_anchors
  );
  const [savedAnchors, setSavedAnchors] = useState<NavAnchorDraft[]>(
    EMPTY_SETTINGS.nav_anchors
  );
  const [footer, setFooter] = useState<FooterDraft>(EMPTY_FOOTER);
  const [cleared, setCleared] = useState<Record<LogoVariant, boolean>>({
    dark: false,
    light: false,
  });

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
  const resumeEnUpload = useFileUpload({ accept: '.pdf', maxSizeMB: 10 });
  const resumeItUpload = useFileUpload({ accept: '.pdf', maxSizeMB: 10 });
  const logoInitRef = useRef(false);
  const resumeInitRef = useRef(false);

  /** Publishes read the latest committed row, not the render they closed over. */
  const commitSettings = useCallback((next: SiteSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const anchorsDirty = anchors.some(
    (entry, index) => entry.anchor !== savedAnchors[index]?.anchor
  );
  const isFooterDirty =
    footer.name !== (settings.footer_name ?? '') ||
    footer.vatNumber !== (settings.footer_vat_number ?? '');
  const isDirty =
    anchorsDirty ||
    isFooterDirty ||
    cleared.dark ||
    cleared.light ||
    darkUpload.file !== null ||
    lightUpload.file !== null ||
    resumeEnUpload.file !== null ||
    resumeItUpload.file !== null;
  useSectionDirty('layout', isDirty);

  const beginLoad = useLatestRequest();
  const fetchSettings = useCallback(async () => {
    const current = beginLoad();
    setIsLoading(true);
    try {
      const r = await siteSettingsActions({ type: 'GET' });
      if (!current()) return;
      if (!r.success) throw new Error(r.error || 'Failed to fetch');
      const server = (r.data as SiteSettings | null) ?? EMPTY_SETTINGS;
      commitSettings(server);
      setAnchors(server.nav_anchors);
      setSavedAnchors(server.nav_anchors);
      setFooter(footerFromSettings(server));
      setCleared({ dark: false, light: false });
    } catch (err) {
      if (current())
        setError(err instanceof Error ? err.message : t('layout.errorFetch'));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [beginLoad, commitSettings, t]);

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

  useEffect(() => {
    if (!heroSection || resumeInitRef.current) return;
    resumeInitRef.current = true;
    if (heroSection.resume_en)
      resumeEnUpload.setFileFromUrl(heroSection.resume_en);
    if (heroSection.resume_it)
      resumeItUpload.setFileFromUrl(heroSection.resume_it);
  }, [heroSection, resumeEnUpload, resumeItUpload]);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    useCmsStore.getState().setError(null);

    const failures: string[] = [];
    let warning: string | null = null;
    const committedLogos: LogoVariant[] = [];

    try {
      // 1. Logos. An upload stages a new object and commits the row, so it is
      //    synced on its own before any later group runs.
      for (const variant of ['dark', 'light'] as const) {
        const upload = variant === 'dark' ? darkUpload : lightUpload;
        const file = upload.file;
        const column =
          variant === 'dark' ? 'header_logo_dark' : 'header_logo_light';
        if (!file && !(cleared[variant] && settingsRef.current[column]))
          continue;

        const result = file
          ? await siteSettingsActions({ type: 'UPLOAD_LOGO', variant, file })
          : await siteSettingsActions({ type: 'CLEAR_LOGO', variant });

        if (!result.success) {
          failures.push(result.error || `Failed to save the ${variant} logo`);
          continue;
        }
        warning = revalidationWarning(result) ?? warning;
        commitSettings((result.data as SiteSettings) ?? settingsRef.current);
        committedLogos.push(variant);
        upload.clearFile();
        setCleared((previous) => ({ ...previous, [variant]: false }));
      }

      // 2. Anchors.
      if (anchorsDirty) {
        const result = await siteSettingsActions({
          type: 'UPDATE_ANCHORS',
          anchors,
        });
        if (!result.success) {
          failures.push(result.error || t('layout.errorAnchors'));
        } else {
          warning = revalidationWarning(result) ?? warning;
          const committed = result.data as SiteSettings | undefined;
          if (committed) commitSettings(committed);
          const nextAnchors = committed?.nav_anchors ?? anchors;
          setAnchors(nextAnchors);
          setSavedAnchors(nextAnchors);
        }
      }

      // 3. Footer identity.
      if (isFooterDirty) {
        const result = await siteSettingsActions({
          type: 'UPDATE_FOOTER',
          name: footer.name,
          vatNumber: footer.vatNumber,
        });
        if (!result.success) {
          failures.push(result.error || t('common.saveFailed'));
        } else {
          warning = revalidationWarning(result) ?? warning;
          const committed = result.data as SiteSettings | undefined;
          if (committed) commitSettings(committed);
          setFooter(footerFromSettings(committed ?? settingsRef.current));
        }
      }

      // 4. Résumé PDFs. Only the supplied files are sent, so the untouched
      //    language keeps its stored URL.
      if (resumeEnUpload.file || resumeItUpload.file) {
        const result = await heroActions({
          type: 'UPDATE_WITH_FILES',
          files: {
            ...(resumeEnUpload.file ? { resume_en: resumeEnUpload.file } : {}),
            ...(resumeItUpload.file ? { resume_it: resumeItUpload.file } : {}),
          },
        });
        if (!result.success) {
          failures.push(result.error || t('common.saveFailed'));
        } else {
          const data = (result.data ?? {}) as {
            resume_en?: string;
            resume_it?: string;
          };
          setHeroSection(
            mergeHeroSettings(heroSection, {
              resume_en: data.resume_en ?? heroSection?.resume_en ?? null,
              resume_it: data.resume_it ?? heroSection?.resume_it ?? null,
            })
          );
          warning = revalidationWarning(result) ?? warning;
          resumeEnUpload.clearFile();
          resumeItUpload.clearFile();
        }
      }

      // Only a logo that actually committed is re-seeded: seeding one whose
      // upload failed would clear its pending File and silently drop the draft.
      for (const variant of committedLogos) {
        const url =
          variant === 'dark'
            ? settingsRef.current.header_logo_dark
            : settingsRef.current.header_logo_light;
        const upload = variant === 'dark' ? darkUpload : lightUpload;
        if (url) upload.setFileFromUrl(url);
      }

      if (warning) useCmsStore.getState().setWarning(warning);

      if (failures.length > 0) {
        // Everything above that succeeded is already committed and synced; the
        // remaining drafts stay dirty on purpose so a retry resends only them.
        const message = failures.join('\n');
        setError(message);
        useCmsStore.getState().setError(message);
        throw new Error(message);
      }

      useCmsStore.getState().setError(null);
    } finally {
      setBusy(false);
    }
  }, [
    anchors,
    anchorsDirty,
    cleared,
    commitSettings,
    darkUpload,
    footer,
    heroSection,
    isFooterDirty,
    lightUpload,
    resumeEnUpload,
    resumeItUpload,
    setHeroSection,
    t,
  ]);

  const revert = () => {
    setError(null);
    setAnchors(savedAnchors);
    setFooter(footerFromSettings(settingsRef.current));
    setCleared({ dark: false, light: false });
    darkUpload.clearFile();
    lightUpload.clearFile();
    if (settingsRef.current.header_logo_dark)
      darkUpload.setFileFromUrl(settingsRef.current.header_logo_dark);
    if (settingsRef.current.header_logo_light)
      lightUpload.setFileFromUrl(settingsRef.current.header_logo_light);
    resumeEnUpload.clearFile();
    resumeItUpload.clearFile();
    if (heroSection?.resume_en)
      resumeEnUpload.setFileFromUrl(heroSection.resume_en);
    if (heroSection?.resume_it)
      resumeItUpload.setFileFromUrl(heroSection.resume_it);
  };
  useSectionCallbacks('layout', publish, revert);

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

  const resumeDropzone = (
    label: string,
    upload: UseFileUploadReturn,
    currentUrl: string | null
  ) => (
    <div>
      <h3 className="mb-2 text-sm font-medium text-text-main">{label}</h3>
      <FileDropzone
        compact
        currentUrl={currentUrl}
        dropzoneProps={{
          onDragOver: upload.dropzoneProps.onDragOver,
          onDragLeave: upload.dropzoneProps.onDragLeave,
          onDrop: upload.dropzoneProps.onDrop,
        }}
        error={upload.error}
        fileInputProps={{ ...upload.fileInputProps, accept: '.pdf' }}
        fileInputRef={upload.fileInputRef}
        isDragging={upload.isDragging}
        isProcessing={upload.isProcessing}
        onBrowse={upload.openFileDialog}
        onClear={upload.clearFile}
        previewUrl={upload.previewUrl}
      />
      {currentUrl && !upload.file && (
        <a
          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-surface-base px-3 py-1.5 text-sm text-text-main transition-colors hover:bg-surface-card"
          href={currentUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink className="h-3 w-3" />
          {t('layout.resumeOpenLabel')}
        </a>
      )}
    </div>
  );

  const footerField = (key: keyof FooterDraft, label: string) => (
    <label className="block space-y-2 text-xs text-text-muted">
      <span>{label}</span>
      <input
        className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
        onChange={(event) =>
          setFooter((previous) => ({
            ...previous,
            [key]: event.target.value,
          }))
        }
        type="text"
        value={footer[key]}
      />
    </label>
  );

  return (
    <fieldset className="min-w-0 space-y-6" disabled={busy || isLoading}>
      <SectionHeader
        actions={
          <SectionActions
            busy={busy}
            isDirty={isDirty}
            onPreview={() => setPreviewOpen(true)}
            onPublish={() => publish().catch(() => {})}
            onRevert={revert}
          />
        }
        description={t('layout.subtitle')}
        title={t('layout.title')}
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

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
        <h2 className="mb-1 text-lg font-bold text-text-white">
          {t('layout.headerAnchorsLabel')}
        </h2>
        <p className="mb-5 text-xs leading-relaxed text-text-dim">
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
                className="block space-y-2 text-xs text-text-muted"
                key={entry.id}
              >
                <span>{t(`layout.nav.${id}`)}</span>
                <input
                  className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
                  onChange={(event) => setAnchor(index, event.target.value)}
                  type="text"
                  value={entry.anchor}
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
      </section>

      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.resumeLinksTitle')}
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          {resumeDropzone(
            t('layout.resumeEnglishLabel'),
            resumeEnUpload,
            heroSection?.resume_en ?? null
          )}
          {resumeDropzone(
            t('layout.resumeItalianLabel'),
            resumeItUpload,
            heroSection?.resume_it ?? null
          )}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-text-dim">
          {t('layout.resumePdfNote')}
        </p>
      </section>

      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 text-lg font-bold text-text-white">
          {t('layout.footerIdentityTitle')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {footerField('name', t('layout.footerNameLabel'))}
          {footerField('vatNumber', t('layout.footerVatNumberLabel'))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-text-dim">
          {t('layout.footerDefaultsNote')}
        </p>
      </section>

      <PreviewModal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('layout.previewTitle')}
      >
        <LayoutPreview
          anchors={anchors}
          footer={{
            name: footer.name.trim() || null,
            vatNumber: footer.vatNumber.trim() || null,
          }}
          logos={{
            dark: darkUpload.previewUrl ?? settings.header_logo_dark,
            light: lightUpload.previewUrl ?? settings.header_logo_light,
          }}
          resumeLinks={{
            en: resumeEnUpload.previewUrl ?? heroSection?.resume_en ?? null,
            it: resumeItUpload.previewUrl ?? heroSection?.resume_it ?? null,
          }}
        />
      </PreviewModal>
    </fieldset>
  );
}

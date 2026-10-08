'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiteSettingsResult } from '@/app/actions/cms/sections/siteSettingsActions';
import { siteSettingsActions } from '@/app/actions/cms/sections/siteSettingsActions';
import { EditorGroup } from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import type { SiteSettings } from '@/types/fetchedData.types';

const emptySettings: SiteSettings = {
  header_logo_dark: null,
  header_logo_light: null,
  footer_vat_number: null,
};
const logoUploadOptions = {
  accept: 'image/png,image/jpeg,image/webp,image/gif',
  // Headers are wide logos: bound them without cropping their aspect ratio.
  imageProcessing: {
    maxWidth: 1024,
    maxHeight: 256,
    quality: 0.9,
    fit: 'inside' as const,
  },
};

export function LayoutSection() {
  const t = useTranslations('cms');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<SiteSettings>(emptySettings);
  const settingsRef = useRef(settings);
  const [vatNumber, setVatNumber] = useState('');
  const darkUpload = useFileUpload(logoUploadOptions);
  const lightUpload = useFileUpload(logoUploadOptions);
  const [removals, setRemovals] = useState({ dark: false, light: false });
  const processing = darkUpload.isProcessing || lightUpload.isProcessing;
  const isDirty =
    vatNumber !== (settings.footer_vat_number ?? '') ||
    !!darkUpload.file ||
    !!lightUpload.file ||
    removals.dark ||
    removals.light;
  useSectionDirty('layout', isDirty);

  const commitSettings = useCallback((next: SiteSettings) => {
    settingsRef.current = next;
    setSettings(next);
    setVatNumber(next.footer_vat_number ?? '');
  }, []);

  const beginLoad = useLatestRequest();
  const fetchSettings = useCallback(async () => {
    const current = beginLoad();
    setIsLoading(true);
    try {
      const result = await siteSettingsActions({ type: 'GET' });
      if (!current()) return;
      if (!result.success)
        throw new Error(result.error || t('layout.errorFetch'));
      commitSettings((result.data as SiteSettings | null) ?? emptySettings);
    } catch (err) {
      if (current()) {
        setError(err instanceof Error ? err.message : t('layout.errorFetch'));
      }
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [beginLoad, commitSettings, t]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const publish = useCallback(async () => {
    if (!isDirty || processing) return;
    setBusy(true);
    setError(null);
    useCmsStore.getState().setError(null);
    try {
      const vatDirty = vatNumber !== (settings.footer_vat_number ?? '');
      const acceptResult = (result: SiteSettingsResult) => {
        if (!result.success || !result.data) {
          throw new Error(result.error || t('common.saveFailed'));
        }
        const next = result.data as SiteSettings;
        settingsRef.current = next;
        setSettings(next);
        if (!vatDirty) setVatNumber(next.footer_vat_number ?? '');
        const warning = revalidationWarning(result);
        if (warning) useCmsStore.getState().setWarning(warning);
        return next;
      };
      for (const variant of ['dark', 'light'] as const) {
        const upload = variant === 'dark' ? darkUpload : lightUpload;
        if (!upload.file && !removals[variant]) continue;
        const result = await siteSettingsActions(
          upload.file
            ? { type: 'UPLOAD_LOGO', variant, file: upload.file }
            : { type: 'CLEAR_LOGO', variant }
        );
        acceptResult(result);
        upload.clearFile();
        setRemovals((previous) => ({ ...previous, [variant]: false }));
      }
      if (vatDirty) {
        const result = await siteSettingsActions({
          type: 'UPDATE_VAT',
          vatNumber,
        });
        const next = acceptResult(result);
        setVatNumber(next.footer_vat_number ?? '');
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('common.saveFailed');
      setError(message);
      useCmsStore.getState().setError(message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [
    darkUpload,
    lightUpload,
    removals,
    processing,
    isDirty,
    settings,
    t,
    vatNumber,
  ]);

  const revert = () => {
    setError(null);
    setVatNumber(settingsRef.current.footer_vat_number ?? '');
    darkUpload.clearFile();
    lightUpload.clearFile();
    setRemovals({ dark: false, light: false });
  };
  useSectionCallbacks('layout', publish, revert);

  return (
    <fieldset
      className="min-w-0 space-y-6"
      disabled={busy || isLoading || processing}
    >
      <SectionHeader
        actions={
          <SectionActions
            busy={busy}
            isDirty={isDirty}
            onPublish={publish}
            onRevert={revert}
          />
        }
        description={t('layout.subtitle')}
        title={t('layout.title')}
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <EditorGroup
        title={t('editor.groups.branding')}
        description={t('layout.headerLogoNote')}
      >
        <div className="grid gap-4 md:grid-cols-2">
          {(['dark', 'light'] as const).map((variant) => {
            const upload = variant === 'dark' ? darkUpload : lightUpload;
            const removed = removals[variant] && !upload.file;
            return (
              <section
                key={variant}
                data-testid={`header-logo-${variant}`}
                className="space-y-3 rounded-xl border border-border-subtle bg-surface-base p-4"
              >
                <h3 className="text-sm font-semibold text-text-white">
                  {t(
                    `layout.headerLogo${variant === 'dark' ? 'Dark' : 'Light'}Title`
                  )}
                </h3>
                <FileDropzone
                  {...upload}
                  hasPendingFile={Boolean(upload.file)}
                  onBrowse={upload.openFileDialog}
                  onClear={() => {
                    if (upload.file) upload.clearFile();
                    else
                      setRemovals((previous) => ({
                        ...previous,
                        [variant]: true,
                      }));
                  }}
                  currentUrl={
                    removed ? null : settings[`header_logo_${variant}`]
                  }
                  previewUrl={upload.previewUrl}
                />
                {removals[variant] && (
                  <div className="space-y-2 text-xs text-text-muted">
                    <p>{t('layout.headerLogoRemovalNote')}</p>
                    <button
                      type="button"
                      onClick={() =>
                        setRemovals((previous) => ({
                          ...previous,
                          [variant]: false,
                        }))
                      }
                      className="min-h-11 rounded-lg border border-border-subtle px-3"
                    >
                      {t('layout.headerLogoUndoRemoval')}
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </EditorGroup>
      <EditorGroup
        title={t('editor.groups.footer')}
        description={t('layout.footerVatHint')}
      >
        {isLoading ? (
          <p className="text-xs text-text-dim">{t('common.loading')}</p>
        ) : (
          <label className="block space-y-2 text-xs text-text-muted">
            <span>{t('layout.footerVatNumberLabel')}</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main focus:border-accent-violet focus:outline-none"
              onChange={(event) => setVatNumber(event.target.value)}
              type="text"
              value={vatNumber}
            />
          </label>
        )}
      </EditorGroup>
    </fieldset>
  );
}

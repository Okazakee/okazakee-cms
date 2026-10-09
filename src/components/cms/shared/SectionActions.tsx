'use client';

import { RotateCcw, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { useCmsStore } from '@/store/cmsStore';

interface SectionActionsProps {
  isDirty: boolean;
  busy: boolean;
  onPublish: () => Promise<void>;
  onRevert: () => void;
}

export function SectionActions({
  isDirty,
  busy,
  onPublish,
  onRevert,
}: SectionActionsProps) {
  const t = useTranslations('cms.common');
  const isPublishingAll = useCmsStore((state) => state.isPublishingAll);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const unavailable = busy || publishing || isPublishingAll;
  const confirmPublish = async () => {
    if (
      locked.current ||
      unavailable ||
      useCmsStore.getState().isPublishingAll ||
      !isDirty ||
      !confirming
    )
      return;
    locked.current = true;
    setConfirming(false);
    setPublishing(true);
    setError(null);
    try {
      await onPublish();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      locked.current = false;
      setPublishing(false);
    }
  };
  const secondary =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-4 py-2 text-sm text-text-main hover:border-border-hover disabled:opacity-50';
  return (
    <>
      <button
        type="button"
        className={secondary}
        disabled={!isDirty || unavailable}
        onClick={onRevert}
      >
        <RotateCcw className="h-4 w-4" />
        {t('revert')}
      </button>
      <button
        type="button"
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent-violet-deep px-4 py-2 text-sm text-white hover:bg-accent-violet disabled:opacity-50"
        disabled={!isDirty || unavailable}
        onClick={() => setConfirming(true)}
      >
        <Upload className="h-4 w-4" />
        {unavailable ? t('publishing') : t('publish')}
      </button>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <ConfirmDialog
        isOpen={confirming}
        title={t('publishConfirmTitle')}
        message={t('publishConfirmMessage')}
        confirmLabel={t('publish')}
        confirmVariant="primary"
        confirmDisabled={!isDirty || unavailable}
        onConfirm={() => void confirmPublish()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

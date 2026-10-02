'use client';

import { Eye, RotateCcw, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface SectionActionsProps {
  isDirty: boolean;
  busy: boolean;
  onPublish: () => Promise<void>;
  onRevert: () => void;
  onPreview?: () => void;
}

export function SectionActions({
  isDirty,
  busy,
  onPublish,
  onRevert,
  onPreview,
}: SectionActionsProps) {
  const t = useTranslations('cms.common');
  const secondary =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-4 py-2 text-sm text-text-main hover:border-border-hover disabled:opacity-50';
  return (
    <>
      {onPreview && (
        <button
          type="button"
          className={secondary}
          disabled={busy}
          onClick={onPreview}
        >
          <Eye className="h-4 w-4" />
          {t('preview')}
        </button>
      )}
      <button
        type="button"
        className={secondary}
        disabled={!isDirty || busy}
        onClick={onRevert}
      >
        <RotateCcw className="h-4 w-4" />
        {t('revert')}
      </button>
      <button
        type="button"
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent-violet-deep px-4 py-2 text-sm text-white hover:bg-accent-violet disabled:opacity-50"
        disabled={!isDirty || busy}
        onClick={() => void onPublish()}
      >
        <Upload className="h-4 w-4" />
        {busy ? t('publishing') : t('publish')}
      </button>
    </>
  );
}

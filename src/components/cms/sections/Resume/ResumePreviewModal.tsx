'use client';

import { Download } from 'lucide-react';
import { ModalShell } from '@/components/cms/shared/ModalShell';
import { ResumePreview } from './ResumePreview';

export function ResumePreviewModal({
  html,
  title,
  overflowMessage,
  downloadLabel,
  closeLabel,
  onDownloadHtml,
  onClose,
}: {
  html: string;
  title: string;
  overflowMessage: string;
  downloadLabel: string;
  closeLabel: string;
  onDownloadHtml: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      actions={
        <button
          type="button"
          onClick={onDownloadHtml}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{downloadLabel}</span>
        </button>
      }
    >
      <ResumePreview
        html={html}
        title={title}
        overflowMessage={overflowMessage}
      />
    </ModalShell>
  );
}

'use client';

import { Download, X } from 'lucide-react';
import { useEffect } from 'react';
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex"
    >
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70"
      />
      <div className="relative flex h-full w-full flex-col bg-surface-base sm:m-auto sm:h-[92dvh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-border-subtle sm:shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-4">
          <h2 className="min-w-0 truncate text-lg font-bold text-text-white">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onDownloadHtml}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {downloadLabel}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border-subtle bg-surface-card text-text-main transition-colors hover:bg-surface-raised"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <ResumePreview
            html={html}
            title={title}
            overflowMessage={overflowMessage}
          />
        </div>
      </div>
    </div>
  );
}

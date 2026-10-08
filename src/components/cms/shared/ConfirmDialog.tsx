'use client';

import { AlertTriangle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '@/hooks/cms/useDialogFocus';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'danger',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations('cms');

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  useDialogFocus(isOpen, panelRef, () => {
    if (!busy) onCancel();
  });

  if (!isOpen) return null;

  return createPortal(
    <div
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
    >
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!busy) onCancel();
        }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative bg-surface-base rounded-xl border border-border-subtle max-w-md w-full mx-4 p-6"
      >
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="absolute top-4 right-4 text-text-muted hover:text-text-main "
          aria-label={cancelLabel ?? t('common.cancel')}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-3 mb-4">
          {confirmVariant === 'danger' && (
            <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-500" />
            </div>
          )}
          <div>
            <h3 id={titleId} className="text-lg font-semibold text-text-main ">
              {title}
            </h3>
            <p id={messageId} className="text-sm text-text-muted mt-1">
              {message}
            </p>
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-4 py-2 min-h-[44px] bg-surface-raised hover:bg-surface-raised text-text-main rounded-lg font-medium transition-colors"
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
            className={`px-4 py-2 min-h-[44px] text-white rounded-lg font-medium transition-colors ${
              confirmVariant === 'danger'
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-accent-violet hover:bg-accent-violet-deep'
            }`}
          >
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

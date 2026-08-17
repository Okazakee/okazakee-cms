'use client';

import { AlertTriangle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations('cms');

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative bg-bglight dark:bg-darkergray rounded-xl border border-gray-200 dark:border-darkgray shadow-xl max-w-md w-full mx-4 p-6">
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 text-gray-500 dark:text-lighttext2 hover:text-darktext dark:hover:text-lighttext"
          aria-label="Close"
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
            <h3 className="text-lg font-semibold text-darktext dark:text-lighttext">
              {title}
            </h3>
            <p className="text-sm text-gray-500 dark:text-lighttext2 mt-1">
              {message}
            </p>
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 min-h-[44px] bg-gray-200 hover:bg-gray-300 dark:bg-darkgray dark:hover:bg-darkestgray text-darktext dark:text-lighttext rounded-lg font-medium transition-colors"
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 min-h-[44px] text-white rounded-lg font-medium transition-colors ${
              confirmVariant === 'danger'
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-main hover:bg-secondary'
            }`}
          >
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

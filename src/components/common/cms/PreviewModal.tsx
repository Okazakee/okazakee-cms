'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PreviewTranslations } from '@/components/common/cms/previews/PreviewTranslations';
import { useDialogFocus } from '@/hooks/cms/useDialogFocus';
import { useCmsStore } from '@/store/cmsStore';

interface PreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  copy?: {
    locale: 'en' | 'it';
    namespace: string;
    drafts: Record<'en' | 'it', Record<string, string>>;
  };
}

export function PreviewModal({
  isOpen,
  onClose,
  children,
  title,
  copy,
}: PreviewModalProps) {
  const t = useTranslations('cms');
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const activeSection = useCmsStore((state) => state.activeSection);
  const ownerSection = useRef(activeSection);
  useEffect(() => {
    if (!isOpen) ownerSection.current = activeSection;
    else if (ownerSection.current !== activeSection) onClose();
  }, [activeSection, isOpen, onClose]);
  useDialogFocus(isOpen, panelRef, onClose);
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-dvh w-full max-w-7xl overflow-y-auto overscroll-contain border border-border-subtle bg-surface-base sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)] sm:rounded-2xl"
      >
        <div className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border-subtle bg-surface-base/85 px-6 py-3 backdrop-blur-md">
          <h2 id={titleId} className="text-base font-bold text-text-white">
            {title || t('common.preview')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-raised hover:text-text-white"
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-10 sm:py-14">
          {copy ? (
            <PreviewTranslations {...copy}>{children}</PreviewTranslations>
          ) : (
            children
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

'use client';

import { X } from 'lucide-react';
import { useEffect } from 'react';

interface PreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}

export function PreviewModal({
  isOpen,
  onClose,
  children,
  title = 'Preview',
}: PreviewModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative w-full h-full max-w-7xl mx-auto bg-bglight dark:bg-bgdark overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-bglight dark:bg-bgdark border-b border-lighttext2/20 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-darktext dark:text-lighttext">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-gray-200 dark:hover:bg-darkgray rounded-md transition-colors"
            aria-label="Close preview"
          >
            <X className="w-5 h-5 text-darktext dark:text-lighttext" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

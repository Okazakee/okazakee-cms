'use client';

import { X } from 'lucide-react';
import { useEffect } from 'react';

interface ErrorBannerProps {
  message: string | null;
  onDismiss?: () => void;
  autoDismissMs?: number;
}

export function ErrorBanner({
  message,
  onDismiss,
  autoDismissMs,
}: ErrorBannerProps) {
  useEffect(() => {
    if (message && autoDismissMs && onDismiss) {
      const timer = setTimeout(onDismiss, autoDismissMs);
      return () => clearTimeout(timer);
    }
  }, [message, autoDismissMs, onDismiss]);

  if (!message) return null;

  return (
    <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-3">
      <p className="text-red-600 dark:text-red-400 text-sm flex-1">{message}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-red-400 hover:text-red-300 flex-shrink-0"
          aria-label="Dismiss error"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

'use client';

import { Check, Share } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * Canonical post share control (copy on desktop, native sheet on mobile). No
 * mutations, so it is safe inside a preview; the copied label is guarded so a
 * missing translation cannot throw.
 */
export function ShareButton({
  url,
  buttonTitle,
  title,
  className,
}: {
  url: string;
  buttonTitle: string;
  title: string;
  className?: string;
}) {
  const t = useTranslations('posts-section');
  const [copied, setCopied] = useState(false);
  const copiedLabel = t.has('preCopy') ? t('preCopy') : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  // Mobile opens the native share sheet; desktop keeps the copy affordance.
  const handleShare = async () => {
    if (window.matchMedia('(max-width: 767px)').matches && navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // The user dismissed the native sheet; nothing to do.
      }
      return;
    }
    await handleCopy();
  };

  return (
    <button
      className={`relative inline-flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-card px-3 py-2 transition-colors hover:border-accent-violet/50 hover:text-accent-violet-light ${className}`}
      data-umami-event="Share button"
      data-umami-event-post={title}
      onClick={handleShare}
      title={buttonTitle}
      type="button"
    >
      <span
        className={`absolute right-full mr-2 text-xs whitespace-nowrap transition-opacity duration-300 ${
          copied ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {copiedLabel}
      </span>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Share className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

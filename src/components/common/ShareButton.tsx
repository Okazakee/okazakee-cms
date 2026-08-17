'use client';

import { Check, Share2 } from 'lucide-react';
import { useState } from 'react';

export default function ShareButton({
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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`${className} relative text-darktext dark:text-lighttext flex items-center gap-2 px-2 py-1 rounded-md transition-all duration-400 ease-in-out w-5`}
      title={buttonTitle}
      data-umami-event="Share button"
      data-umami-event-post={title}
    >
      <div className="flex absolute right-0">
        <Check
          className={`w-5 h-5 mr-2 text-green-500 transition-all duration-400 ease-in-out ${
            copied ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <span
          className={`text-sm transition-all duration-400 ease-in-out ${
            copied ? 'opacity-100' : 'opacity-0'
          }`}
        >
          Copied!
        </span>
      </div>

      <Share2
        className={`absolute left-1/2 transform-gpu transition-all duration-400 ease-in-out -translate-x-1/2 w-5 h-5 ${copied ? 'opacity-0' : 'opacity-100'}`}
      />
    </button>
  );
}

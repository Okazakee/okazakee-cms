'use client';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { useState } from 'react';

export type PreChild = React.ReactElement & {
  props: {
    children: string;
  };
};

interface PreCustomProps {
  children: PreChild;
}

export default function PreCustom({ children }: PreCustomProps) {
  const t = useTranslations('posts-section');

  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children?.props.children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <>
      <div className="flex items-center h-10 dark:bg-[#969696] bg-[#696969] relative justify-between -mb-4! rounded-t-md text-lighttext dark:text-darktext">
        <h6 className="ml-3 text-lg">Code</h6>
        <div className="relative mr-2 flex items-center">
          <h6
            className={`text-base sm:text-base pointer-events-none mr-2.5 transition-opacity duration-300 ${copied ? 'opacity-100' : 'opacity-0'}`}
          >
            {t('preCopy')}
          </h6>
          <Copy
            className={`w-5 h-5 cursor-pointer absolute right-0 transition-opacity duration-300 ${copied ? 'opacity-0' : 'opacity-100'}`}
            onClick={handleCopy}
          />
          <Check
            className={`w-6 h-6 rounded-md cursor-pointer right-0 transition-opacity duration-300 ${copied ? 'opacity-100' : 'opacity-0'}`}
            onClick={handleCopy}
          />
        </div>
      </div>
      <pre className="bg-bgdark dark:bg-lighttext2 text-lighttext dark:text-darktext relative w-full rounded-t-none mt-4">
        {children}
      </pre>
    </>
  );
}

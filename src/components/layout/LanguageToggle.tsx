'use client';

import { Languages } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

export default function LanguageToggle({
  compact = false,
  sidebar = false,
}: {
  compact?: boolean;
  sidebar?: boolean;
}) {
  const pathname = usePathname();
  const _router = useRouter();
  const locale = useLocale();
  const [mounted, setMounted] = useState(false);
  const isItalian = locale === 'it';

  useEffect(() => {
    setMounted(true);
  }, []);

  const switchLanguage = useCallback(() => {
    const newLocale = isItalian ? 'en' : 'it';
    const pathSegments = pathname.split('/').filter(Boolean);
    const firstSegment = pathSegments[0];
    const hasVisibleLocale = firstSegment === 'en' || firstSegment === 'it';
    const normalizedPath = pathname === '/' ? '' : pathname;

    const newPath = hasVisibleLocale
      ? [''].concat([newLocale, ...pathSegments.slice(1)]).join('/')
      : `/${newLocale}${normalizedPath}`;

    // Use window.location.href for a full page refresh instead of client-side navigation
    window.location.href = newPath;
  }, [pathname, isItalian]);

  if (!mounted) return null;

  if (sidebar) {
    return (
      <button
        type="button"
        onClick={switchLanguage}
        className="w-full flex items-center gap-3 p-3 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-darkergray dark:hover:bg-darkgray text-darktext dark:text-lighttext hover:text-darktext dark:hover:text-white transition-all duration-200"
        data-umami-event="Language toggle"
      >
        <Languages className="w-4 h-4 flex-shrink-0" />
        <span className="font-medium text-sm truncate">
          {isItalian ? 'Italiano' : 'English'}
        </span>
      </button>
    );
  }

  // Use compact styling when in desktop header
  const buttonClass = compact
    ? 'flex items-center justify-center border-2 border-main rounded-2xl transition-all duration-300 ease-in-out w-fit px-3 h-10'
    : 'space-x-2 relative flex justify-center items-center border-2 border-white dark:border-white rounded-2xl transition-all duration-300 ease-in-out h-16 w-48 lg:h-10 lg:w-32 lg:border-main';

  return (
    <button
      type="button"
      onClick={switchLanguage}
      className={buttonClass}
      data-umami-event="Language toggle"
    >
      {compact ? (
        <span className="text-sm font-medium text-darktext dark:text-lighttext transition-all duration-300 ease-in-out">
          {isItalian ? 'IT' : 'EN'}
        </span>
      ) : (
        <div className="text-xl lg:text-lg text-darktext dark:text-lighttext transition-all duration-300 ease-in-out flex items-center justify-center w-full">
          {isItalian ? 'Italiano' : 'English'}
        </div>
      )}
    </button>
  );
}

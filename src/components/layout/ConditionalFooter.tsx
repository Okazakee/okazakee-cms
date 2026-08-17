'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

interface ConditionalFooterProps {
  children: ReactNode;
}

export default function ConditionalFooter({
  children,
}: ConditionalFooterProps) {
  const pathname = usePathname();
  const isCMSRoute =
    pathname?.includes('/cms') &&
    !pathname?.includes('/cms/login') &&
    !pathname?.includes('/cms/register');

  return (
    <div
      className={
        isCMSRoute
          ? 'fixed bottom-0 left-0 right-0 z-20 bg-bglight dark:bg-bgdark hidden lg:block'
          : ''
      }
    >
      {children}
    </div>
  );
}

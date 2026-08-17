'use client';

import { usePathname } from 'next/navigation';
import Header from './Header';

export default function ConditionalHeader({ locale }: { locale: string }) {
  const pathname = usePathname();
  const isCMSRoute =
    pathname?.includes('/cms') &&
    !pathname?.includes('/cms/login') &&
    !pathname?.includes('/cms/register');

  if (isCMSRoute) {
    return null;
  }

  return <Header locale={locale} />;
}

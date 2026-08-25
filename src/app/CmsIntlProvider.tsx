'use client';

import { NextIntlClientProvider } from 'next-intl';
import { type ReactNode, useEffect } from 'react';
import useUiLocaleStore from '@/store/uiLocaleStore';

export type CmsLocaleMessages = {
  en: Record<string, unknown>;
  it: Record<string, unknown>;
};

// Client-side UI language switching without URL locales: the SidePanel
// selector mutates uiLocaleStore, this provider re-renders every
// useTranslations() consumer with the matching message set. Both locales'
// messages are delivered from the server layout (public-site translations
// are per-locale data in Supabase, CMS labels are static JSON).
export function CmsIntlProvider({
  messages,
  children,
}: {
  messages: CmsLocaleMessages;
  children: ReactNode;
}) {
  const locale = useUiLocaleStore((s) => s.locale);
  const initializeLocale = useUiLocaleStore((s) => s.initializeLocale);

  useEffect(() => {
    initializeLocale();
  }, [initializeLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <NextIntlClientProvider
      locale={locale}
      timeZone="Europe/Rome"
      messages={messages[locale] as Record<string, never>}
    >
      {children}
    </NextIntlClientProvider>
  );
}

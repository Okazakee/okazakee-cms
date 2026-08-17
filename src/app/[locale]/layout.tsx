import '../globals.css';
import { SpeedInsights } from '@vercel/speed-insights/next';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import Script from 'next/script';
import { NextIntlClientProvider } from 'next-intl';
import { Suspense } from 'react';
import ConditionalFooter from '@/components/layout/ConditionalFooter';
import ConditionalHeader from '@/components/layout/ConditionalHeader';
import Footer from '@/components/layout/Footer';
import ScrollTop from '@/components/layout/ScrollTop';
import cmsEn from '@/i18n/messages/cms.en.json';
import cmsIt from '@/i18n/messages/cms.it.json';
import { isValidLocale, locales } from '@/i18n/routing';
import { getTranslationsSupabase } from '@/utils/getData';
import { Providers } from '../providers';

const umamiEnabled = process.env.UMAMI_ENABLED === 'true';

const whiteRabbit = localFont({
  src: '../public/fonts/whiterabbit.woff2',
  variable: '--font-whiterabt',
  weight: '400',
});

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

async function LocaleShell({
  params,
  children,
}: {
  params: Promise<{ locale: string }>;
  children: React.ReactNode;
}) {
  const { locale } = await params;
  const supabaseMessages = await getTranslationsSupabase(locale);
  const cmsMessages = locale === 'it' ? cmsIt : cmsEn;
  const messages = { ...supabaseMessages, cms: cmsMessages };

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      <ConditionalHeader locale={locale} />
      {children}
      <ScrollTop />
      <ConditionalFooter>
        <Footer locale={locale} />
      </ConditionalFooter>
    </NextIntlClientProvider>
  );
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isValidLocale(locale)) {
    notFound();
  }

  return (
    <html lang={locale} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="darkreader-lock" />
        <meta name="color-scheme" content="dark light" />
        <link
          rel="preconnect"
          href="https://mtvwynyikouqzmhqespl.supabase.co"
        />
        <link
          rel="dns-prefetch"
          href="https://mtvwynyikouqzmhqespl.supabase.co"
        />
        <link rel="preconnect" href="https://umami.okazakee.dev" />
        {/* Blocking theme script — runs before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('themeMode');var isDark=m==='dark'||(m!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(isDark)document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body
        id="about"
        className={`${whiteRabbit.variable} transition-colors duration-400 ease-in-out font-whiterabt antialiased scroll-smooth relative`}
      >
        <Providers>
          <Suspense>
            <LocaleShell params={params}>{children}</LocaleShell>
          </Suspense>
          <SpeedInsights />
          {umamiEnabled && (
            <Script
              src="https://umami.okazakee.dev/script.js"
              data-website-id="3eba2ffb-eb82-49ab-a7b5-272a0d9a988c"
              strategy="lazyOnload"
            />
          )}
        </Providers>
      </body>
    </html>
  );
}

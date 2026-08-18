import '../globals.css';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { Suspense } from 'react';
import cmsEn from '@/i18n/messages/cms.en.json';
import cmsIt from '@/i18n/messages/cms.it.json';
import { publicConfig } from '@/config/public';
import { isValidLocale, locales } from '@/i18n/routing';
import { getTranslationsSupabase } from '@/utils/getData';
import { Providers } from '../providers';

const whiteRabbit = localFont({
  src: '../public/fonts/whiterabbit.woff2',
  variable: '--font-whiterabt',
  weight: '400',
});

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

async function CmsShell({
  params,
  children,
}: {
  params: Promise<{ locale: string }>;
  children: React.ReactNode;
}) {
  const { locale } = await params;

  // Public translations are still merged here: CMS previews render public
  // section content (hero, skills, posts, header/footer, ...) which is data
  // in Supabase, not static CMS UI labels.
  const publicMessages = await getTranslationsSupabase(locale);
  const cmsMessages = locale === 'it' ? cmsIt : cmsEn;
  const messages = { ...publicMessages, cms: cmsMessages };

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      {children}
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

  const supabasePreconnect = publicConfig.supabaseHostname;

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
        {supabasePreconnect && (
          <>
            <link rel="preconnect" href={`https://${supabasePreconnect}`} />
            <link rel="dns-prefetch" href={`https://${supabasePreconnect}`} />
          </>
        )}
        {/* Blocking theme script — runs before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('themeMode');var isDark=m==='dark'||(m!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',isDark);}catch(e){}})();`,
          }}
        />
      </head>
      <body
        id="about"
        className={`${whiteRabbit.variable} transition-colors duration-400 ease-in-out font-whiterabt antialiased scroll-smooth relative`}
      >
        <Providers>
          <Suspense>
            <CmsShell params={params}>{children}</CmsShell>
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}

import './globals.css';
import localFont from 'next/font/local';
import { NextIntlClientProvider } from 'next-intl';
import { Suspense } from 'react';
import cmsEn from '@/i18n/messages/cms.en.json';
import { publicConfig } from '@/config/public';
import { defaultLocale } from '@/i18n/routing';
import { getTranslationsSupabase } from '@/utils/getData';
import { Providers } from './providers';

const whiteRabbit = localFont({
  src: './public/fonts/whiterabbit.woff2',
  variable: '--font-whiterabt',
  weight: '400',
});

async function CmsShell({ children }: { children: React.ReactNode }) {
  // Public translations are still merged here: CMS previews render public
  // section content (hero, skills, posts, header/footer, ...) which is data
  // in Supabase, not static CMS UI labels. The CMS UI itself is English-only;
  // there is no URL locale anymore.
  const publicMessages = await getTranslationsSupabase(defaultLocale);
  const messages = { ...publicMessages, cms: cmsEn };

  return (
    <NextIntlClientProvider messages={messages} locale={defaultLocale}>
      {children}
    </NextIntlClientProvider>
  );
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabasePreconnect = publicConfig.supabaseHostname;

  return (
    <html
      lang={defaultLocale}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
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
            <CmsShell>{children}</CmsShell>
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}

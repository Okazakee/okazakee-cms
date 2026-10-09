import './globals.css';
import localFont from 'next/font/local';
import { Suspense } from 'react';
import { publicConfig } from '@/config/public';
import cmsEn from '@/i18n/messages/cms.en.json';
import cmsIt from '@/i18n/messages/cms.it.json';
import { CmsIntlProvider } from './CmsIntlProvider';
import { Providers } from './providers';

const whiteRabbit = localFont({
  src: './public/fonts/whiterabbit.woff2',
  variable: '--font-whiterabt',
  weight: '400',
});

function CmsShell({ children }: { children: React.ReactNode }) {
  // The editor renders from its own bundles only: it no longer mirrors public
  // section content, so no public copy is read from the database here. Both
  // locales are delivered so the SidePanel selector can switch the UI language
  // client-side, without URL locales.
  return (
    <CmsIntlProvider messages={{ en: { cms: cmsEn }, it: { cms: cmsIt } }}>
      {children}
    </CmsIntlProvider>
  );
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabasePreconnect = publicConfig.supabaseHostname;

  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
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
        className={`${whiteRabbit.variable} transition-colors duration-300 ease-in-out font-body antialiased scroll-smooth relative`}
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

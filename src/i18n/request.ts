import { getRequestConfig } from 'next-intl/server';
import { defaultLocale } from '@/i18n/routing';
import { getTranslationsSupabase } from '@/utils/getData';
import cmsEn from './messages/cms.en.json';

// The CMS has no URL locale: routes live at the root and the UI language is
// pinned to the default locale. Public-site content translations remain
// per-locale data in Supabase (edited via the i18n section), merged here so
// previews can render public content.
export default getRequestConfig(async () => {
  const messages = await getTranslationsSupabase(defaultLocale);

  return {
    locale: defaultLocale,
    timeZone: 'Europe/Rome',
    messages: { ...messages, cms: cmsEn },
  };
});

import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isValidLocale } from '@/i18n/routing';
import { getTranslationsSupabase } from '@/utils/getData';
import cmsEn from './messages/cms.en.json';
import cmsIt from './messages/cms.it.json';

export default getRequestConfig(async ({ requestLocale }) => {
  const requestedLocale = await requestLocale;
  const locale =
    requestedLocale && isValidLocale(requestedLocale)
      ? requestedLocale
      : defaultLocale;
  const messages = await getTranslationsSupabase(locale);
  const cmsMessages = locale === 'it' ? cmsIt : cmsEn;

  return {
    locale,
    messages: { ...messages, cms: cmsMessages },
  };
});

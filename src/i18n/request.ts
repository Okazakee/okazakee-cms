import { getRequestConfig } from 'next-intl/server';
import { defaultLocale } from '@/i18n/routing';
import cmsEn from './messages/cms.en.json';

// The CMS has no URL locale: routes live at the root and the UI language is
// pinned to the default locale. The editor renders its own labels only — the
// public site's copy stays in Supabase, edited through the i18n section and
// read by the website, never here.
export default getRequestConfig(async () => ({
  locale: defaultLocale,
  timeZone: 'Europe/Rome',
  messages: { cms: cmsEn },
}));
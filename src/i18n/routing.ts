export const locales = ['en', 'it'] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = 'en';

export const routing = {
  locales,
  defaultLocale,
} as const;

export function isValidLocale(locale: string): locale is AppLocale {
  return locales.includes(locale as AppLocale);
}

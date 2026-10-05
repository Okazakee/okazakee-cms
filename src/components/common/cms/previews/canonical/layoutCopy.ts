import siteEn from '@/i18n/messages/site.en.json';
import siteIt from '@/i18n/messages/site.it.json';

/**
 * Header and footer chrome copy for the Layout preview.
 *
 * These strings are frozen site-side: `okazakee-ws` reads them straight from
 * its own `src/i18n/messages/site.{en,it}.json` through `withSiteCopy`, so the
 * CMS cannot edit them and a preview must not ask the database for them. The two
 * files here are the same copy, carried into the CMS so a preview renders the
 * real labels in either locale with no `header`/`footer` translation namespace
 * loaded. Keep them in step with those WS files.
 *
 * `header.buttons` is index-aligned with `navItemIds`, so a nav item's label is
 * the array entry at its index; the seventh entry is the résumé button label,
 * which the site renders separately from the six navigation destinations.
 */

const copy = { en: siteEn, it: siteIt } as const;

export type LayoutCopy = typeof siteEn;

/** Same supported-locale fallback as the site's frozen copy. */
export function getLayoutCopy(locale: string): LayoutCopy {
  return copy[locale === 'it' ? 'it' : 'en'];
}

/**
 * Footer identity the site renders when `site_settings` has never been written:
 * the GitHub handle and the Italian VAT number are literals in `okazakee-ws`'s
 * `Footer`, not editable copy, so an unset column keeps them.
 */
export const defaultFooterName = 'Okazakee';
export const defaultFooterVatNumber = '02863310815';

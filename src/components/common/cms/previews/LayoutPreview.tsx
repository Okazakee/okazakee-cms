'use client';

import { FileUser, Globe, Menu, Moon, X } from 'lucide-react';
import { useLocale } from 'next-intl';
import { useState } from 'react';
import logo from '@/app/public/title-cms.png';
import logoLight from '@/app/public/title-cms-lightmode.png';
import { type NavAnchorDraft, navItemIds } from '@/utils/cms/navAnchors';
import {
  defaultFooterName,
  defaultFooterVatNumber,
  getLayoutCopy,
} from './canonical/layoutCopy';

/**
 * Preview of the public header and footer, driven by Layout drafts.
 *
 * The chrome copy is frozen site-side and read locally (see
 * `canonical/layoutCopy.ts`); only the values the CMS owns — the per-theme
 * logos, the nav anchors, the footer identity and the résumé links — come in as
 * props. Every prop is optional, so a partial draft previews like an unset
 * setting: bundled logos, default anchors, the site's own footer identity and
 * no résumé button.
 */
export function LayoutPreview({
  logos,
  anchors,
  footer,
  resumeLinks,
}: {
  /** Draft logo URLs; null per theme falls back to the bundled CMS asset. */
  logos?: { dark: string | null; light: string | null };
  /** Draft nav anchors, index-aligned with the labels. */
  anchors?: NavAnchorDraft[];
  /** Draft footer identity; null per field keeps the site's own values. */
  footer?: { name: string | null; vatNumber: string | null };
  /** Draft résumé PDF URLs; a null for this locale hides the button, as on the site. */
  resumeLinks?: { en: string | null; it: string | null };
}) {
  const locale = useLocale();
  const copy = getLayoutCopy(locale);
  const logoSrc = {
    dark: logos?.dark ?? logo.src,
    light: logos?.light ?? logoLight.src,
  };
  // Index-addressed like the frozen labels, applied by id so a reordered row
  // still lands on the right label.
  const anchorById = Object.fromEntries(
    (anchors ?? []).map((item) => [item.id, item.anchor])
  );
  const navItems = navItemIds.map((id, index) => ({
    id,
    label: copy.header.buttons[index],
    href: `#${anchorById[id] ?? id}`,
  }));
  const resumeHref =
    resumeLinks?.[locale === 'it' ? 'it' : 'en']?.trim() || null;
  const footerName = footer?.name?.trim() || defaultFooterName;
  const footerVat = footer?.vatNumber?.trim() || defaultFooterVatNumber;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="mx-auto max-w-5xl">
      <header className="border-b border-border-subtle bg-surface-base/85 backdrop-blur-md">
        <div className="mx-auto grid h-16 max-w-5xl grid-cols-[1fr_auto_1fr] items-center pl-6 pr-3 lg:pr-6">
          <div className="col-start-1 flex items-center justify-self-start">
            {/* biome-ignore lint/performance/noImgElement: static canonical logo */}
            <img
              alt="logo"
              className="hidden h-6 w-auto max-w-none shrink-0 object-contain dark:block"
              height={293}
              src={logoSrc.dark}
              width={1937}
            />
            {/* biome-ignore lint/performance/noImgElement: static canonical logo */}
            <img
              alt="logo"
              className="block h-6 w-auto max-w-none shrink-0 object-contain dark:hidden"
              height={294}
              src={logoSrc.light}
              width={1942}
            />
          </div>
          <nav
            aria-label="Website preview navigation"
            className="col-start-2 hidden items-center gap-5 font-mono text-[11px] uppercase tracking-wider text-text-muted lg:flex"
          >
            {navItems.map((item) => (
              <a href={item.href} key={item.id}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="col-start-3 flex items-center justify-self-end gap-1 text-text-muted">
            {resumeHref && (
              <a
                className="hidden items-center gap-1.5 rounded-lg border border-accent-violet/40 bg-accent-violet/10 px-3 py-1.5 font-mono text-[11px] text-accent-violet-light lg:flex"
                href={resumeHref}
                rel="noopener noreferrer"
                target="_blank"
              >
                <FileUser className="h-[15px] w-[15px]" />
                {copy.header.resume}
              </a>
            )}
            <span className="flex h-11 w-11 items-center justify-center">
              <Moon className="h-4 w-4" />
            </span>
            <span className="flex h-11 w-11 items-center justify-center">
              <Globe className="h-4 w-4" />
            </span>
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center lg:hidden"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? (
                <X className="h-4 w-4" />
              ) : (
                <Menu className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            aria-label="Mobile website preview navigation"
            className="flex flex-col gap-4 border-t border-border-subtle p-6 font-mono text-xs uppercase text-text-muted lg:hidden"
          >
            {navItems.map((item) => (
              <a href={item.href} key={item.id}>
                {item.label}
              </a>
            ))}
            {resumeHref && (
              <a
                className="flex items-center gap-1.5 font-mono text-accent-violet-light"
                href={resumeHref}
                rel="noopener noreferrer"
                target="_blank"
              >
                <FileUser className="h-4 w-4" />
                {copy.header.resume}
              </a>
            )}
          </nav>
        )}
      </header>
      <div className="min-h-32" />
      <footer className="border-t border-border-subtle bg-surface-base py-8 font-mono text-xs text-text-dim">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
          <div>
            {copy.footer.left}{' '}
            <span className="text-text-muted">{footerName}</span>{' '}
            <span className="text-border-hover">|</span> {copy.footer.source}
          </div>
          <div className="flex items-center gap-4">
            <span title={copy.footer.buttonTitle}>
              {copy.footer.middle} - {footerVat}
            </span>
            <span>•</span>
            <span className="underline">CMS</span>
            <span>•</span>
            <span className="underline">{copy.footer.privacyPolicy}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

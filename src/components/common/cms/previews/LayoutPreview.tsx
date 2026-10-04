'use client';

import { Globe, Menu, Moon, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import logo from '@/app/public/title-cms.png';
import logoLight from '@/app/public/title-cms-lightmode.png';
import { type NavAnchorDraft, navItemIds } from '@/utils/cms/navAnchors';

// The website deliberately hardcodes these labels rather than reading IT copy.
export const italianNavLabels = [
  'Home',
  'Skills',
  'Carriera',
  'Portfolio',
  'Blog',
  'Contatti',
] as const;

export function LayoutPreview({
  part = 'both',
  logos,
  anchors,
}: {
  /** Header and Footer are separate CMS sections; the preview follows. */
  part?: 'header' | 'footer' | 'both';
  /** Draft logo URLs; null per theme falls back to the bundled CMS asset. */
  logos?: { dark: string | null; light: string | null };
  /** Draft nav anchors, index-aligned with the labels. */
  anchors?: NavAnchorDraft[];
}) {
  const logoSrc = {
    dark: logos?.dark ?? logo.src,
    light: logos?.light ?? logoLight.src,
  };
  const anchorHrefs = navItemIds.map(
    (id, index) => `#${anchors?.[index]?.anchor ?? id}`
  );
  const locale = useLocale();
  const header = useTranslations('header');
  const footer = useTranslations('footer');
  const [menuOpen, setMenuOpen] = useState(false);
  const labels = italianNavLabels.map((label, index) =>
    locale === 'it' ? label : header(`buttons.${index}`)
  );
  return (
    <div className="mx-auto max-w-5xl">
      {part !== 'footer' && (
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
              {labels.map((label, index) => (
                <a href={anchorHrefs[index]} key={italianNavLabels[index]}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="col-start-3 flex items-center justify-self-end gap-1 text-text-muted">
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
              {labels.map((label, index) => (
                <a href={anchorHrefs[index]} key={italianNavLabels[index]}>
                  {label}
                </a>
              ))}
            </nav>
          )}
        </header>
      )}
      {part === 'both' && <div className="min-h-32" />}
      {part !== 'header' && (
        <footer className="border-t border-border-subtle bg-surface-base py-8 font-mono text-xs text-text-dim">
          <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
            <div>
              {footer('left')} <span className="text-text-muted">Okazakee</span>{' '}
              <span className="text-border-hover">|</span> {footer('source')}
            </div>
            <div className="flex items-center gap-4">
              <span title={footer('buttonTitle')}>
                {footer('middle')} - 02863310815
              </span>
              <span>•</span>
              <span className="underline">CMS</span>
              <span>•</span>
              <span className="underline">{footer('privacyPolicy')}</span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

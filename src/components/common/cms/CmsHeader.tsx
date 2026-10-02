import logo from '@public/title-cms.png';
import logoLight from '@public/title-cms-lightmode.png';
import { Menu, X } from 'lucide-react';
import ThemeToggle from '@/components/layout/ThemeToggle';

export function CmsHeader({
  onMenuClick,
  menuOpen,
}: {
  onMenuClick: () => void;
  menuOpen: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-border-subtle bg-surface-base/85 backdrop-blur-md lg:hidden">
      <div className="mx-auto grid h-16 max-w-7xl grid-cols-[1fr_auto_1fr] items-center pl-6 pr-3 lg:pr-6">
        <div className="col-start-1 flex min-w-0 items-center justify-self-start">
          {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
          <img
            src={logo.src}
            alt="Okazakee"
            width={1937}
            height={293}
            className="hidden h-6 w-auto max-w-none shrink-0 object-contain dark:block"
          />
          {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
          <img
            src={logoLight.src}
            alt="Okazakee"
            width={1942}
            height={294}
            className="block h-6 w-auto max-w-none shrink-0 object-contain dark:hidden"
          />
        </div>
        <div className="col-start-3 flex items-center gap-2 justify-self-end lg:hidden">
          <ThemeToggle header />
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            aria-controls="cms-navigation"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-subtle bg-surface-card text-text-dim transition-colors hover:border-accent-violet/40 hover:text-accent-violet-light"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </header>
  );
}

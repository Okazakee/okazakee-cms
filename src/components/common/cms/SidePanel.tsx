import logo from '@public/title-cms.png';
import logoLight from '@public/title-cms-lightmode.png';
import {
  Briefcase,
  Contact,
  FileText,
  Home,
  Inbox,
  Languages,
  PanelBottom,
  PanelTop,
  LogOut,
  MessageSquare,
  NotebookPen,
  Settings,
  User2,
  Users,
  Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Fragment, useEffect, useRef, useState } from 'react';
import LanguageToggle from '@/components/layout/LanguageToggle';
import ThemeToggle from '@/components/layout/ThemeToggle';
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_DESTRUCTIVE,
  SIDEBAR_ROW_ICON,
  SIDEBAR_ROW_LABEL,
  SIDEBAR_ROW_NEUTRAL,
} from '@/components/layout/sidebarRowStyle';
import { useDialogFocus } from '@/hooks/cms/useDialogFocus';
import { useCmsStore } from '@/store/cmsStore';
import { createClient } from '@/utils/supabase/client';

// Public website URL for cross-app links (CMS Home button).
const publicSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://okazakee.dev';

// Non-interactive signed-in identity banner. The desktop sidebar owns the
// brand: the CMS wordmark sits centered above the avatar/name/role card (the
// desktop header is gone). Rendered above the section list on desktop and at
// the top of the fullscreen mobile menu (logo omitted there — the mobile
// header already shows it).
function UserBanner({ compact = false }: { compact?: boolean }) {
  const user = useCmsStore((s) => s.user);
  const t = useTranslations('cms');
  const roleLabel =
    user?.role === 'admin'
      ? t('users.roleAdmin')
      : user?.role === 'editor'
        ? t('users.roleEditor')
        : null;
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface-card ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      {user?.avatarUrl ? (
        // biome-ignore lint/performance/noImgElement: user-uploaded avatar URL, not a static import
        <img
          src={user.avatarUrl}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent-violet/30 bg-accent-violet/10 font-heading text-lg text-accent-violet">
          {(user?.displayName || 'U').charAt(0).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-text-main">
          {user?.displayName}
        </span>
        {roleLabel && (
          <span className="mt-0.5 block font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
            {roleLabel}
          </span>
        )}
      </span>
    </div>
  );
}
interface SidePanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly: boolean;
  /** Marks a section that exists but does not reach the website yet. */
  planned?: boolean;
}

// The sidebar mirrors the public page top to bottom, then the inbox, then
// everything that is not page content.
const PAGE_ITEMS: MenuItem[] = [
  { id: 'header', label: '', icon: PanelTop, adminOnly: true },
  { id: 'hero', label: '', icon: Home, adminOnly: true },
  { id: 'skills', label: '', icon: Zap, adminOnly: true },
  { id: 'career', label: '', icon: User2, adminOnly: true },
  { id: 'portfolio', label: '', icon: Briefcase, adminOnly: false },
  { id: 'blog', label: '', icon: NotebookPen, adminOnly: false },
  { id: 'contacts', label: '', icon: Contact, adminOnly: true },
  { id: 'footer', label: '', icon: PanelBottom, adminOnly: true },
];

const INBOX_ITEMS: MenuItem[] = [
  { id: 'requests', label: '', icon: Inbox, adminOnly: true },
];

const SYSTEM_ITEMS: MenuItem[] = [
  {
    id: 'request-form',
    label: '',
    icon: MessageSquare,
    adminOnly: true,
    planned: true,
  },
  { id: 'site-copy', label: '', icon: Languages, adminOnly: true },
  { id: 'privacy-policy', label: '', icon: FileText, adminOnly: true },
  { id: 'users', label: '', icon: Users, adminOnly: true },
];

const MENU_GROUPS: Array<{ caption: string; items: MenuItem[] }> = [
  { caption: 'page', items: PAGE_ITEMS },
  { caption: 'inbox', items: INBOX_ITEMS },
  { caption: 'system', items: SYSTEM_ITEMS },
];

const SidePanel = ({ isOpen = true, onClose }: SidePanelProps) => {
  const t = useTranslations('cms');
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useDialogFocus(isMobile && isOpen, panelRef, () => onClose?.());

  const {
    activeSection,
    setActiveSection,
    user,
    setUser,
    setHeroSection,
    publishQueue,
    isPublishingAll,
    publishAll,
    sectionCallbacks,
    error,
  } = useCmsStore();

  const isAdmin = user?.role === 'admin';

  const sectionLabelMap: Record<string, string> = {
    hero: t('sidebar.nav.hero'),
    skills: t('sidebar.nav.skills'),
    career: t('sidebar.nav.career'),
    portfolio: t('sidebar.nav.portfolio'),
    blog: t('sidebar.nav.blog'),
    contacts: t('sidebar.nav.contacts'),
    'request-form': t('sidebar.nav.request-form'),
    requests: t('sidebar.nav.requests'),
    'site-copy': t('sidebar.nav.site-copy'),
    header: t('sidebar.nav.header'),
    footer: t('sidebar.nav.footer'),
    'privacy-policy': t('sidebar.nav.privacy-policy'),
    users: t('sidebar.nav.users'),
    account: t('sidebar.myAccount'),
  };

  const handleSelectSection = (section: string) => {
    setActiveSection(section);
    if (typeof window !== 'undefined') {
      localStorage.setItem('cms_active_section', section);
    }
    onClose?.();
  };

  const handleLogout = async () => {
    if (pendingCount > 0 && !window.confirm(t('sidebar.discardDrafts'))) return;
    setIsLoggingOut(true);
    setUser(null);
    setHeroSection(null);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  const pendingCount = Object.values(publishQueue).reduce(
    (sum, state) => sum + (state.isDirty ? state.changeCount : 0),
    0
  );

  const hasDraft = (sectionId: string) =>
    Object.entries(publishQueue).some(
      ([key, state]) =>
        state.isDirty && (key === sectionId || key.startsWith(`${sectionId}:`))
    );

  const getFilteredItems = (items: MenuItem[]) =>
    items.filter((item) => !item.adminOnly || isAdmin);

  useEffect(() => {
    if (!user || isAdmin) return;
    if (typeof window !== 'undefined' && activeSection) {
      const savedSection = localStorage.getItem('cms_active_section');
      // Derived from the menu so a section can never be admin-only in the nav
      // but missing here (which would strand an editor on it).
      const adminOnlySections = MENU_GROUPS.flatMap((group) =>
        group.items.filter((item) => item.adminOnly).map((item) => item.id)
      );
      if (
        adminOnlySections.includes(activeSection) &&
        (!savedSection || adminOnlySections.includes(savedSection))
      ) {
        handleSelectSection('blog');
      }
    }
  });

  const renderNavItem = (item: MenuItem) => (
    <button
      type="button"
      key={item.id}
      onClick={() => handleSelectSection(item.id)}
      aria-current={activeSection === item.id ? 'page' : undefined}
      className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all duration-200 text-left ${
        activeSection === item.id
          ? 'border border-accent-violet/30 bg-accent-violet/10 text-accent-violet '
          : 'border border-transparent hover:bg-surface-raised text-text-muted hover:text-text-white '
      }`}
    >
      <div className="relative">
        <item.icon className="w-5 h-5" />
        {hasDraft(item.id) && (
          <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full" />
        )}
      </div>
      <span className="font-medium flex-1">
        {sectionLabelMap[item.id] || item.label}
      </span>
      {item.planned && (
        <span className="shrink-0 rounded border border-border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-dim">
          {t('common.planned')}
        </span>
      )}
      {hasDraft(item.id) && (
        <span className="w-2 h-2 bg-amber-400 rounded-full flex-shrink-0" />
      )}
    </button>
  );

  // Mobile menu mirrors the public website canon (docs/DESIGN.md §4):
  // heading-size rows with mono index prefixes and hairline dividers over one
  // continuous 01..N sequence. Group captions preserve the CMS content /
  // configuration split; the account row closes the list and theme/language,
  // Home and logout live in the pinned footer block. Hidden rows stay
  // unfocusable via tabIndex -1 (the aside itself is inert when closed).
  const mobileNav: Array<{
    id: string;
    caption: string | null;
    planned?: boolean;
  }> = [];
  for (const group of MENU_GROUPS) {
    getFilteredItems(group.items).forEach((item, index) => {
      mobileNav.push({
        id: item.id,
        caption: index === 0 ? t(`sidebar.navGroup.${group.caption}`) : null,
        planned: item.planned,
      });
    });
  }
  mobileNav.push({ id: 'account', caption: null });

  const discardAllDirty = () => {
    if (!window.confirm(t('sidebar.discardDrafts'))) return;
    for (const [key, callbacks] of Object.entries(sectionCallbacks)) {
      if (publishQueue[key]?.isDirty) callbacks.revert();
    }
  };

  return (
    <aside
      ref={panelRef}
      id="cms-navigation"
      role={isMobile ? 'dialog' : 'complementary'}
      {...(isMobile
        ? {
            'aria-modal': isOpen || undefined,
            'aria-hidden': !isOpen || undefined,
          }
        : {})}
      aria-label={t('sidebar.workspace')}
      inert={isMobile && !isOpen ? true : undefined}
      tabIndex={-1}
      className={`text-text-main flex flex-col bg-surface-base transition-all duration-300 ${
        onClose
          ? `fixed inset-x-0 top-16 bottom-0 z-40 overflow-y-auto bg-surface-base/[0.98] backdrop-blur-xl transition-[opacity,translate,visibility] duration-200 ease-out lg:static lg:bottom-auto lg:z-auto lg:h-full lg:w-72 lg:max-w-none lg:overflow-visible lg:border-r lg:border-border-subtle lg:bg-surface-base lg:backdrop-blur-none lg:transition-all lg:duration-300 ${
              isOpen
                ? 'visible translate-y-0 opacity-100 lg:translate-x-0'
                : 'invisible -translate-y-2 opacity-0 lg:visible lg:translate-x-0 lg:translate-y-0 lg:opacity-100'
            }`
          : 'relative h-full w-72 border-r border-border-subtle'
      }`}
    >
      {/* Mobile fullscreen menu: the open/close toggle lives in the CMS
        header (like the website header), so no inner header row here. */}
      <div className="flex min-h-full flex-col px-6 pt-6 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="pt-6">
          <UserBanner compact />
        </div>

        {pendingCount > 0 && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-800/50 dark:bg-amber-900/10">
            <div className="mb-1 flex items-center gap-2">
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-400" />
              <span className="flex-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                {t('sidebar.pendingSections', {
                  count: Object.values(publishQueue).filter((s) => s.isDirty)
                    .length,
                })}
              </span>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={isPublishingAll}
                tabIndex={isOpen ? 0 : -1}
                onClick={discardAllDirty}
                className="min-h-11 flex-1 rounded-lg border border-border-subtle bg-surface-raised px-2 py-1 text-xs text-text-main transition-colors hover:border-border-hover disabled:opacity-50"
              >
                {t('common.revert')}
              </button>
              <button
                type="button"
                disabled={isPublishingAll}
                tabIndex={isOpen ? 0 : -1}
                onClick={() => void publishAll()}
                className="min-h-11 flex-1 rounded-lg bg-accent-violet-deep px-2 py-1 text-xs text-white transition-colors hover:bg-accent-violet disabled:opacity-50"
              >
                {isPublishingAll
                  ? t('common.publishing')
                  : t('sidebar.publishAll')}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="my-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <nav className="flex flex-col" aria-label={t('sidebar.workspace')}>
          {mobileNav.map((row, index) => {
            const active = activeSection === row.id;
            return (
              <Fragment key={row.id}>
                {row.caption && (
                  <p className="pt-4 pb-1 font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
                    {row.caption}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => handleSelectSection(row.id)}
                  aria-current={active ? 'page' : undefined}
                  tabIndex={isOpen ? 0 : -1}
                  style={{
                    transitionDelay: isOpen ? `${index * 40}ms` : '0ms',
                  }}
                  className={`flex w-full items-baseline gap-3.5 border-b border-border-subtle/50 px-1 py-3.5 text-left transition-[opacity,translate] duration-200 ease-out ${
                    isOpen
                      ? 'translate-y-0 opacity-100'
                      : 'translate-y-2 opacity-0'
                  } ${
                    active
                      ? 'font-semibold text-accent-violet-light'
                      : 'text-text-white'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="min-w-6 font-mono text-[11px] tracking-[0.2em] text-text-dim"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="font-heading flex-1 text-3xl tracking-tight">
                    {sectionLabelMap[row.id]}
                  </span>
                  {row.planned && (
                    <span className="shrink-0 self-center rounded border border-border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-dim">
                      {t('common.planned')}
                    </span>
                  )}
                  {hasDraft(row.id) && (
                    <span
                      role="img"
                      aria-label="Unsaved changes"
                      className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-400"
                    />
                  )}
                </button>
              </Fragment>
            );
          })}
        </nav>

        {/* Spacer lets a short menu push the footer to the viewport bottom
          while keeping it reachable with breathing room on long menus. */}
        <div aria-hidden="true" className="min-h-6 flex-1 lg:hidden" />
        <div
          className={`flex flex-col gap-3 pt-6 pb-6 transition-[opacity,translate] duration-200 ease-out ${
            isOpen ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          }`}
          style={{
            transitionDelay: isOpen ? `${mobileNav.length * 40}ms` : '0ms',
          }}
        >
          <LanguageToggle sidebar />
          <a
            href={publicSiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={isOpen ? 0 : -1}
            className={`${SIDEBAR_ROW} ${SIDEBAR_ROW_NEUTRAL}`}
          >
            <Home className={SIDEBAR_ROW_ICON} />
            <span className={SIDEBAR_ROW_LABEL}>{t('sidebar.home')}</span>
          </a>
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            tabIndex={isOpen ? 0 : -1}
            className={`${SIDEBAR_ROW} ${SIDEBAR_ROW_DESTRUCTIVE} disabled:opacity-50`}
          >
            <LogOut className={SIDEBAR_ROW_ICON} />
            <span className={SIDEBAR_ROW_LABEL}>
              {isLoggingOut ? t('sidebar.loggingOut') : t('sidebar.logout')}
            </span>
          </button>
        </div>
      </div>
      {/* Desktop static sidebar */}
      <div className="hidden h-full flex-col lg:flex">
        <div className="flex flex-col gap-4 px-4 pt-6">
          <span className="flex items-center justify-center px-2">
            {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
            <img
              src={logo.src}
              alt="Okazakee CMS"
              width={1937}
              height={293}
              className="hidden h-7 w-auto max-w-full shrink-0 object-contain dark:block"
            />
            {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
            <img
              src={logoLight.src}
              alt="Okazakee CMS"
              width={1942}
              height={294}
              className="block h-7 w-auto max-w-full shrink-0 object-contain dark:hidden"
            />
          </span>
          <UserBanner />
        </div>
        {pendingCount > 0 && (
          <div className="mx-4 mt-4 mb-1 rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-800/50 dark:bg-amber-900/10">
            <div className="mb-1 flex items-center gap-2">
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-400" />
              <span className="flex-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                {t('sidebar.pendingSections', {
                  count: Object.values(publishQueue).filter((s) => s.isDirty)
                    .length,
                })}
              </span>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={isPublishingAll}
                onClick={discardAllDirty}
                className="min-h-11 flex-1 rounded-lg border border-border-subtle bg-surface-raised px-2 py-1 text-xs text-text-main transition-colors hover:border-border-hover disabled:opacity-50"
              >
                {t('common.revert')}
              </button>
              <button
                type="button"
                disabled={isPublishingAll}
                onClick={() => void publishAll()}
                className="min-h-11 flex-1 rounded-lg bg-accent-violet-deep px-2 py-1 text-xs text-white transition-colors hover:bg-accent-violet disabled:opacity-50"
              >
                {isPublishingAll
                  ? t('common.publishing')
                  : t('sidebar.publishAll')}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mx-4 my-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="p-4 pb-2">
            {MENU_GROUPS.map((group) => (
              <div key={group.caption} className="mb-4 last:mb-0">
                <p className="mb-2 text-xs font-semibold tracking-wider text-text-dim uppercase">
                  {t(`sidebar.navGroup.${group.caption}`)}
                </p>
                <nav className="space-y-1">
                  {getFilteredItems(group.items).map(renderNavItem)}
                </nav>
              </div>
            ))}
          </div>

          <div className="space-y-1 border-t border-border-subtle px-4 pt-4 pb-4">
            <ThemeToggle sidebar />
            <LanguageToggle sidebar />
            <button
              type="button"
              onClick={() => handleSelectSection('account')}
              aria-current={activeSection === 'account' ? 'page' : undefined}
              className={`${SIDEBAR_ROW} ${
                activeSection === 'account'
                  ? SIDEBAR_ROW_ACTIVE
                  : SIDEBAR_ROW_NEUTRAL
              }`}
            >
              <Settings className={SIDEBAR_ROW_ICON} />
              <span className={SIDEBAR_ROW_LABEL}>
                {t('sidebar.myAccount')}
              </span>
            </button>

            <a
              href={publicSiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${SIDEBAR_ROW} ${SIDEBAR_ROW_NEUTRAL}`}
            >
              <Home className={SIDEBAR_ROW_ICON} />
              <span className={SIDEBAR_ROW_LABEL}>{t('sidebar.home')}</span>
            </a>

            <button
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className={`${SIDEBAR_ROW} ${SIDEBAR_ROW_DESTRUCTIVE} disabled:opacity-50`}
            >
              <LogOut className={SIDEBAR_ROW_ICON} />
              <span className={SIDEBAR_ROW_LABEL}>
                {isLoggingOut ? t('sidebar.loggingOut') : t('sidebar.logout')}
              </span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default SidePanel;

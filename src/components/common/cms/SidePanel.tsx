'use client';

import {
  Briefcase,
  ChevronLeft,
  Contact,
  Crown,
  FileText,
  Home,
  LayoutGrid,
  LogOut,
  NotebookPen,
  Settings,
  User2,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { GithubIcon } from '@/components/common/BrandIcons';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import LanguageToggle from '@/components/layout/LanguageToggle';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { useCmsStore } from '@/store/cmsStore';
import { createClient } from '@/utils/supabase/client';

// Public website URL for cross-app links (CMS Home button).
const publicSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://okazakee.dev';

interface SidePanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly: boolean;
}

const CONTENT_ITEMS: MenuItem[] = [
  { id: 'hero', label: '', icon: Home, adminOnly: true },
  { id: 'skills', label: '', icon: Zap, adminOnly: true },
  { id: 'career', label: '', icon: User2, adminOnly: true },
  { id: 'portfolio', label: '', icon: Briefcase, adminOnly: false },
  { id: 'blog', label: '', icon: NotebookPen, adminOnly: false },
  { id: 'contacts', label: '', icon: Contact, adminOnly: true },
];

const CONFIG_ITEMS: MenuItem[] = [
  { id: 'layout', label: '', icon: LayoutGrid, adminOnly: true },
  { id: 'privacy-policy', label: '', icon: FileText, adminOnly: true },
  { id: 'users', label: '', icon: Users, adminOnly: true },
];

const SidePanel = ({ isOpen = true, onClose }: SidePanelProps) => {
  const t = useTranslations('cms');
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const pathname = usePathname();
  const locale = pathname.split('/')[1] || 'en';

  const {
    activeSection,
    setActiveSection,
    user,
    setUser,
    setHeroSection,
    publishQueue,
    sidebarCollapsed,
    toggleSidebar,
  } = useCmsStore();

  const isAdmin = user?.role === 'admin';

  const sectionLabelMap: Record<string, string> = {
    hero: t('sidebar.nav.hero'),
    skills: t('sidebar.nav.skills'),
    career: t('sidebar.nav.career'),
    portfolio: t('sidebar.nav.portfolio'),
    blog: t('sidebar.nav.blog'),
    contacts: t('sidebar.nav.contacts'),
    layout: t('sidebar.nav.layout'),
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
    setIsLoggingOut(true);
    setUser(null);
    setHeroSection(null);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = `/${locale}/cms/login`;
  };

  const pendingCount = Object.values(publishQueue).reduce(
    (sum, state) => sum + (state.isDirty ? state.changeCount : 0),
    0
  );

  const hasDraft = (sectionId: string) =>
    publishQueue[sectionId]?.isDirty ?? false;

  const getFilteredItems = (items: MenuItem[]) =>
    items.filter((item) => !item.adminOnly || isAdmin);

  useEffect(() => {
    if (!user || isAdmin) return;
    if (
      typeof window !== 'undefined' &&
      activeSection
    ) {
      const savedSection = localStorage.getItem('cms_active_section');
      const adminOnlySections = [
        'hero', 'skills', 'career', 'contacts', 'layout',
        'privacy-policy', 'users',
      ];
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
      className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all duration-200 text-left ${
        activeSection === item.id
          ? 'bg-main text-white shadow-lg'
          : 'bg-gray-100 hover:bg-gray-200 dark:bg-darkergray dark:hover:bg-darkgray text-darktext dark:text-lighttext hover:text-darktext dark:hover:text-white'
      } ${sidebarCollapsed ? 'justify-center' : ''}`}
      title={
        sidebarCollapsed
          ? `${sectionLabelMap[item.id] || item.label}${hasDraft(item.id) ? ' · unsaved' : ''}`
          : undefined
      }
    >
      <div className="relative">
        <item.icon className="w-5 h-5" />
        {hasDraft(item.id) && (
          <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full" />
        )}
      </div>
      {!sidebarCollapsed && (
        <>
          <span className="font-medium flex-1">
            {sectionLabelMap[item.id] || item.label}
          </span>
          {hasDraft(item.id) && (
            <span className="w-2 h-2 bg-amber-400 rounded-full flex-shrink-0" />
          )}
        </>
      )}
    </button>
  );

  return (
    <>
      {onClose && (
        <div
          className={`fixed inset-0 bg-black/50 z-40 lg:hidden transition-opacity duration-300 ${
            isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        className={`text-darktext dark:text-lighttext flex flex-col h-full bg-bglight dark:bg-bgdark transition-all duration-300 ${
          sidebarCollapsed ? 'w-16' : 'w-72'
        } ${
          onClose
            ? `fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out lg:static lg:transform-none lg:z-auto ${
                isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
              }`
            : 'relative'
        }`}
      >
        {/* Mobile Header */}
        {onClose && (
          <div className="p-4 border-b border-gray-200 dark:border-darkgray flex-shrink-0 flex items-center justify-between lg:hidden">
            <div className="flex-1">
              <h1 className="text-xl font-bold text-main mb-1">
                {t('sidebar.title')}
              </h1>
              <p className="text-gray-500 dark:text-lighttext2 text-xs">
                {t('sidebar.subtitle')}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-gray-500 dark:text-lighttext2 hover:text-darktext dark:hover:text-lighttext transition-colors"
              aria-label="Close menu"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        )}

        {/* Desktop Header */}
        {!onClose && !sidebarCollapsed && (
          <div className="p-4 border-b border-gray-200 dark:border-darkgray flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="text-left">
                <h1 className="text-xl font-bold text-main mb-1">
                  {t('sidebar.title')}
                </h1>
                <p className="text-gray-500 dark:text-lighttext2 text-xs">
                  {t('sidebar.subtitle')}
                </p>
              </div>
              <button
                type="button"
                onClick={toggleSidebar}
                className="p-2 text-gray-500 dark:text-lighttext2 hover:text-main transition-colors rounded-lg"
                title={t('common.collapseSidebar')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Collapsed Desktop Header */}
        {!onClose && sidebarCollapsed && (
          <div className="p-2 border-b border-gray-200 dark:border-darkgray flex-shrink-0 flex justify-center">
            <button
              type="button"
              onClick={toggleSidebar}
              className="p-2 text-gray-500 dark:text-lighttext2 hover:text-main transition-colors rounded-lg"
              title={t('common.expandSidebar')}
            >
              <ChevronLeft className="w-4 h-4 rotate-180" />
            </button>
          </div>
        )}

        {/* User Profile */}
        {user && !sidebarCollapsed && (
          <div className="p-4 border-b border-gray-200 dark:border-darkgray flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="relative w-12 h-12 rounded-full overflow-hidden bg-gray-200 dark:bg-darkergray flex-shrink-0">
                {user.avatarUrl && user.avatarUrl.length > 0 ? (
                  <Image
                    src={user.avatarUrl}
                    alt={user.displayName || 'User'}
                    fill
                    sizes="48px"
                    className="object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-main text-white text-lg font-bold">
                    {(user.displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-darktext dark:text-lighttext truncate">
                    {user.displayName}
                  </span>
                  {isAdmin && (
                    <Crown className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-lighttext2">
                  {user.authProvider === 'github' ? (
                    <>
                      <GithubIcon className="w-3 h-3" />
                      <span>@{user.githubUsername}</span>
                    </>
                  ) : (
                    <span className="truncate">{user.email}</span>
                  )}
                </div>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    isAdmin
                      ? 'bg-yellow-500/20 text-yellow-500'
                      : 'bg-blue-500/20 text-blue-400'
                  }`}
                >
                  {user.role || 'user'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Collapsed user avatar */}
        {user && sidebarCollapsed && (
          <div className="p-2 border-b border-gray-200 dark:border-darkgray flex-shrink-0 flex justify-center">
            <div className="relative w-10 h-10 rounded-full overflow-hidden bg-gray-200 dark:bg-darkergray">
              {user.avatarUrl && user.avatarUrl.length > 0 ? (
                <Image
                  src={user.avatarUrl}
                  alt={user.displayName || 'User'}
                  fill
                  sizes="40px"
                  className="object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-main text-white font-bold">
                  {(user.displayName || 'U').charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Publish Status */}
        {!sidebarCollapsed && pendingCount > 0 && (
          <div className="mx-4 mb-1 p-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/10">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 bg-amber-400 rounded-full flex-shrink-0" />
              <span className="text-xs text-amber-700 dark:text-amber-300 font-medium flex-1">
                {pendingCount} {pendingCount === 1 ? 'change' : 'changes'} across{' '}
                {Object.values(publishQueue).filter((s) => s.isDirty).length} section(s)
              </span>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => useCmsStore.getState().sectionRevertCallback?.()}
                className="flex-1 px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors min-h-[28px]"
              >
                {t('common.revert')}
              </button>
              <button
                type="button"
                onClick={() => useCmsStore.getState().sectionPublishCallback?.()}
                className="flex-1 px-2 py-1 text-xs bg-main hover:bg-secondary text-white rounded transition-colors min-h-[28px]"
              >
                {t('common.publish')}
              </button>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto flex flex-col">
          <div className="p-4 pb-2">
            {!sidebarCollapsed && (
              <p className="text-xs font-semibold text-gray-400 dark:text-lighttext2 uppercase tracking-wider mb-2">
                {t('common.content')}
              </p>
            )}
            <nav className="space-y-1">
              {getFilteredItems(CONTENT_ITEMS).map(renderNavItem)}
            </nav>

            {!sidebarCollapsed && (
              <p className="text-xs font-semibold text-gray-400 dark:text-lighttext2 uppercase tracking-wider mt-4 mb-2">
                {t('common.configuration')}
              </p>
            )}
            <nav className="space-y-1">
              {getFilteredItems(CONFIG_ITEMS).map(renderNavItem)}
            </nav>
          </div>

          {/* Account, Home & Logout */}
          <div className="px-4 pt-4 pb-4 border-t border-gray-200 dark:border-darkgray space-y-1">
            {!sidebarCollapsed && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <ThemeToggle sidebar />
                <LanguageToggle sidebar />
              </div>
            )}

            <button
              type="button"
              onClick={() => handleSelectSection('account')}
              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all duration-200 ${
                activeSection === 'account'
                  ? 'bg-main text-white shadow-lg'
                  : 'bg-gray-100 hover:bg-gray-200 dark:bg-darkergray dark:hover:bg-darkgray text-darktext dark:text-lighttext hover:text-darktext dark:hover:text-white'
              } ${sidebarCollapsed ? 'justify-center' : ''}`}
              title={sidebarCollapsed ? t('sidebar.myAccount') : undefined}
            >
              <Settings className="w-5 h-5" />
              {!sidebarCollapsed && (
                <span className="font-medium">{t('sidebar.myAccount')}</span>
              )}
            </button>

            {!sidebarCollapsed && (
              <a
                href={publicSiteUrl}
                className="w-full flex items-center gap-3 p-3 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-darkergray dark:hover:bg-darkgray text-darktext dark:text-lighttext hover:text-darktext dark:hover:text-white transition-all duration-200"
              >
                <Home className="w-5 h-5" />
                <span className="font-medium">{t('sidebar.home')}</span>
              </a>
            )}

            {sidebarCollapsed && (
              <a
                href={publicSiteUrl}
                className="w-full flex items-center justify-center p-3 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-darkergray dark:hover:bg-darkgray text-darktext dark:text-lighttext transition-all duration-200"
                title={t('sidebar.home')}
              >
                <Home className="w-5 h-5" />
              </a>
            )}

            <button
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className={`w-full flex items-center gap-3 p-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-all duration-200 disabled:opacity-50 ${
                sidebarCollapsed ? 'justify-center' : ''
              }`}
              title={sidebarCollapsed ? t('sidebar.logout') : undefined}
            >
              <LogOut className="w-5 h-5" />
              {!sidebarCollapsed && (
                <span className="font-medium">
                  {isLoggingOut ? t('sidebar.loggingOut') : t('sidebar.logout')}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default SidePanel;

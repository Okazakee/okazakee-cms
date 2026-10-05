'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { getCmsBootData } from '@/app/actions/cms/getUser';
import BlogSection from '@/components/cms/sections/Blog/BlogSection';
import CareerSection from '@/components/cms/sections/Career/CareerSection';
import ContactsSection from '@/components/cms/sections/Contacts/ContactsSection';
import { RequestCopySection } from '@/components/cms/sections/Copy/CopySections';
import HeroSection from '@/components/cms/sections/Hero/HeroSection';
import { LayoutSection } from '@/components/cms/sections/Layout/LayoutSection';
import PortfolioSection from '@/components/cms/sections/Portfolio/PortfolioSection';
import PrivacyPolicySection from '@/components/cms/sections/Privacy/PrivacyPolicySection';
import RequestsSection from '@/components/cms/sections/Requests/RequestsSection';
import SkillsSection from '@/components/cms/sections/Skills/SkillsSection';
import UsersSection from '@/components/cms/sections/Users/UsersSection';
import AccountSection from '@/components/common/cms/AccountSection';
import { CmsHeader } from '@/components/common/cms/CmsHeader';
import SidePanel from '@/components/common/cms/SidePanel';
import { useCmsStore } from '@/store/cmsStore';

// Page order: the sidebar reads top-to-bottom like the public page does.
const pageSections = [
  'layout',
  'hero',
  'skills',
  'career',
  'portfolio',
  'blog',
  'contacts',
];
const inboxSections = ['requests'];
const systemSections = ['request-form', 'privacy-policy', 'users', 'account'];
const adminSections = [...pageSections, ...inboxSections, ...systemSections];
const editorSections = ['portfolio', 'blog', 'account'];

function Editor({ section }: { section: string }) {
  switch (section) {
    case 'layout':
      return <LayoutSection />;
    case 'hero':
      return <HeroSection />;
    case 'skills':
      return <SkillsSection />;
    case 'career':
      return <CareerSection />;
    case 'portfolio':
      return <PortfolioSection />;
    case 'blog':
      return <BlogSection />;
    case 'contacts':
      return <ContactsSection />;
    case 'request-form':
      return <RequestCopySection />;
    case 'requests':
      return <RequestsSection />;
    case 'privacy-policy':
      return <PrivacyPolicySection />;
    case 'users':
      return <UsersSection />;
    case 'account':
      return <AccountSection />;
    default:
      return null;
  }
}

export default function CMSPage() {
  const t = useTranslations('cms');
  const router = useRouter();
  const {
    user,
    activeSection,
    sidePanelSections,
    isPublishingAll,
    warning,
    error,
  } = useCmsStore();
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [visited, setVisited] = useState<string[]>([]);
  const initialized = useRef(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void getCmsBootData()
      .then((boot) => {
        if (boot.status === 'error') throw new Error(boot.error);
        if (boot.status !== 'ok') {
          router.replace('/login');
          return;
        }
        const sections =
          boot.user.role === 'admin' ? adminSections : editorSections;
        const store = useCmsStore.getState();
        store.setUser(boot.user);
        store.setHeroSection(boot.heroSection);
        store.setSidePanelSections(sections);
        const initial = sections.includes(store.activeSection || '')
          ? (store.activeSection as string)
          : sections[0];
        store.setActiveSection(initial);
        setVisited([initial]);
        setBooting(false);
      })
      .catch((err: unknown) => {
        setBootError(err instanceof Error ? err.message : t('page.initError'));
        setBooting(false);
      });
  }, [router, t]);

  useEffect(() => {
    if (!user || !activeSection || !sidePanelSections.includes(activeSection))
      return;
    // Keep visited editors mounted: local drafts and registered callbacks must
    // survive navigation so Publish All can commit every subscribed section.
    setVisited((prev) =>
      prev.includes(activeSection) ? prev : [...prev, activeSection]
    );
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [activeSection, sidePanelSections, user]);

  if (booting)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-base text-sm text-text-muted">
        <span role="status">{t('common.loading')}</span>
      </div>
    );
  if (bootError)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-base px-6 text-text-main">
        <p role="alert">{bootError}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-11 rounded-lg bg-accent-violet-deep px-4 text-white"
        >
          {t('common.retry')}
        </button>
      </div>
    );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface-base text-text-main">
      <CmsHeader
        onMenuClick={() => setMobileMenuOpen((open) => !open)}
        menuOpen={mobileMenuOpen}
      />
      <div className="flex min-h-0 flex-1">
        <SidePanel
          isOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
        />
        <main
          ref={mainRef}
          id="cms-workspace"
          className="min-w-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto max-w-5xl px-6 py-10 sm:py-12 lg:py-12">
            {error && (
              <div
                role="alert"
                className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-300"
              >
                <p className="whitespace-pre-line">{error}</p>
                <button
                  type="button"
                  className="mt-2 underline"
                  onClick={() => useCmsStore.getState().setError(null)}
                >
                  {t('common.close')}
                </button>
              </div>
            )}
            {warning && (
              <div
                role="status"
                className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300"
              >
                <p>{warning}</p>
                <button
                  type="button"
                  onClick={() => useCmsStore.getState().setWarning(null)}
                  aria-label={t('common.close')}
                  className="shrink-0 underline"
                >
                  {t('common.close')}
                </button>
              </div>
            )}
            <fieldset disabled={isPublishingAll} className="min-w-0">
              {visited
                .filter((section) => sidePanelSections.includes(section))
                .map((section) => (
                  <div
                    key={section}
                    hidden={section !== activeSection}
                    data-section={section}
                  >
                    <Editor section={section} />
                  </div>
                ))}
            </fieldset>
          </div>
        </main>
      </div>
    </div>
  );
}

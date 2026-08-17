'use client';

import {
  Briefcase,
  Contact,
  Home,
  Menu,
  NotebookPen,
  Settings,
  User2,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import LanguageToggle from './LanguageToggle';
import ThemeToggle from './ThemeToggle';

const createMenuItems = (locale: string) => [
  { href: `/${locale}`, icon: Home, isAnchor: false },
  { href: 'skills', icon: Zap, isAnchor: true },
  { href: 'career', icon: User2, isAnchor: true },
  { href: `/${locale}/portfolio`, icon: Briefcase, isAnchor: false },
  { href: `/${locale}/blog`, icon: NotebookPen, isAnchor: false },
  { href: 'contacts', icon: Contact, isAnchor: true },
  // Resume button removed from main navigation
];

// Create a hardcoded mapping for Italian translations
const getItalianButtonText = (index: number) => {
  const italianButtons = [
    'Home',
    'Skills',
    'Carriera',
    'Portfolio',
    'Blog',
    'Contatti',
    'Curriculum',
  ];
  return italianButtons[index];
};

export default function ResponsiveNav({
  className,
  locale,
}: {
  className?: string;
  locale: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const menuItems = createMenuItems(locale);
  const t = useTranslations('header');
  const pathname = usePathname();
  const router = useRouter();
  const isHomePage = pathname === '/' || pathname === `/${locale}`;
  const isCms = pathname.includes('/cms');
  const isLogin = pathname.includes('/cms/login');
  const isRegister = pathname.includes('/cms/register');

  useEffect(() => {
    // Handle scrolling when we're on the home page and have a pending scroll target
    if (isHomePage && pendingScroll) {
      const element = document.getElementById(pendingScroll);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
        setPendingScroll(null); // Clear the pending scroll
      }
    }
  }, [isHomePage, pendingScroll]);

  const handleClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
    isAnchor: boolean
  ) => {
    if (!isAnchor) return;

    e.preventDefault();
    setIsOpen(false);

    if (isHomePage) {
      // If we're already on the home page, just scroll
      const element = document.getElementById(href);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    } else {
      // If we're on another page, navigate to home first and set pending scroll
      setPendingScroll(href);
      router.push(`/${locale}`);
    }
  };

  const getHref = (item: { href: string; isAnchor: boolean }) => {
    if (item.isAnchor) {
      // For anchor links, we'll handle the navigation in onClick
      // but we still need a valid href for the link
      return `/${locale}`;
    }
    return item.href;
  };

  // Function to get button text based on locale
  const getButtonText = (index: number) => {
    if (locale === 'it') {
      return getItalianButtonText(index);
    }
    // For English, use the translation system
    return t(`buttons.${index}`);
  };

  // Close settings dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (isSettingsOpen && !target.closest('.settings-dropdown')) {
        setIsSettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isSettingsOpen]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, [isOpen]);

  return (
    <>
      {!isCms ? (
        <>
          {/* Desktop Navigation */}
          <nav className={`${className} hidden lg:flex text-xl`}>
            {menuItems.map((button, i) => {
              const href = getHref(button);

              return (
                <Link
                  key={button.href}
                  href={href}
                  className="mx-4 transition-all hover:text-main flex items-center"
                  onClick={(e) => handleClick(e, button.href, button.isAnchor)}
                >
                  <button.icon className="mr-2 -mt-1" />
                  {getButtonText(i)}
                </Link>
              );
            })}
            <div className="relative ml-4 settings-dropdown">
              <button
                onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                className={`transition-all hover:text-main flex items-center justify-center p-2 rounded-full ${
                  isSettingsOpen ? 'bg-gray-100 dark:bg-gray-800 text-main' : ''
                }`}
                aria-label="Settings"
                type="button"
              >
                <Settings size={25} />
              </button>

              {isSettingsOpen && (
                <div className="absolute right-0 mt-2 py-4 px-5 bg-white dark:bg-darkergray shadow-lg rounded-xl z-50 min-w-[180px] border border-gray-100 dark:border-gray-800 transform-gpu origin-top-right transition-all duration-200 ease-out">
                  <h3 className="text-base font-medium mb-3 text-gray-500 dark:text-gray-400 text-center">
                    {t('settings')}
                  </h3>

                  <div className="mb-4 flex justify-between items-center">
                    <span className="text-base font-medium">
                      {t('language')}:
                    </span>
                    <span className="flex justify-end min-w-[40px]">
                      <LanguageToggle compact={true} />
                    </span>
                  </div>

                  <div className="pt-2 flex justify-between items-center border-t border-gray-100 dark:border-gray-800">
                    <span className="text-base font-medium">{t('theme')}:</span>
                    <span className="flex justify-end min-w-[40px]">
                      <ThemeToggle compact={true} />
                    </span>
                  </div>
                </div>
              )}
            </div>
          </nav>

          {/* Mobile Navigation */}
          <div className={`${className} lg:hidden`}>
            <div className="flex items-center relative z-50">
              <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="sm:w-12 sm:h-12 flex items-center justify-center transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
                aria-label="Toggle menu"
              >
                {isOpen ? (
                  <X className="w-6 h-6 sm:w-7 sm:h-7" />
                ) : (
                  <Menu className="w-6 h-6 sm:w-7 sm:h-7" />
                )}
              </button>
            </div>

            <nav
              className={`fixed mt-2 backdrop-blur-[70px] shadow-lg z-10 -top-1.5 left-1/2 transform-gpu -translate-x-1/2 w-screen h-screen max-w-full max-h-full right-auto flex justify-center items-center transition-all duration-400 ease-in-out ${
                isOpen
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 -translate-y-20 pointer-events-none'
              }`}
            >
              <ul
                className={`space-y-12 sm:space-y-16 md:space-y-20 p-4 xs:scale-100 scale-110 sm:scale-105 md:scale-110 lg:scale-115 -mt-8 sm:-mt-12 md:-mt-16 transition-all duration-400 ease-in-out ${
                  isOpen ? 'opacity-100' : 'opacity-0'
                }`}
              >
                {menuItems.map((item, i) => {
                  const href = getHref(item);

                  return (
                    <li key={item.href}>
                      <Link
                        href={href}
                        className="flex text-2xl sm:text-3xl md:text-4xl items-center space-x-2 sm:space-x-3 text-darktext dark:text-lighttext transition-all duration-400 ease-in-out"
                        onClick={(e) => {
                          handleClick(e, item.href, item.isAnchor);
                          setIsOpen(false);
                        }}
                      >
                        <item.icon className="w-6 h-6 sm:w-7 sm:h-7 md:w-8 md:h-8 mr-2" />
                        <span>{getButtonText(i)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div
                className={`flex space-x-3 sm:space-x-4 md:space-x-5 bottom-6 sm:bottom-8 md:bottom-10 absolute left-1/2 transform-gpu -translate-x-1/2 scale-75 sm:scale-100 md:scale-110 lg:scale-125 transition-all duration-400 ease-in-out ${
                  isOpen ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <LanguageToggle compact={false} />
                <ThemeToggle compact={false} />
              </div>
            </nav>
          </div>
        </>
      ) : (
        /* CMS Navigation - minimal for login page only */
        (isLogin || isRegister) && (
          <div className="flex items-center justify-end w-full">
            <Link
              href={'/'}
              className="mx-4 transition-all hover:text-main flex items-center"
            >
              <Home className="mr-2 -mt-1" />
              Home
            </Link>
          </div>
        )
      )}
    </>
  );
}

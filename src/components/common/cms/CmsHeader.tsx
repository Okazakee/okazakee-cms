'use client';

import titleCms from '@public/title-cms.png';
import titleCmsLight from '@public/title-cms-lightmode.png';
import { Crown, Menu } from 'lucide-react';
import Image from 'next/image';
import { GithubIcon } from '@/components/common/BrandIcons';
import { useCmsStore } from '@/store/cmsStore';

interface CmsHeaderProps {
  onMenuClick: () => void;
}

// Full-width top bar: hamburger left + centered logo + avatar right on
// mobile; logo left + identity right on desktop. The desktop logo renders
// in a 4rem band slightly cropped top and bottom.
export function CmsHeader({ onMenuClick }: CmsHeaderProps) {
  const user = useCmsStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  return (
    <header className="shrink-0 z-30 bg-bglight dark:bg-bgdark border-b border-gray-200 dark:border-darkgray px-4 py-2 flex items-center gap-3">
      {/* Mobile: menu trigger on the left */}
      <button
        type="button"
        onClick={onMenuClick}
        className="lg:hidden p-2 -ml-2 text-darktext dark:text-lighttext hover:text-main transition-colors"
        aria-label="Open menu"
      >
        <Menu className="w-6 h-6" />
      </button>

      {/* Mobile: left spacer to center the logo */}
      <div className="flex-1 lg:hidden" />

      {/* Logo: plain on mobile, cropped band on desktop */}
      <div className="flex items-center shrink-0">
        <div className="lg:hidden flex items-center">
          <Image
            src={titleCms}
            alt="Okazakee CMS"
            width={2172}
            height={724}
            className="h-12 w-auto hidden dark:block"
          />
          <Image
            src={titleCmsLight}
            alt="Okazakee CMS"
            width={2172}
            height={724}
            className="h-12 w-auto dark:hidden"
          />
        </div>
        <div className="hidden lg:flex items-center h-12 overflow-hidden">
          <Image
            src={titleCms}
            alt="Okazakee CMS"
            width={2172}
            height={724}
            className="h-26 w-auto hidden dark:block"
          />
          <Image
            src={titleCmsLight}
            alt="Okazakee CMS"
            width={2172}
            height={724}
            className="h-26 w-auto dark:hidden"
          />
        </div>
      </div>

      {/* Mobile: right spacer to center the logo */}
      <div className="flex-1 lg:hidden" />

      {/* Identity (desktop right; avatar-only on mobile) */}
      {user && (
        <div className="flex items-center gap-2.5 min-w-0 shrink-0 lg:ml-auto">
          <div className="relative w-10 h-10 rounded-full overflow-hidden bg-gray-200 dark:bg-darkergray flex-shrink-0">
            {user.avatarUrl && user.avatarUrl.length > 0 ? (
              <Image
                src={user.avatarUrl}
                alt={user.displayName || 'User'}
                fill
                sizes="40px"
                className="object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-main text-white text-sm font-bold">
                {(user.displayName || 'U').charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="hidden sm:flex flex-col items-start min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-darktext dark:text-lighttext truncate">
                {user.displayName}
              </span>
              {isAdmin && (
                <Crown className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
              )}
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  isAdmin
                    ? 'bg-yellow-500/20 text-yellow-500'
                    : 'bg-blue-500/20 text-blue-400'
                }`}
              >
                {user.role || 'user'}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-lighttext2 max-w-[220px]">
              {user.authProvider === 'github' ? (
                <>
                  <GithubIcon className="w-3 h-3 shrink-0" />
                  <span className="truncate">@{user.githubUsername}</span>
                </>
              ) : (
                <span className="truncate">{user.email}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

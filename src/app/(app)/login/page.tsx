'use client';

import logo from '@public/title-cms.png';
import logoLight from '@public/title-cms-lightmode.png';
import { CircleUserRound, Fingerprint, Loader2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { editorSecondaryButtonClass } from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { GithubIcon } from '@/components/common/BrandIcons';
import { enterDemoSession } from '@/libs/demo/session';
import { useCmsStore } from '@/store/cmsStore';
import { createClient } from '@/utils/supabase/client';

// Remembered identity from the last successful boot: lets a returning user
// (stale session, expired token, logout) see who they signed in as last time.
// Display-only — it never authenticates, and forgetting it never signs out.
type LastCmsUser = {
  displayName: string;
  avatarUrl: string | null;
};

type LoginErrorKey =
  | 'errorPasskeyNotFound'
  | 'errorPasskeyCancelled'
  | 'errorPasskeyFailed'
  | 'errorOAuthFailed'
  | 'errorAccessDenied'
  | 'errorOAuthStart';

const LAST_USER_KEY = 'cms_last_user';
const MAX_DISPLAY_NAME_LENGTH = 120;

// Fixed OAuth failure strings the start/callback routes redirect with (see
// buildAuthErrorRedirect). Mapped to localized copy; anything else falls back
// to the generic message so raw query input is never rendered.
const OAUTH_ERROR_KEYS: Record<string, LoginErrorKey> = {
  'Authentication failed': 'errorOAuthFailed',
  'Access denied. Please contact the administrator.': 'errorAccessDenied',
  'Failed to start GitHub login': 'errorOAuthStart',
};

function readLastUser(): LastCmsUser | null {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(LAST_USER_KEY) ?? 'null'
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const { displayName, avatarUrl } = record;
    if (
      typeof displayName !== 'string' ||
      displayName.trim().length === 0 ||
      displayName.length > MAX_DISPLAY_NAME_LENGTH
    ) {
      return null;
    }
    if (avatarUrl !== undefined && avatarUrl !== null) {
      if (typeof avatarUrl !== 'string') return null;
      let url: URL;
      try {
        url = new URL(avatarUrl);
      } catch {
        return null;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
    }
    return {
      displayName,
      avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
    };
  } catch {
    return null;
  }
}

// Component that reads search params - must be wrapped in Suspense
function LoginFormContent() {
  const t = useTranslations('cms');
  const router = useRouter();
  // OAuth failures (?error) and sign-in action failures share one banner.
  // Keys only — raw provider/callback text is never rendered.
  const [queryErrorKey, setQueryErrorKey] = useState<LoginErrorKey | null>(
    null
  );
  const [actionErrorKey, setActionErrorKey] = useState<LoginErrorKey | null>(
    null
  );
  const [isGitHubLoading, setIsGitHubLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  // Offered when this browser can run WebAuthn in this context. Capability
  // check only — never a ceremony, and never gated on a built-in platform
  // authenticator (external security keys may work).
  const [passkeyOffered, setPasskeyOffered] = useState(false);
  // Starts null so SSR and hydration match; filled after mount from
  // localStorage only (never from cookies — there is no usable session here).
  const [lastUser, setLastUser] = useState<LastCmsUser | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    setLastUser(readLastUser());
  }, []);

  useEffect(() => {
    const navigatorRef = window.navigator;
    setPasskeyOffered(
      window.isSecureContext === true &&
        typeof window.PublicKeyCredential !== 'undefined' &&
        !!navigatorRef.credentials &&
        typeof navigatorRef.credentials.get === 'function'
    );
  }, []);

  // Check for error from OAuth callback
  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (!errorParam) return;
    setQueryErrorKey(OAUTH_ERROR_KEYS[errorParam] ?? 'errorOAuthFailed');
  }, [searchParams]);

  const handlePasskeyLogin = () => {
    setActionErrorKey(null);
    setIsPasskeyLoading(true);

    void createClient()
      .auth.signInWithPasskey()
      .then(async ({ error }) => {
        if (error) throw error;
        window.location.href = '/';
      })
      .catch((err: unknown) => {
        console.error('Passkey sign-in failed:', err);
        const name = err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError') {
          // User dismissed the browser prompt: not a failure.
          setActionErrorKey('errorPasskeyCancelled');
        } else if (name === 'NotFoundError') {
          setActionErrorKey('errorPasskeyNotFound');
        } else {
          setActionErrorKey('errorPasskeyFailed');
        }
      })
      .finally(() => {
        setIsPasskeyLoading(false);
      });
  };

  // Offline showcase: fixture data only, no session, no server calls.
  // Offered only with no remembered user (see the branch below).
  const handleDemoLogin = () => {
    enterDemoSession();
    useCmsStore.getState().setDemoMode(true);
    router.replace('/');
  };
  // GitHub OAuth navigation starts here; the callback route owns every
  // post-auth step (allowlist enforcement, profile sync, canonical
  // redirect). Passkey sign-in (below) is the alternative path.
  const handleGitHubLogin = () => {
    setIsGitHubLoading(true);
    setActionErrorKey(null);
    window.location.href = '/auth/github/start';
  };

  // Forgets the remembered display row only: clears the local key and resets
  // the display. This is not a sign-out and does not switch GitHub accounts.
  const handleForgetLastUser = () => {
    try {
      window.localStorage.removeItem(LAST_USER_KEY);
    } catch {
      // Private mode / storage failure: the display reset below still
      // applies for this visit.
    }
    setLastUser(null);
  };

  const handleDismissError = () => {
    setQueryErrorKey(null);
    setActionErrorKey(null);
  };

  let errorMessage: string | null = null;
  if (queryErrorKey) {
    errorMessage = t(`login.${queryErrorKey}`);
  } else if (actionErrorKey) {
    errorMessage = t(`login.${actionErrorKey}`);
  }

  const busy = isGitHubLoading || isPasskeyLoading;

  const authButtons = (
    <>
      <button
        type="button"
        onClick={handleGitHubLogin}
        disabled={busy}
        className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-lg bg-[#24292e] px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-[#1b1f23] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-violet disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isGitHubLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <GithubIcon className="h-5 w-5" aria-hidden="true" />
        )}
        {t('login.continueWithGitHub')}
      </button>

      {passkeyOffered && (
        <button
          type="button"
          onClick={handlePasskeyLogin}
          disabled={busy}
          className={`${editorSecondaryButtonClass} mt-3 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-violet`}
        >
          {isPasskeyLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          ) : (
            <Fingerprint className="h-5 w-5" aria-hidden="true" />
          )}
          {t('login.usePasskey')}
        </button>
      )}
    </>
  );

  return (
    <>
      {lastUser ? (
        <div className="flex flex-col items-center gap-6 md:flex-row md:items-center md:gap-8">
          <div className="shrink-0">
            {lastUser.avatarUrl ? (
              <div className="relative h-40 w-40 overflow-hidden rounded-full ring-2 ring-accent-violet/40">
                {/* biome-ignore lint/performance/noImgElement: user avatar URL, not a static import */}
                <img
                  src={lastUser.avatarUrl}
                  alt={lastUser.displayName}
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <CircleUserRound
                size={152}
                className="text-accent-violet"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="flex w-full min-w-0 flex-col items-center">
            {/* Wordmark inside the content column on desktop */}
            <div className="mb-6 hidden md:block md:self-center">
              {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
              <img
                src={logo.src}
                alt={t('login.wordmarkAlt')}
                width={1937}
                height={293}
                className="hidden h-10 w-auto max-w-full object-contain dark:block"
              />
              {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
              <img
                src={logoLight.src}
                alt={t('login.wordmarkAlt')}
                width={1942}
                height={294}
                className="block h-10 w-auto max-w-full object-contain dark:hidden"
              />
            </div>
            <h1 className="text-center text-2xl font-bold text-text-white">
              {t('login.welcomeBack')}{' '}
              <span className="text-accent-violet">{lastUser.displayName}</span>
              !
            </h1>
            {errorMessage && (
              <div className="mt-4 w-full">
                <ErrorBanner
                  message={errorMessage}
                  onDismiss={handleDismissError}
                />
              </div>
            )}
            {authButtons}
            <button
              type="button"
              onClick={handleForgetLastUser}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center text-xs text-text-muted underline underline-offset-2 transition-colors hover:text-text-main focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-violet"
            >
              {t('login.forgetRemembered')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6 md:flex-row md:items-center md:gap-8">
          <div className="shrink-0">
            <CircleUserRound
              size={152}
              className="text-accent-violet"
              aria-hidden="true"
            />
          </div>
          <div className="flex w-full min-w-0 flex-col items-center">
            <div className="mb-6 hidden md:block md:self-center">
              {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
              <img
                src={logo.src}
                alt={t('login.wordmarkAlt')}
                width={1937}
                height={293}
                className="hidden h-10 w-auto max-w-full object-contain dark:block"
              />
              {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
              <img
                src={logoLight.src}
                alt={t('login.wordmarkAlt')}
                width={1942}
                height={294}
                className="block h-10 w-auto max-w-full object-contain dark:hidden"
              />
            </div>
            <p className="mt-2 text-center text-sm text-text-muted">
              {t('login.subtitle')}
            </p>
            {errorMessage && (
              <div className="mt-4 w-full">
                <ErrorBanner
                  message={errorMessage}
                  onDismiss={handleDismissError}
                />
              </div>
            )}
            {authButtons}
            <button
              type="button"
              onClick={handleDemoLogin}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center text-xs text-text-muted underline underline-offset-2 transition-colors hover:text-text-main focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-violet"
            >
              {t('login.demo')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Main page component with Suspense boundary; the card is centered on both
// axes of the viewport.
export default function LoginPage() {
  const t = useTranslations('cms');

  return (
    <main className="flex min-h-svh flex-col px-4 py-8 md:items-center md:justify-center">
      <div className="mb-8 flex w-full justify-center md:hidden">
        {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
        <img
          src={logo.src}
          alt={t('login.wordmarkAlt')}
          width={1937}
          height={293}
          className="hidden h-10 w-auto max-w-full object-contain dark:block"
        />
        {/* biome-ignore lint/performance/noImgElement: static CMS brand asset */}
        <img
          src={logoLight.src}
          alt={t('login.wordmarkAlt')}
          width={1942}
          height={294}
          className="block h-10 w-auto max-w-full object-contain dark:hidden"
        />
      </div>
      <div className="flex w-full flex-1 items-center justify-center md:flex-none">
        <div className="w-full max-w-md md:max-w-3xl md:rounded-2xl md:border md:border-border-subtle md:bg-surface-card md:px-12 md:py-10">
          <Suspense
            fallback={
              <div className="flex flex-col items-center justify-center py-16">
                <Loader2
                  className="mb-4 h-8 w-8 animate-spin text-accent-violet"
                  aria-hidden="true"
                />
                <p className="text-text-muted">{t('common.loading')}</p>
              </div>
            }
          >
            <LoginFormContent />
          </Suspense>
        </div>
      </div>
    </main>
  );
}

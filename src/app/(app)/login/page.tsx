'use client';

import { CircleUserRound, Fingerprint, Loader2 } from 'lucide-react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { GithubIcon } from '@/components/common/BrandIcons';
import { createClient } from '@/utils/supabase/client';

// Remembered identity from the last successful boot: lets a returning user
// (stale session, expired token, logout) see who they signed in as last time.
type LastCmsUser = {
  displayName?: string;
  avatarUrl?: string | null;
};

const LAST_USER_KEY = 'cms_last_user';

function readLastUser(): LastCmsUser | null {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LAST_USER_KEY) ?? 'null'
    ) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as LastCmsUser;
  } catch {
    return null;
  }
}

// Component that reads search params - must be wrapped in Suspense
function LoginFormContent({ initialError }: { initialError?: string | null }) {
  const [error, setError] = useState<string | null>(initialError || null);
  const [isGitHubLoading, setIsGitHubLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  // WebAuthn platform-authenticator availability (browser-only signal).
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  // Starts null so SSR and hydration match; filled after mount from
  // localStorage only (never from cookies — there is no usable session here).
  const [lastUser, setLastUser] = useState<LastCmsUser | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    setLastUser(readLastUser());
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof window.PublicKeyCredential === 'undefined') return;
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()
      .then((available) => {
        if (!cancelled) setPasskeyAvailable(Boolean(available));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Check for error from OAuth callback
  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      setError(errorParam);
    }
  }, [searchParams]);

  // GitHub OAuth is the only sign-in path: navigation happens here and the
  // callback route owns every post-auth step (allowlist enforcement, profile
  // sync, canonical redirect).
  const handleGitHubLogin = () => {
    setIsGitHubLoading(true);
    setError(null);
    window.location.href = '/auth/github/start';
  };

  // Standalone passkey sign-in: creates a full session (same authority as
  // OAuth). The browser client persists session cookies; a full navigation
  // lets the proxy validate the session and the allowlist.
  const handlePasskeyLogin = async () => {
    setIsPasskeyLoading(true);
    setError(null);
    try {
      const { error } = await createClient().auth.signInWithPasskey();
      if (error) {
        console.error('Passkey sign-in failed:', error);
        setError(
          `Passkey sign-in failed: ${error.message || error.name}. Please try again.`
        );
        setIsPasskeyLoading(false);
        return;
      }
      window.location.href = '/';
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const message = err instanceof Error ? err.message : '';
      // NotAllowedError: the user dismissed the authenticator prompt.
      if (name !== 'NotAllowedError') {
        console.error('Passkey sign-in failed:', err);
        setError(
          name === 'NotFoundError'
            ? 'No passkey found on this device. Sign in with GitHub, then add one from the Account tab.'
            : `Passkey sign-in failed: ${message || name || 'unknown error'}. Please try again.`
        );
      }
      setIsPasskeyLoading(false);
    }
  };

  return (
    <>
      {lastUser?.avatarUrl ? (
        <div className="relative w-28 h-28 mx-auto mb-6 rounded-full overflow-hidden ring-2 ring-main/40">
          <Image
            src={lastUser.avatarUrl}
            alt={lastUser.displayName || 'User'}
            fill
            sizes="112px"
            className="object-cover"
          />
        </div>
      ) : (
        <CircleUserRound size={104} className="mx-auto mb-6 text-main" />
      )}

      <h1 className="text-3xl font-bold text-center mb-8 text-darktext dark:text-lighttext">
        {lastUser?.displayName ? (
          <>
            Welcome back
            <span className="block text-main">{lastUser.displayName}</span>
          </>
        ) : (
          'CMS Login'
        )}
      </h1>

      {error && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3 mb-4">
          <p className="text-red-500 text-sm">{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={handleGitHubLogin}
        disabled={isGitHubLoading || isPasskeyLoading}
        className="w-full flex items-center justify-center gap-3 text-xl bg-[#24292e] text-white transition-all py-3.5 rounded-lg hover:bg-[#1b1f23] focus:outline-hidden disabled:opacity-50"
      >
        {isGitHubLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <GithubIcon className="w-5 h-5" />
        )}
        Continue with GitHub
      </button>

      {passkeyAvailable && (
        <button
          type="button"
          onClick={handlePasskeyLogin}
          disabled={isGitHubLoading || isPasskeyLoading}
          className="w-full flex items-center justify-center gap-3 text-lg text-main border border-main/60 transition-all py-3 rounded-lg hover:bg-main/10 focus:outline-hidden disabled:opacity-50 mt-3"
        >
          {isPasskeyLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Fingerprint className="w-5 h-5" />
          )}
          Use passkey
        </button>
      )}
    </>
  );
}

// Main page component with Suspense boundary; the card is centered on both
// axes of the viewport.
export default function LoginPage() {
  return (
    <section className="min-h-svh flex items-center justify-center px-4">
      <div className="w-full max-w-lg p-10 rounded-2xl bg-darkgray/40 dark:bg-darkergray/60">
        <Suspense
          fallback={
            <div className="flex flex-col items-center justify-center py-32">
              <Loader2 className="w-8 h-8 animate-spin text-main mb-4" />
              <p className="text-lighttext2">Loading...</p>
            </div>
          }
        >
          <LoginFormContent />
        </Suspense>
      </div>
    </section>
  );
}

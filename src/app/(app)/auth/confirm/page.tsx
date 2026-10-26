'use client';

import { Fingerprint, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { confirmCmsInvite } from '@/app/actions/cms/onboardingActions';
import { editorSecondaryButtonClass } from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { parseInviteLink } from './parseInviteLink';

/**
 * Public invitation-confirmation surface.
 *
 * The standard Supabase invite email lands here with the session tokens in
 * the URL fragment. The tokens are captured and the address bar is scrubbed
 * (history.replaceState) BEFORE any request, then handed once to the
 * confirmCmsInvite Server Action, which re-validates them, enforces the
 * allowlist (signing out unauthorized identities) and redirects to the
 * protected setup surface. Tokens are never stored in React state, storage or
 * logs, and provider error text is never rendered.
 */

type ConfirmState = 'working' | 'invalid-link' | 'unauthorized' | 'failed';

type ConfirmErrorState = Exclude<ConfirmState, 'working'>;

const ERROR_KEYS: Record<ConfirmErrorState, string> = {
  'invalid-link': 'onboarding.errorInvalidLink',
  unauthorized: 'onboarding.errorAccessDenied',
  failed: 'onboarding.errorFailed',
};

function isRedirectError(error: unknown): boolean {
  if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT')) {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'digest' in error) {
    const { digest } = error;
    return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
  }
  return false;
}

export default function AuthConfirmPage() {
  const t = useTranslations('cms');
  const [state, setState] = useState<ConfirmState>('working');
  // React 19 StrictMode runs effects twice in development: the invitation
  // tokens are single-use, so the confirmation must be attempted once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const { hash, search, pathname } = window.location;

    // Scrub the fragment/query FIRST: history must not keep the tokens and
    // no later request in this page lifetime carries them in the URL.
    try {
      window.history.replaceState(null, '', pathname);
    } catch {
      // History API unavailable: tokens still only live in these locals.
    }

    const parsed = parseInviteLink(hash, search);
    if (parsed.kind === 'invalid') {
      setState('invalid-link');
      return;
    }

    const input =
      parsed.kind === 'session'
        ? {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
          }
        : { tokenHash: parsed.tokenHash };

    void confirmCmsInvite(input)
      .then((result) => {
        // A resolved result is always a typed status; success navigation is a
        // NEXT_REDIRECT rejection handled below.
        setState(result.status);
      })
      .catch((error: unknown) => {
        if (isRedirectError(error)) return;
        setState('failed');
      });
  }, []);

  const errorMessage = state === 'working' ? null : t(ERROR_KEYS[state]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md md:rounded-2xl md:border md:border-border-subtle md:bg-surface-card md:px-10 md:py-10">
        <div className="flex flex-col items-center text-center">
          <Fingerprint
            size={56}
            className="text-accent-violet"
            aria-hidden="true"
          />
          <h1 className="mt-4 text-2xl font-bold text-text-white">
            {t('onboarding.confirmTitle')}
          </h1>

          {state === 'working' ? (
            <div className="mt-6 flex flex-col items-center">
              <Loader2
                className="h-6 w-6 animate-spin text-accent-violet"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm text-text-muted">
                {t('onboarding.confirming')}
              </p>
            </div>
          ) : (
            <div className="mt-6 w-full">
              <ErrorBanner message={errorMessage} />
              <Link
                href="/login"
                className={`${editorSecondaryButtonClass} mt-4 w-full`}
              >
                {t('onboarding.backToLogin')}
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

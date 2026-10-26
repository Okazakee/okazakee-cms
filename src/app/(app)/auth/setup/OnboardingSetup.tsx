'use client';

import { Check, Fingerprint, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  editorPrimaryButtonClass,
  editorSecondaryButtonClass,
} from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { createClient } from '@/utils/supabase/client';

/**
 * Invitee setup: enroll a passkey with the existing Supabase WebAuthn API.
 *
 * There is no password to set — invitation confirmation already established
 * the allowlisted session, and every future sign-in is a passkey ceremony or
 * GitHub OAuth. Nothing here grants additional authority.
 */

type PasskeyState = 'idle' | 'registering' | 'added';

export function OnboardingSetup() {
  const t = useTranslations('cms');
  // Offered only when this browser can run a WebAuthn registration ceremony
  // in this context. Capability check only — never a ceremony.
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyState, setPasskeyState] = useState<PasskeyState>('idle');
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    const navigatorRef = window.navigator;
    setPasskeySupported(
      window.isSecureContext === true &&
        typeof window.PublicKeyCredential !== 'undefined' &&
        !!navigatorRef.credentials &&
        typeof navigatorRef.credentials.create === 'function'
    );
  }, []);

  const handleAddPasskey = async () => {
    setErrorKey(null);
    setPasskeyState('registering');
    try {
      const { error } = await createClient().auth.registerPasskey();
      if (error) {
        setErrorKey('onboarding.passkeyFailed');
        setPasskeyState('idle');
        return;
      }
      setPasskeyState('added');
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError') {
        // The user dismissed the authenticator prompt: not a failure.
        setErrorKey('onboarding.passkeyCancelled');
      } else if (name === 'InvalidStateError') {
        setErrorKey('onboarding.passkeyExists');
      } else {
        setErrorKey('onboarding.passkeyFailed');
      }
      setPasskeyState('idle');
    }
  };

  const errorMessage = errorKey ? t(errorKey) : null;
  const busy = passkeyState === 'registering';

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg md:rounded-2xl md:border md:border-border-subtle md:bg-surface-card md:px-10 md:py-10">
        <div className="flex flex-col items-center text-center">
          <Fingerprint
            size={56}
            className="text-accent-violet"
            aria-hidden="true"
          />
          <h1 className="mt-4 text-2xl font-bold text-text-white">
            {t('onboarding.setupTitle')}
          </h1>
          <p className="mt-3 text-sm text-text-muted">
            {t('onboarding.setupSubtitle')}
          </p>
          <p className="mt-2 text-sm text-text-muted">
            {t('onboarding.setupSignInNote')}
          </p>

          {errorMessage && (
            <div className="mt-4 w-full">
              <ErrorBanner
                message={errorMessage}
                onDismiss={() => setErrorKey(null)}
              />
            </div>
          )}

          {passkeyState === 'added' ? (
            <p className="mt-6 flex items-center gap-2 text-sm font-medium text-accent-violet">
              <Check className="h-4 w-4" aria-hidden="true" />
              {t('onboarding.passkeyAdded')}
            </p>
          ) : (
            passkeySupported && (
              <button
                type="button"
                onClick={handleAddPasskey}
                disabled={busy}
                className={`${editorPrimaryButtonClass} mt-6 w-full`}
              >
                {busy ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Fingerprint className="h-4 w-4" aria-hidden="true" />
                )}
                {busy
                  ? t('onboarding.addingPasskey')
                  : t('onboarding.addPasskey')}
              </button>
            )
          )}

          {!passkeySupported && passkeyState !== 'added' && (
            <p className="mt-6 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-xs text-text-muted">
              {t('onboarding.passkeyUnsupported')}
            </p>
          )}

          <Link
            href="/"
            className={`${editorSecondaryButtonClass} mt-4 w-full`}
          >
            {t('onboarding.continueToDashboard')}
          </Link>
        </div>
      </div>
    </main>
  );
}

'use server';

import { redirect } from 'next/navigation';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { createClient } from '@/utils/supabase/server';
import {
  findAllowedCmsUser,
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
} from './utils/auth';
import { syncCmsUserProfile } from './utils/profileSync';

/**
 * Invitation confirmation Server Actions.
 *
 * Two inbound shapes, one authorization sequence:
 * - implicit flow: the standard Supabase invite email puts
 *   `access_token`/`refresh_token` in the URL fragment; the client page
 *   scrubs the fragment and posts the pair here (setSession).
 * - optional custom template: `?token_hash=...&type=invite`, consumed with
 *   verifyOtp({ type: 'invite' }) ONLY. Password/recovery/magic-link flows
 *   are not product scope and are never accepted.
 *
 * Every successful confirmation re-checks the CMS allowlist server-side,
 * signs unauthorized identities out, syncs the CMS profile and lets the
 * framework own navigation to the protected setup surface. Tokens and raw
 * provider errors never leave this boundary (results are status codes only).
 */

export type CmsInviteConfirmationInput =
  | { accessToken: string; refreshToken: string }
  | { tokenHash: string };

export type CmsInviteConfirmationResult =
  | { status: 'invalid-link' }
  | { status: 'unauthorized' }
  | { status: 'failed' };

const MAX_SESSION_TOKEN_LENGTH = 4096;
const MAX_TOKEN_HASH_LENGTH = 512;
const TOKEN_HASH_MIN_LENGTH = 16;
// Printable non-whitespace ASCII: both JWTs and GoTrue token hashes are
// opaque base64url/hex values. Anything else is a malformed link.
const PRINTABLE_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function isPlausibleSessionToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SESSION_TOKEN_LENGTH &&
    PRINTABLE_TOKEN_PATTERN.test(value)
  );
}

function isPlausibleTokenHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= TOKEN_HASH_MIN_LENGTH &&
    value.length <= MAX_TOKEN_HASH_LENGTH &&
    PRINTABLE_TOKEN_PATTERN.test(value)
  );
}

type ParsedConfirmation =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  | { kind: 'token-hash'; tokenHash: string };

/** Runtime validation: Server Action arguments are untrusted JSON. */
function parseConfirmationInput(input: unknown): ParsedConfirmation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  if ('tokenHash' in input && isPlausibleTokenHash(input.tokenHash)) {
    return { kind: 'token-hash', tokenHash: input.tokenHash };
  }

  if (
    'accessToken' in input &&
    'refreshToken' in input &&
    isPlausibleSessionToken(input.accessToken) &&
    isPlausibleSessionToken(input.refreshToken)
  ) {
    return {
      kind: 'session',
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
    };
  }

  return null;
}

/**
 * Establishes the session, enforces the allowlist and syncs the profile.
 * Returns null only when the caller may proceed (redirect); every other
 * path returns a status code.
 */
async function establishAuthorizedCmsSession(
  input: unknown
): Promise<CmsInviteConfirmationResult | null> {
  const parsed = parseConfirmationInput(input);
  if (!parsed) return { status: 'invalid-link' };

  // Once the invite handshake stores a session, EVERY non-redirect exit must
  // leave no session behind — otherwise a failed onboarding still authenticates
  // the request. `clearSession` stays unavailable until a client exists.
  let sessionEstablished = false;
  let signOutEstablishedSession: (() => Promise<void>) | null = null;

  try {
    const supabase = await createClient();

    const clearSession = async () => {
      try {
        await supabase.auth.signOut();
      } catch {
        // Best-effort: clearing must never mask the outcome we return.
      }
    };
    signOutEstablishedSession = clearSession;

    if (parsed.kind === 'token-hash') {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: parsed.tokenHash,
        type: 'invite',
      });
      if (error || !(data.session?.user ?? data.user)) {
        return { status: 'invalid-link' };
      }
      sessionEstablished = true;
    } else {
      // Implicit invite fragment: the tokens are the invitation. Reject an
      // expired/reused pair without keeping anything in the cookie jar.
      const { error } = await supabase.auth.setSession({
        access_token: parsed.accessToken,
        refresh_token: parsed.refreshToken,
      });
      if (error) return { status: 'invalid-link' };
      sessionEstablished = true;
    }

    // Re-read through the server client: the session must be valid for THIS
    // request boundary before any authorization decision.
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      await clearSession();
      return { status: 'invalid-link' };
    }

    const allowlistMatch = await findAllowedCmsUser(getCmsAdminClient(), {
      email: getVerifiedUserEmail(user),
      githubUserId: getUserGithubId(user),
      githubUsernameLegacy: getUserGithubUsername(user),
    });

    if (!allowlistMatch) {
      // Denied identity: clear the freshly established session immediately.
      await clearSession();
      return { status: 'unauthorized' };
    }

    await syncCmsUserProfile(user);
    return null;
  } catch {
    // A profile/allowlist/session-read exception after the handshake would
    // otherwise leave a live session on a failed onboarding.
    if (sessionEstablished && signOutEstablishedSession) {
      await signOutEstablishedSession();
    }
    // Never surface token/provider detail; the client maps this to fixed UI.
    return { status: 'failed' };
  }
}

/**
 * Confirms an invitation link. On success the action redirects to the
 * protected setup surface (the framework owns the navigation; the client
 * treats NEXT_REDIRECT as control flow). Failures return status codes.
 */
export async function confirmCmsInvite(
  input: CmsInviteConfirmationInput
): Promise<CmsInviteConfirmationResult> {
  const failure = await establishAuthorizedCmsSession(input);
  if (failure) return failure;

  redirect('/auth/setup');
}

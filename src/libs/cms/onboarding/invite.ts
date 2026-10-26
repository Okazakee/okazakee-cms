import { cmsConfig } from '@/config/cms';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

/**
 * Supabase email-invitation helper (server-only).
 *
 * The caller owns the whole administrative decision: it validates the email
 * and role, checks the actor's permission, inserts the `cms_allowed_users`
 * row and persists `invited_at` when this helper reports `'sent'`. This module
 * only asks Supabase Auth to send the invitation email and classifies the
 * outcome — it never writes allowlist/profile rows and never deletes a shared
 * Auth identity (the CMS shares its Auth users with the public site).
 */

export type CmsInvitationStatus = 'sent' | 'existing-account' | 'failed';

export interface CmsInvitationResult {
  status: CmsInvitationStatus;
  /** Fixed, user-safe sentence. Never a raw provider/Supabase message. */
  error?: string;
  /** ISO timestamp for the caller to persist. Only present when 'sent'. */
  invitedAt?: string;
}

/** Exact public route that consumes the invite redirect (fragment/OTP). */
export const CMS_INVITE_CONFIRM_PATH = '/auth/confirm';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const invalidEmailError = 'Please enter a valid email address';
const missingOriginError = 'CMS_PUBLIC_URL is not configured correctly';
const sendFailedError = 'Failed to send the invitation email';

function isValidInviteEmail(email: unknown): email is string {
  return (
    typeof email === 'string' &&
    email.length > 0 &&
    email.length <= MAX_EMAIL_LENGTH &&
    EMAIL_REGEX.test(email)
  );
}

/**
 * Canonical CMS origin for invitation links. `CMS_PUBLIC_URL` is the single
 * trusted value: the redirect must not be rebuilt from forwarded request
 * headers. Returns null when the value is missing/malformed so the caller
 * fails clearly instead of sending a link to an untrusted host.
 */
export function getCanonicalCmsOrigin(): string | null {
  const raw = cmsConfig.cmsPublicUrl.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Credentials, query, fragment or a path would silently change the link
  // target: the CMS is served from the configured origin root only.
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;

  return url.origin;
}

export function buildCmsInviteRedirectTo(origin: string): string {
  return `${origin}${CMS_INVITE_CONFIRM_PATH}`;
}

/**
 * An existing Auth account is an explicit outcome, never a fake success:
 * GoTrue rejects admin invitations for a known address with `email_exists`
 * (older deployments only return the equivalent message).
 */
export function isExistingAccountInviteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === 'email_exists') return true;
  if (!('message' in error) || typeof error.message !== 'string') return false;
  const normalized = error.message.toLowerCase();
  return (
    normalized.includes('already been registered') ||
    normalized.includes('already registered') ||
    normalized.includes('user already exists')
  );
}

/**
 * Sends the Supabase invitation email to an already-authorized email address.
 *
 * Never throws: every failure maps to `'failed'` with a fixed message, and an
 * existing Auth account maps to `'existing-account'` so the caller can tell
 * the operator to use the existing sign-in method.
 */
export async function sendCmsInvitation(
  email: string
): Promise<CmsInvitationResult> {
  const normalizedEmail =
    typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!isValidInviteEmail(normalizedEmail)) {
    return { status: 'failed', error: invalidEmailError };
  }

  const origin = getCanonicalCmsOrigin();
  if (!origin) {
    return { status: 'failed', error: missingOriginError };
  }

  try {
    const { data, error } =
      await getCmsAdminClient().auth.admin.inviteUserByEmail(normalizedEmail, {
        redirectTo: buildCmsInviteRedirectTo(origin),
      });

    if (error) {
      if (isExistingAccountInviteError(error)) {
        return { status: 'existing-account' };
      }
      return { status: 'failed', error: sendFailedError };
    }

    return {
      status: 'sent',
      invitedAt: data.user?.invited_at ?? new Date().toISOString(),
    };
  } catch {
    // Provider/network failure: no raw message (and never a token) escapes.
    return { status: 'failed', error: sendFailedError };
  }
}

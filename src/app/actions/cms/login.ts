'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { findAllowedCmsUser, getUserGithubUsername } from './utils/auth';
import { syncCmsUserProfile } from './utils/profileSync';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { defaultLocale, isValidLocale } from '@/i18n/routing';
import {
  checkLoginRateLimitDurable,
  clearLoginRateLimitDurable,
  getLoginRateIdentifiers,
} from '@/libs/cms/loginRateLimit';
import { createClient } from '@/utils/supabase/server';

// Email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email + Password login.
 *
 * On success the action performs the navigation itself via redirect() —
 * framework-owned, single deterministic path. The client never navigates on
 * the password success path (see src/app/actions/cms/login.test.ts).
 */
export async function login(email: string, password: string, locale: string) {
  // Input validation
  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return { error: 'Please enter a valid email address' };
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    return { error: 'Password must be at least 8 characters' };
  }

  // Get client IP for rate limiting
  const headersList = await headers();
  const forwardedFor = headersList.get('x-forwarded-for');
  const realIp = headersList.get('x-real-ip');
  const clientIp = forwardedFor?.split(',')[0]?.trim() || realIp || 'unknown';

  const supabase = await createClient();

  // Rate limit by BOTH IP and email using two independent durable
  // Postgres-backed buckets (identifiers stored as hashes, never raw
  // email/IP). Rotating emails against one IP or IPs against one account
  // cannot bypass the limiter. The RPC is invoked with the service-role
  // client: execution is revoked from anon/authenticated
  // (migration 20260818090000_harden_login_rate_limit.sql).
  const { ipHash, emailHash } = getLoginRateIdentifiers(clientIp, email);
  const rateLimit = await checkLoginRateLimitDurable(
    getCmsAdminClient(),
    ipHash,
    emailHash
  );

  if (!rateLimit.allowed) {
    const minutes = Math.ceil((rateLimit.lockoutRemaining || 0) / 60);
    return {
      error: `Too many login attempts. Please try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`,
    };
  }

  // Check allowlist BEFORE attempting login
  const allowlistCheck = await findAllowedCmsUser(supabase, email);
  if (!allowlistCheck) {
    return { error: 'Access denied. Please contact the administrator.' };
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    return { error: 'Invalid email or password' };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const postLoginAllowlist = await findAllowedCmsUser(
    supabase,
    user?.email,
    user ? getUserGithubUsername(user) : null
  );

  if (!user || !postLoginAllowlist) {
    await supabase.auth.signOut();
    return { error: 'Access denied. Please contact the administrator.' };
  }

  // Successful login: reset both rate-limit buckets so the account and IP
  // are not left penalized by earlier failures. Best-effort.
  await clearLoginRateLimitDurable(getCmsAdminClient(), ipHash, emailHash);

  // Finalize the CMS profile (what /auth/ready used to do for this flow):
  // the dashboard boot needs it and recreates it lazily anyway. Best-effort:
  // a sync failure must not block an otherwise-successful login.
  try {
    await syncCmsUserProfile(user);
  } catch (error) {
    console.error('Error syncing CMS profile after login:', error);
  }

  // Framework-owned navigation: redirect() throws NEXT_REDIRECT, the client's
  // awaited promise rejects with it and the framework performs the
  // navigation. No client-side navigation and no router refresh on the
  // success path — a single deterministic transition (previously the action
  // returned redirectTo and the client raced a hard navigation against the
  // action's RSC lifecycle, causing a transient load error in Firefox).
  const safeLocale = isValidLocale(locale) ? locale : defaultLocale;
  redirect(`/${safeLocale}`);
}

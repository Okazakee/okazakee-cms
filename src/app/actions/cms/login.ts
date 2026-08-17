'use server';

import { refresh } from 'next/cache';
import { headers } from 'next/headers';
import { findAllowedCmsUser, getUserGithubUsername } from './utils/auth';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import {
  checkLoginRateLimitDurable,
  normalizeLoginRateIdentifier,
} from '@/libs/cms/loginRateLimit';
import { createClient } from '@/utils/supabase/server';

// Email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email + Password login
 */
export async function login(email: string, password: string) {
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

  // Rate limit by both IP and email (durable Postgres-backed limiter;
  // identifiers stored as hashes, never raw email/IP). The RPC is invoked
  // with the service-role client: migration 20260818090000_harden_login_rate_limit.sql
  // revokes cms_check_login_rate execution from anon/authenticated, so the
  // browser-facing (publishable-key) client can no longer call it.
  const rateLimitKey = `login:${clientIp}:${email.toLowerCase()}`;
  const rateLimit = await checkLoginRateLimitDurable(
    getCmsAdminClient(),
    normalizeLoginRateIdentifier(rateLimitKey)
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

  refresh();
  return { success: true, redirectTo: '/auth/ready?next=/' };
}

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Durable login rate limiter backed by Supabase/Postgres.
 *
 * Requires the migrations in supabase/migrations/:
 * - 20260817100000_cms_login_rate_limit.sql (table);
 * - 20260818090000_harden_login_rate_limit.sql (grants, RLS, scheduled purge);
 * - 20260818100000_login_rate_limit_split_buckets.sql (per-IP + per-email
 *   buckets, clear-on-success).
 *
 * The RPCs are invoked with the service-role client (getCmsAdminClient) —
 * execution is revoked from anon/authenticated. The legacy single-identifier
 * cms_check_login_rate(text) was removed by
 * 20260818110000_remove_legacy_login_rate_rpc.sql once the split-bucket CMS
 * was live.
 *
 * Policy: two independent buckets per attempt — per-IP and per-email — each
 * 5 failures / minute with a 15-minute lockout. An attempt is allowed only
 * when both buckets allow it, so rotating emails against one IP (or IPs
 * against one account) cannot bypass the limiter. A successful login resets
 * both buckets.
 */

export type LoginRateResult = {
  allowed: boolean;
  remainingAttempts: number;
  lockoutRemaining?: number;
};

/**
 * Hashes a raw limiter key so raw values are never persisted.
 */
export function normalizeLoginRateIdentifier(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Derives the two per-identifier bucket hashes for a login attempt.
 *
 * Distinct prefixes keep the IP and email buckets separate even though both
 * are sha256 hashes; the raw IP and normalized email are never persisted.
 */
export function getLoginRateIdentifiers(ip: string, email: string): {
  ipHash: string;
  emailHash: string;
} {
  return {
    ipHash: normalizeLoginRateIdentifier(`loginIp:${ip}`),
    emailHash: normalizeLoginRateIdentifier(
      `loginEmail:${email.trim().toLowerCase()}`
    ),
  };
}

export async function checkLoginRateLimitDurable(
  supabase: Pick<SupabaseClient, 'rpc'>,
  ipHash: string,
  emailHash: string
): Promise<LoginRateResult> {
  const { data, error } = await supabase.rpc('cms_check_login_rate', {
    p_ip: ipHash,
    p_email: emailHash,
  });

  if (error) {
    console.error('Login rate limit check failed:', error);
    throw error;
  }

  const parsed = data as {
    allowed: boolean;
    remaining_attempts: number;
    lockout_remaining: number;
  };

  return {
    allowed: parsed.allowed,
    remainingAttempts: parsed.remaining_attempts,
    lockoutRemaining:
      parsed.lockout_remaining > 0 ? parsed.lockout_remaining : undefined,
  };
}

/**
 * Resets both buckets after a successful login so the legitimate user is
 * never left penalized. Best-effort: a reset failure must not fail the login.
 */
export async function clearLoginRateLimitDurable(
  supabase: Pick<SupabaseClient, 'rpc'>,
  ipHash: string,
  emailHash: string
): Promise<void> {
  const { error } = await supabase.rpc('cms_clear_login_rate', {
    p_ip: ipHash,
    p_email: emailHash,
  });

  if (error) {
    console.error('Login rate limit reset failed:', error);
  }
}

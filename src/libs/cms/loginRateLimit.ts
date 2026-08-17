import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Durable login rate limiter backed by Supabase/Postgres.
 *
 * Requires the migrations in supabase/migrations/:
 * - 20260817100000_cms_login_rate_limit.sql (table + RPCs);
 * - 20260818090000_harden_login_rate_limit.sql (grants, RLS, scheduled purge).
 *
 * The RPC is invoked with the service-role client (getCmsAdminClient) — RPC
 * execution is revoked from anon/authenticated.
 *
 * Policy: 5 attempts / minute per identifier, 15-minute lockout.
 */

export type LoginRateResult = {
  allowed: boolean;
  remainingAttempts: number;
  lockoutRemaining?: number;
};

/**
 * Normalizes the raw limiter key (ip + email) into a hash so raw values are
 * never persisted.
 */
export function normalizeLoginRateIdentifier(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function checkLoginRateLimitDurable(
  supabase: Pick<SupabaseClient, 'rpc'>,
  identifier: string
): Promise<LoginRateResult> {
  const { data, error } = await supabase.rpc('cms_check_login_rate', {
    p_identifier: identifier,
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

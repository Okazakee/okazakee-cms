/**
 * Environment-derived application config shared by public and CMS code.
 *
 * Provider metadata (e.g. VERCEL_ENV) must NOT define application semantics.
 * `APP_ENV` is the explicit application environment:
 *   - unset      -> falls back to NODE_ENV (development/production)
 *   - production -> production semantics (long cache, publish-date enforcement)
 *   - staging    -> preview semantics (short cache, future posts visible)
 */

export const appEnv =
  process.env.APP_ENV ??
  (process.env.NODE_ENV === 'production' ? 'production' : 'development');

export const isProductionEnv = appEnv === 'production';

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
// Publishable API key (sb_publishable_...) — safe for public code. Falls back
// to the legacy anon key while the migration is in progress.
export const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  '';
// Server-only secret API key (sb_secret_...) — NEVER in public code. Falls
// back to the legacy service_role key until the migration is complete.
export const supabaseServerSecret =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

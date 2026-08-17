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
export const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Canonical CMS Storage bucket selector (server-only; never import from
 * client components).
 *
 * Selection (read lazily per call so tests can stub env before invoking
 * actions; semantics match src/config/shared.ts):
 * - `APP_ENV=production` + schema `public` -> `website` (prod).
 * - any other schema pairing -> `website-dev`.
 *
 * Fail-closed: a non-production environment still pointed at the `public`
 * schema of a real (non-loopback) project throws before any upload/remove
 * instead of touching prod. Empty/unconfigured and loopback URLs are safe
 * local/test targets and resolve to `website-dev` without throwing.
 */

export const CMS_PROD_STORAGE_BUCKET = 'website';
export const CMS_DEV_STORAGE_BUCKET = 'website-dev';

function readAppEnv(): string {
  return (
    process.env.APP_ENV ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development')
  );
}

function readSchema(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? 'public';
}

function readSupabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export function getCmsStorageBucket(): string {
  if (readAppEnv() === 'production' && readSchema() === 'public') {
    return CMS_PROD_STORAGE_BUCKET;
  }
  const url = readSupabaseUrl();
  if (readSchema() === 'public' && url !== '' && !isLoopbackUrl(url)) {
    throw new Error(
      "[cms-storage] refusing to write: non-production env must not use schema 'public' against a non-loopback project (would touch prod)"
    );
  }
  return CMS_DEV_STORAGE_BUCKET;
}

/**
 * Configured Supabase origin (scheme + host + port) that public Storage
 * URLs must belong to before a cleanup delete is allowed. Read lazily so
 * test env setup applies at call time.
 */
export function getCmsStorageOrigin(): string {
  const raw = readSupabaseUrl();
  if (!raw) throw new Error('[cms-storage] missing Supabase URL');
  return new URL(raw).origin;
}

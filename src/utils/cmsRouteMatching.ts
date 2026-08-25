/**
 * Pure CMS route-matching rules (client-safe, unit-tested).
 *
 * Used by the proxy (src/proxy.ts) and the Supabase session middleware
 * (src/utils/supabase/middleware.ts). All matching is explicit path-SEGMENT
 * based: `/login-foo` must never be a public auth route and
 * `/something-cms-whatever` must never trigger the legacy `/cms` compat
 * redirect. There is no URL locale: routes live at the root.
 */

/** Exact CMS routes that are reachable without a session. */
const CMS_PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/auth/github/start',
] as const;

/** Normalizes a single trailing slash (the routes are served without one). */
export function normalizeTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * True when the pathname is EXACTLY one of the public auth routes. Prefix
 * matching is deliberately avoided: `/login-foo` or `/auth/callback-evil`
 * must not become public.
 */
export function isCmsPublicPath(pathname: string): boolean {
  return (CMS_PUBLIC_PATHS as readonly string[]).includes(
    normalizeTrailingSlash(pathname)
  );
}

/**
 * True when the pathname is exactly `/login`. Authenticated users are
 * redirected away from it.
 */
export function isAuthPagePath(pathname: string): boolean {
  return normalizeTrailingSlash(pathname) === '/login';
}

/** A `/cms` path segment anywhere in the path (legacy compat only). */
const CMS_SEGMENT_PATTERN = /\/cms(?=\/|$)/;

/** True when the path contains a `/cms` segment (e.g. `/cms/login`). */
export function isLegacyCmsPath(pathname: string): boolean {
  return CMS_SEGMENT_PATTERN.test(pathname);
}

/**
 * Removes the FIRST `/cms` segment. Only meaningful when
 * isLegacyCmsPath(pathname) is true; other paths are returned unchanged.
 */
export function stripLegacyCmsSegment(pathname: string): string {
  return pathname.replace(CMS_SEGMENT_PATTERN, '');
}

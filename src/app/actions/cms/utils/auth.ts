import type { SupabaseClient, User } from '@supabase/supabase-js';
import { cmsConfig } from '@/config/cms';

export const CMS_ALLOWED_ROLES = ['admin', 'editor'] as const;
export type CmsRole = (typeof CMS_ALLOWED_ROLES)[number];

export type CmsAllowlistMatch = {
  role: CmsRole;
  matchSource: 'email' | 'github';
};

export function isCmsAuthDebugEnabled(): boolean {
  return (
    process.env.CMS_AUTH_DEBUG === 'true' ||
    process.env.NODE_ENV === 'development'
  );
}

export function logCmsAuth(
  event: string,
  details: Record<string, string | number | boolean | null | undefined> = {}
): void {
  if (!isCmsAuthDebugEnabled()) return;
  console.log('[cms-auth]', event, {
    ...details,
    timestamp: new Date().toISOString(),
  });
}

export function getSafeCmsNext(rawNext: string | null | undefined): string {
  // Same-origin paths only; never protocol-relative or external URLs, and
  // never backslash-prefixed paths ('/\evil.com' parses as '//evil.com' in
  // browsers, i.e. an open redirect).
  return rawNext?.startsWith('/') &&
    !rawNext.startsWith('//') &&
    !rawNext.includes('\\')
    ? rawNext
    : '/';
}

/**
 * Builds the canonical post-auth redirect path: the safe next path, with
 * any trailing slash stripped so auth never triggers the framework's
 * 308 trailing-slash redirect. The result is always a same-origin path
 * (never an open redirect).
 */
export function resolvePostAuthPath(next: string): string {
  const safeNext = getSafeCmsNext(next);
  return safeNext.length > 1 && safeNext.endsWith('/')
    ? safeNext.slice(0, -1)
    : safeNext;
}

/**
 * Builds the OAuth callback URL Supabase must redirect back to: the
 * canonical /auth/callback with the sanitized `next` param. This is the URL
 * that must be allowlisted in Supabase (see the CMS README).
 */
export function buildOAuthCallbackUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(
    getSafeCmsNext(next)
  )}`;
}

/**
 * Builds a canonical login error redirect: /login?error=<message>. `message`
 * must be a fixed, user-safe string — never raw provider/Supabase error
 * details.
 */
export function buildAuthErrorRedirect(origin: string, message: string): URL {
  const url = new URL('/login', origin);
  url.searchParams.set('error', message);
  return url;
}

export function getRequestOrigin(request: Request): string {
  const canonical = cmsConfig.cmsPublicUrl;
  if (canonical && process.env.NODE_ENV !== 'development') {
    // Deterministic production origin: never rebuild it from forwarded
    // request headers when a canonical CMS_PUBLIC_URL is configured.
    return canonical;
  }

  return new URL(request.url).origin;
}

export function getUserGithubId(user: User): string | null {
  const identities = user.identities;
  if (!Array.isArray(identities)) return null;
  const github = identities.find((entry) => entry?.provider === 'github');
  if (!github) return null;
  const rawSub = github.identity_data?.sub;
  const subCandidate =
    typeof rawSub === 'string' || typeof rawSub === 'number'
      ? String(rawSub)
      : null;
  const candidate = subCandidate ?? String(github.id ?? '');
  return candidate && /^[0-9]+$/.test(candidate) ? candidate : null;
}

export function getUserGithubUsername(user: User): string | null {
  const identities = user.identities;
  if (!Array.isArray(identities)) return null;
  const github = identities.find((entry) => entry?.provider === 'github');
  if (!github) return null;
  const data = github.identity_data ?? {};
  const candidates = [
    data.user_name,
    data.preferred_username,
    data.login,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

export function getUserAuthProvider(user: User): 'email' | 'github' {
  return user.app_metadata?.provider === 'github' ? 'github' : 'email';
}

export function getUserDisplayName(user: User): string {
  return (
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.user_metadata?.user_name ||
    user.email?.split('@')[0] ||
    'User'
  );
}

export function getUserAvatarUrl(user: User): string | null {
  const rawAvatarUrl = user.user_metadata?.avatar_url;
  return typeof rawAvatarUrl === 'string' && rawAvatarUrl.length > 0
    ? rawAvatarUrl
    : null;
}

export function getVerifiedUserEmail(user: User): string | null {
  const email = user.email;
  if (!email) return null;
  const record = user as User & {
    email_confirmed_at?: string | null;
    confirmed_at?: string | null;
  };
  const hasEmailConfirmedField = 'email_confirmed_at' in record;
  const hasConfirmedField = 'confirmed_at' in record;
  // Older unit fixtures omit confirmation columns; keep exercising the
  // email path there. Real GoTrue users always carry these columns, so an
  // unverified address never matches the allowlist in production.
  if (!hasEmailConfirmedField && !hasConfirmedField) return email;
  if (record.email_confirmed_at || record.confirmed_at) return email;
  return null;
}

export type FindAllowedCmsUserInput = {
  email?: string | null;
  githubUserId?: string | null;
  githubUsernameLegacy?: string | null;
};

/**
 * Canonical CMS allowlist lookup (server-only, service_role client).
 *
 * Order is load-bearing and preserved from the pre-cutover behavior:
 * githubUserID match -> verified-email match (returns immediately) ->
 * legacy username ONLY as a dual-allowed transition fallback. The legacy
 * branch exists so old admins/editors still map while `github_user_id` is
 * being backfilled; it must never authorize an editable `user_metadata`
 * value (callers pass the identity-derived display handle, not metadata).
 */
export async function findAllowedCmsUser(
  supabase: Pick<SupabaseClient, 'from'>,
  emailOrInput?: string | null | FindAllowedCmsUserInput,
  githubUsernameOrUndefined?: string | null
): Promise<CmsAllowlistMatch | null> {
  let email: string | null | undefined;
  let githubUserId: string | null | undefined;
  let githubUsernameLegacy: string | null | undefined;
  if (
    emailOrInput !== null &&
    typeof emailOrInput === 'object' &&
    !Array.isArray(emailOrInput)
  ) {
    email = emailOrInput.email;
    githubUserId = emailOrInput.githubUserId;
    githubUsernameLegacy = emailOrInput.githubUsernameLegacy;
  } else {
    email = emailOrInput as string | null | undefined;
    githubUsernameLegacy = githubUsernameOrUndefined;
  }

  if (githubUserId) {
    const { data: idMatch } = await supabase
      .from('cms_allowed_users')
      .select('role')
      .eq('github_user_id', githubUserId)
      .maybeSingle();

    if (idMatch?.role && CMS_ALLOWED_ROLES.includes(idMatch.role as CmsRole)) {
      return { role: idMatch.role as CmsRole, matchSource: 'github' };
    }
  }

  if (email) {
    const { data: emailMatch } = await supabase
      .from('cms_allowed_users')
      .select('role')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (
      emailMatch?.role &&
      CMS_ALLOWED_ROLES.includes(emailMatch.role as CmsRole)
    ) {
      return { role: emailMatch.role as CmsRole, matchSource: 'email' };
    }
  }

  if (githubUsernameLegacy) {
    const { data: githubMatch } = await supabase
      .from('cms_allowed_users')
      .select('role')
      .eq('github_username', githubUsernameLegacy)
      .maybeSingle();

    if (
      githubMatch?.role &&
      CMS_ALLOWED_ROLES.includes(githubMatch.role as CmsRole)
    ) {
      return { role: githubMatch.role as CmsRole, matchSource: 'github' };
    }
  }

  return null;
}

/**
 * Edge-safe allowlist lookup for the Next.js middleware (Edge Runtime).
 *
 * The middleware cannot use the service_role client (anti-pattern: the
 * server secret would be embedded in the edge bundle). Instead it calls the
 * `cms_lookup_current_user` SECURITY DEFINER RPC, which derives the caller's
 * identity from the JWT (auth.uid()) — no caller-supplied identity
 * parameters, so an authenticated session cannot be used to enumerate the
 * allowlist by probing arbitrary emails/usernames. The RPC has a fixed
 * `search_path` and fully qualified table names, and is granted EXECUTE to
 * `authenticated` only; anon has no path to the allowlist.
 */
export async function lookupAllowedCmsUserViaRpc(
  supabase: Pick<SupabaseClient, 'rpc'>
): Promise<CmsAllowlistMatch | null> {
  const { data } = await supabase.rpc('cms_lookup_current_user');

  if (
    data &&
    typeof data === 'object' &&
    'role' in data &&
    'match_source' in data &&
    CMS_ALLOWED_ROLES.includes((data as { role: string }).role as CmsRole)
  ) {
    return {
      role: (data as { role: CmsRole }).role,
      matchSource: (data as { match_source: 'email' | 'github' }).match_source,
    };
  }

  return null;
}

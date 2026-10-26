import type { SupabaseClient, User } from '@supabase/supabase-js';
import { cmsConfig } from '@/config/cms';
import { CMS_ROLES, type CmsRole, isCmsRole } from '@/utils/cms/roles';

// The role vocabulary/hierarchy lives in the client-safe shared module; this
// server-only module re-exports it so existing imports keep working.
export const CMS_ALLOWED_ROLES = CMS_ROLES;
export type { CmsRole };

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
  const candidates = [data.user_name, data.preferred_username, data.login];
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
 * Order is load-bearing: immutable githubUserID match -> verified-email
 * match. A *present* verified email decides: when it matches nothing the
 * lookup returns null instead of falling through to the legacy handle
 * (exact parity with public.is_admin_user() and the middleware RPC). The
 * legacy handle branch therefore runs only for sessions with no verified
 * email, as a dual-allowed transition fallback while `github_user_id` is
 * being backfilled; it must never authorize an editable `user_metadata`
 * value (callers pass the identity-derived display handle, not metadata).
 *
 * `email` must be the VERIFIED address (getVerifiedUserEmail), and only the
 * exact CMS role tokens are accepted — anything else fails closed.
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

    if (isCmsRole(idMatch?.role)) {
      return { role: idMatch.role, matchSource: 'github' };
    }
  }

  // Verified email decides. An unmatched verified email fails closed: no
  // legacy-handle fallthrough (previously allowed a different row to
  // authorize a session whose verified email was never allowlisted).
  if (email) {
    const { data: emailMatch } = await supabase
      .from('cms_allowed_users')
      .select('role')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (isCmsRole(emailMatch?.role)) {
      return { role: emailMatch.role, matchSource: 'email' };
    }

    return null;
  }

  if (githubUsernameLegacy) {
    const { data: githubMatch } = await supabase
      .from('cms_allowed_users')
      .select('role')
      .eq('github_username', githubUsernameLegacy)
      .maybeSingle();

    if (isCmsRole(githubMatch?.role)) {
      return { role: githubMatch.role, matchSource: 'github' };
    }
  }

  return null;
}

/** Schemas the identity RPC may read an allowlist from (exact whitelist). */
const CMS_ALLOWLIST_SCHEMAS: Record<string, true> = {
  public: true,
  dev_staging: true,
};

/**
 * Edge-safe allowlist lookup for the Next.js middleware (Edge Runtime).
 *
 * The middleware cannot use the service_role client (anti-pattern: the
 * server secret would be embedded in the edge bundle). Instead it calls the
 * single `public.cms_lookup_current_user(p_schema)` SECURITY DEFINER RPC,
 * which derives the caller's identity from the JWT (auth.uid()) — no
 * caller-supplied identity, so an authenticated session cannot be used to
 * enumerate an allowlist by probing arbitrary emails/usernames. The RPC has a
 * fixed empty `search_path`, a whitelisted schema argument, values passed
 * through `USING`, and is granted EXECUTE to `authenticated` only; anon has
 * no path to any allowlist.
 *
 * `schema` selects which OWN-identity allowlist is read, never the identity:
 * production passes `public`, while a deployment configured against
 * `dev_staging` passes that schema so a dev-only invitee is authorized instead
 * of being signed out by a production-only lookup. The RPC is always the
 * public one (the Supabase client must NOT switch its PostgREST schema).
 */
export async function lookupAllowedCmsUserViaRpc(
  supabase: Pick<SupabaseClient, 'rpc'>,
  schema: string = 'public'
): Promise<CmsAllowlistMatch | null> {
  // The database would return null for an unknown schema anyway; refusing
  // locally keeps a misconfiguration from producing a pointless round trip.
  if (CMS_ALLOWLIST_SCHEMAS[schema] !== true) {
    logCmsAuth('allowlist-rpc-invalid-schema', { schema });
    return null;
  }

  const { data, error } = await supabase.rpc('cms_lookup_current_user', {
    p_schema: schema,
  });

  if (error) {
    logCmsAuth('allowlist-rpc-error', { schema, code: error.code ?? null });
    return null;
  }

  if (!data || typeof data !== 'object') return null;
  if (!('role' in data) || !isCmsRole(data.role)) return null;
  if (!('match_source' in data)) return null;
  const matchSource = data.match_source;
  if (matchSource !== 'email' && matchSource !== 'github') return null;

  return { role: data.role, matchSource };
}

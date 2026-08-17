import { cmsConfig } from '@/config/cms';
import type { SupabaseClient, User } from '@supabase/supabase-js';

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
  // Same-origin paths only; never protocol-relative or external URLs.
  return rawNext?.startsWith('/') && !rawNext.startsWith('//')
    ? rawNext
    : '/';
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

export function getUserGithubUsername(user: User): string | null {
  return typeof user.user_metadata?.user_name === 'string'
    ? user.user_metadata.user_name
    : null;
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

export async function findAllowedCmsUser(
  supabase: Pick<SupabaseClient, 'from'>,
  email?: string | null,
  githubUsername?: string | null
): Promise<CmsAllowlistMatch | null> {
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

  if (githubUsername) {
    const { data: githubMatch } = await supabase
      .from('cms_allowed_users')
      .select('role')
      .eq('github_username', githubUsername)
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

import { NextResponse } from 'next/server';
import {
  buildAuthErrorRedirect,
  findAllowedCmsUser,
  getRequestOrigin,
  getSafeCmsNext,
  getUserGithubUsername,
  logCmsAuth,
  resolvePostAuthPath,
} from '@/app/actions/cms/utils/auth';
import { syncCmsUserProfile } from '@/app/actions/cms/utils/profileSync';
import { createClient } from '@/utils/supabase/server';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

/**
 * GitHub OAuth callback.
 *
 * Finalizes the whole flow in this one request boundary: exchanges the code
 * for a session (cookies are set on the redirect response), enforces the CMS
 * allowlist (signing out unauthorized identities), syncs the CMS profile and
 * redirects directly to the canonical /{locale} (or a validated same-origin
 * `next`) — no intermediate hop, no legacy /cms paths, no client-side
 * navigation. The password flow uses the same direct-redirect architecture.
 *
 * Failure paths always land on canonical /{locale}/login with a fixed,
 * user-safe message (never raw provider/Supabase error details).
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const code = searchParams.get('code');
  const next = getSafeCmsNext(searchParams.get('next'));
  const origin = getRequestOrigin(request);

  // Locale comes from the URL path; the start route always builds a
  // locale-prefixed callback URL.
  const pathname = requestUrl.pathname;
  const localeMatch = pathname.match(/^\/([a-z]{2})\//);
  const locale = localeMatch ? localeMatch[1] : 'en';

  if (code) {
    try {
      const supabase = await createClient();

      // Exchange the code for a session - this replaces any existing session.
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error && data.session) {
        // Use the user from the exchanged session directly, not getUser().
        const user = data.session.user;

        if (!user) {
          logCmsAuth('callback-missing-user', { locale });
          return NextResponse.redirect(
            buildAuthErrorRedirect(origin, locale, 'Authentication failed')
          );
        }

        // Enforce the allowlist by email OR GitHub username. Uses the
        // server-side admin client: anon/authenticated have no SELECT on
        // cms_allowed_users (the allowlist is internal data).
        const githubUsername = getUserGithubUsername(user);
        const allowlistMatch = await findAllowedCmsUser(
          getCmsAdminClient(),
          user.email,
          githubUsername
        );

        logCmsAuth('callback-exchanged', {
          locale,
          userId: user.id,
          allowed: Boolean(allowlistMatch),
          matchSource: allowlistMatch?.matchSource || null,
          role: allowlistMatch?.role || null,
        });

        if (!allowlistMatch) {
          // Explicitly clear the unauthorized session before redirecting.
          await supabase.auth.signOut();
          logCmsAuth('callback-unauthorized', {
            locale,
            userId: user.id,
            hasEmail: Boolean(user.email),
            hasGithubUsername: Boolean(githubUsername),
          });
          return NextResponse.redirect(
            buildAuthErrorRedirect(
              origin,
              locale,
              'Access denied. Please contact the administrator.'
            )
          );
        }

        await syncCmsUserProfile(user);

        logCmsAuth('callback-success', {
          locale,
          userId: user.id,
          role: allowlistMatch.role,
          matchSource: allowlistMatch.matchSource,
          next,
        });

        // Direct canonical redirect: /{locale} or a validated same-origin
        // `next`, no trailing slash, no intermediate hop.
        return NextResponse.redirect(
          new URL(resolvePostAuthPath(locale, next), origin)
        );
      }

      logCmsAuth('callback-exchange-failed', {
        locale,
        error: error?.message || 'Missing session',
      });
    } catch (err) {
      logCmsAuth('callback-error', {
        locale,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Missing, invalid, expired or reused OAuth code (or exchange failure):
  // safe generic message, canonical login.
  return NextResponse.redirect(
    buildAuthErrorRedirect(origin, locale, 'Authentication failed')
  );
}

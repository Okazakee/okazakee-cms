import { NextResponse } from 'next/server';
import {
  buildAuthErrorRedirect,
  findAllowedCmsUser,
  getRequestOrigin,
  getSafeCmsNext,
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
  logCmsAuth,
  resolvePostAuthPath,
} from '@/app/actions/cms/utils/auth';
import { syncCmsUserProfile } from '@/app/actions/cms/utils/profileSync';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { createClient } from '@/utils/supabase/server';

/**
 * GitHub OAuth callback.
 *
 * Finalizes the whole flow in this one request boundary: exchanges the code
 * for a session (cookies are set on the redirect response), enforces the CMS
 * allowlist (signing out unauthorized identities), syncs the CMS profile and
 * redirects directly to the canonical / (or a validated same-origin `next`)
 * — no intermediate hop, no legacy /cms paths, no client-side navigation.
 *
 * Failure paths always land on canonical /login with a fixed, user-safe
 * message (never raw provider/Supabase error details).
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const code = searchParams.get('code');
  const next = getSafeCmsNext(searchParams.get('next'));
  const origin = getRequestOrigin(request);

  if (code) {
    try {
      const supabase = await createClient();

      // Exchange the code for a session - this replaces any existing session.
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error && data.session) {
        // Use the user from the exchanged session directly, not getUser().
        const user = data.session.user;

        if (!user) {
          logCmsAuth('callback-missing-user', {});
          return NextResponse.redirect(
            buildAuthErrorRedirect(origin, 'Authentication failed')
          );
        }

        // Enforce the allowlist: immutable GitHub ID -> verified email
        // (returns immediately) -> legacy display handle (dual-allowed
        // transition). Uses the server-side admin client:
        // anon/authenticated have no SELECT on cms_allowed_users.
        const githubUserId = getUserGithubId(user);
        const githubUsername = getUserGithubUsername(user);
        const allowlistMatch = await findAllowedCmsUser(getCmsAdminClient(), {
          email: getVerifiedUserEmail(user),
          githubUserId,
          githubUsernameLegacy: githubUsername,
        });

        logCmsAuth('callback-exchanged', {
          userId: user.id,
          allowed: Boolean(allowlistMatch),
          matchSource: allowlistMatch?.matchSource || null,
          role: allowlistMatch?.role || null,
        });

        if (!allowlistMatch) {
          // Explicitly clear the unauthorized session before redirecting.
          await supabase.auth.signOut();
          logCmsAuth('callback-unauthorized', {
            userId: user.id,
            hasEmail: Boolean(user.email),
            hasGithubUsername: Boolean(githubUsername),
          });
          return NextResponse.redirect(
            buildAuthErrorRedirect(
              origin,
              'Access denied. Please contact the administrator.'
            )
          );
        }

        await syncCmsUserProfile(user);

        logCmsAuth('callback-success', {
          userId: user.id,
          role: allowlistMatch.role,
          matchSource: allowlistMatch.matchSource,
          next,
        });

        // Direct canonical redirect: / or a validated same-origin `next`,
        // no trailing slash, no intermediate hop.
        return NextResponse.redirect(
          new URL(resolvePostAuthPath(next), origin)
        );
      }

      logCmsAuth('callback-exchange-failed', {
        error: error?.message || 'Missing session',
      });
    } catch (err) {
      logCmsAuth('callback-error', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Missing, invalid, expired or reused OAuth code (or exchange failure):
  // safe generic message, canonical login.
  return NextResponse.redirect(
    buildAuthErrorRedirect(origin, 'Authentication failed')
  );
}

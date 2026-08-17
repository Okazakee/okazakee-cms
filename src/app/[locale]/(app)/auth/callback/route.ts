import { NextResponse } from 'next/server';
import {
  findAllowedCmsUser,
  getRequestOrigin,
  getSafeCmsNext,
  getUserGithubUsername,
  logCmsAuth,
} from '@/app/actions/cms/utils/auth';
import { syncCmsUserProfile } from '@/app/actions/cms/utils/profileSync';
import { createClient } from '@/utils/supabase/server';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const code = searchParams.get('code');
  const next = getSafeCmsNext(searchParams.get('next'));
  const origin = getRequestOrigin(request);

  // Extract locale from the URL path
  const pathname = requestUrl.pathname;
  const localeMatch = pathname.match(/^\/([a-z]{2})\//);
  const locale = localeMatch ? localeMatch[1] : 'en';

  if (code) {
    try {
      const supabase = await createClient();

      // Exchange the code for a session - this replaces any existing session
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error && data.session) {
        // Use the user from the exchanged session directly, not getUser()
        const user = data.session.user;

        if (!user) {
          logCmsAuth('callback-missing-user', { locale });
          const errorUrl = new URL(`/${locale}/login`, origin);
          errorUrl.searchParams.set('error', 'Authentication failed');
          return NextResponse.redirect(errorUrl);
        }

        // Check allowlist by email or GitHub username
        const githubUsername = getUserGithubUsername(user);
        const allowlistMatch = await findAllowedCmsUser(
          supabase,
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
          await supabase.auth.signOut();
          const errorUrl = new URL(`/${locale}/cms/login`, origin);
          errorUrl.searchParams.set(
            'error',
            'Access denied. Please contact the administrator.'
          );
          return NextResponse.redirect(errorUrl);
        }

        await syncCmsUserProfile(user);

        const readyUrl = new URL(`/${locale}/auth/ready`, origin);
        readyUrl.searchParams.set('next', next);
        return NextResponse.redirect(readyUrl);
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

  // Auth code error, redirect to login with error
  const errorUrl = new URL(`/${locale}/cms/login`, origin);
  errorUrl.searchParams.set('error', 'Authentication failed');
  return NextResponse.redirect(errorUrl);
}

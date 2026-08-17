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
  const pathname = requestUrl.pathname;
  const localeMatch = pathname.match(/^\/([a-z]{2})\//);
  const locale = localeMatch?.[1] || 'en';
  const next = getSafeCmsNext(requestUrl.searchParams.get('next'));
  const origin = getRequestOrigin(request);

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      logCmsAuth('ready-unauthenticated', {
        locale,
        error: error?.message || null,
      });
      const loginUrl = new URL(`/${locale}/login`, origin);
      loginUrl.searchParams.set('error', 'Authentication not ready yet. Please try again.');
      return NextResponse.redirect(loginUrl);
    }

    const githubUsername = getUserGithubUsername(user);
    const allowlistMatch = await findAllowedCmsUser(
      supabase,
      user.email,
      githubUsername
    );

    if (!allowlistMatch) {
      logCmsAuth('ready-unauthorized', {
        locale,
        userId: user.id,
        hasEmail: Boolean(user.email),
        hasGithubUsername: Boolean(githubUsername),
      });
      await supabase.auth.signOut();
      const loginUrl = new URL(`/${locale}/cms/login`, origin);
      loginUrl.searchParams.set(
        'error',
        'Access denied. Please contact the administrator.'
      );
      return NextResponse.redirect(loginUrl);
    }

    await syncCmsUserProfile(user);

    logCmsAuth('ready-success', {
      locale,
      userId: user.id,
      role: allowlistMatch.role,
      matchSource: allowlistMatch.matchSource,
      next,
    });

    return NextResponse.redirect(new URL(`/${locale}${next}`, origin));
  } catch (error) {
    logCmsAuth('ready-error', {
      locale,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    const loginUrl = new URL(`/${locale}/cms/login`, origin);
    loginUrl.searchParams.set('error', 'Authentication failed');
    return NextResponse.redirect(loginUrl);
  }
}

import { NextResponse } from 'next/server';
import {
  buildAuthErrorRedirect,
  buildOAuthCallbackUrl,
  getRequestOrigin,
  getSafeCmsNext,
  logCmsAuth,
} from '@/app/actions/cms/utils/auth';
import { createClient } from '@/utils/supabase/server';

/**
 * GitHub OAuth entry: builds the canonical locale-prefixed callback URL
 * (allowlisted in Supabase) and starts the provider flow. All failure paths
 * land on canonical /{locale}/login with a fixed user-safe message.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;
  const localeMatch = pathname.match(/^\/([a-z]{2})\//);
  const locale = localeMatch?.[1] || 'en';
  const next = getSafeCmsNext(requestUrl.searchParams.get('next'));
  const origin = getRequestOrigin(request);
  const redirectTo = buildOAuthCallbackUrl(origin, locale, next);

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo },
    });

    logCmsAuth('github-start', {
      locale,
      next,
      hasUrl: Boolean(data.url),
      error: error?.message || null,
    });

    if (error || !data.url) {
      return NextResponse.redirect(
        buildAuthErrorRedirect(origin, locale, 'Failed to start GitHub login')
      );
    }

    return NextResponse.redirect(data.url);
  } catch (error) {
    logCmsAuth('github-start-error', {
      locale,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.redirect(
      buildAuthErrorRedirect(origin, locale, 'Failed to start GitHub login')
    );
  }
}

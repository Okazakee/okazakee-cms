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
 * GitHub OAuth entry: builds the canonical callback URL (allowlisted in
 * Supabase) and starts the provider flow. All failure paths land on
 * canonical /login with a fixed user-safe message.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const next = getSafeCmsNext(requestUrl.searchParams.get('next'));
  const origin = getRequestOrigin(request);
  const redirectTo = buildOAuthCallbackUrl(origin, next);

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo },
    });

    logCmsAuth('github-start', {
      next,
      hasUrl: Boolean(data.url),
      error: error?.message || null,
    });

    if (error || !data.url) {
      return NextResponse.redirect(
        buildAuthErrorRedirect(origin, 'Failed to start GitHub login')
      );
    }

    return NextResponse.redirect(data.url);
  } catch (error) {
    logCmsAuth('github-start-error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.redirect(
      buildAuthErrorRedirect(origin, 'Failed to start GitHub login')
    );
  }
}

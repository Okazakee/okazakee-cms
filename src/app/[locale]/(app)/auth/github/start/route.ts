import { NextResponse } from 'next/server';
import {
  getRequestOrigin,
  getSafeCmsNext,
  logCmsAuth,
} from '@/app/actions/cms/utils/auth';
import { createClient } from '@/utils/supabase/server';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;
  const localeMatch = pathname.match(/^\/([a-z]{2})\//);
  const locale = localeMatch?.[1] || 'en';
  const next = getSafeCmsNext(requestUrl.searchParams.get('next'));
  const origin = getRequestOrigin(request);
  const redirectTo = `${origin}/${locale}/auth/callback?next=${encodeURIComponent(next)}`;

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
      const errorUrl = new URL(`/${locale}/login`, origin);
      errorUrl.searchParams.set('error', 'Failed to start GitHub login');
      return NextResponse.redirect(errorUrl);
    }

    return NextResponse.redirect(data.url);
  } catch (error) {
    logCmsAuth('github-start-error', {
      locale,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    const errorUrl = new URL(`/${locale}/cms/login`, origin);
    errorUrl.searchParams.set('error', 'Failed to start GitHub login');
    return NextResponse.redirect(errorUrl);
  }
}

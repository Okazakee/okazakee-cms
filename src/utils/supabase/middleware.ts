import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';
import {
  findAllowedCmsUser,
  getUserGithubUsername,
  logCmsAuth,
} from '@/app/actions/cms/utils/auth';

/* PLEASE REFER TO https://supabase.com/docs/guides/auth/server-side/nextjs?queryGroups=router&router=app */

function clearSupabaseAuthCookies(
  response: NextResponse,
  request: NextRequest
): NextResponse {
  for (const { name } of request.cookies.getAll()) {
    // Supabase SSR auth cookies are prefixed with `sb-`
    if (name.startsWith('sb-')) {
      response.cookies.set(name, '', { path: '/', maxAge: 0 });
    }
  }
  return response;
}

// The whole app is the CMS: every route is protected except the public
// auth paths (login + OAuth routes).
const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/auth/github/start',
  '/auth/ready',
] as const;

function isPublicPath(pathname: string, locale: string): boolean {
  const normalizedPath = pathname.replace(new RegExp(`^/${locale}`), '');
  return PUBLIC_PATHS.some(
    (path) => normalizedPath === path || normalizedPath.startsWith(path)
  );
}

function isAuthPage(pathname: string): boolean {
  // Only login page - registration is disabled
  return pathname.includes('/login');
}

export async function updateSession(request: NextRequest, locale: string) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          supabaseResponse = NextResponse.next({ request });

          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  const pathname = request.nextUrl.pathname;
  const isPublic = isPublicPath(pathname, locale);
  const isAuthPath = isAuthPage(pathname);

  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] =
    null;
  let shouldClearAuthCookies = false;

  // Avoid hitting auth endpoints unless we plausibly have a Supabase session cookie.
  // This prevents noisy errors on anonymous visits.
  const hasSupabaseCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-'));

  if (hasSupabaseCookie) {
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        // Treat stale/invalid refresh token as logged-out and clear cookies to stop repeats.
        if (
          (error as { code?: string; status?: number }).code ===
            'refresh_token_not_found' ||
          (error as { code?: string; status?: number }).status === 400
        ) {
          shouldClearAuthCookies = true;
        }
      } else {
        user = data.user;
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'refresh_token_not_found') {
        shouldClearAuthCookies = true;
      }
    }
  }

  if (shouldClearAuthCookies) {
    supabaseResponse = clearSupabaseAuthCookies(supabaseResponse, request);
    user = null;
  }

  // Secure path checking - only allow exact public paths
  if (!user && !isPublic) {
    const redirectResponse = NextResponse.redirect(
      new URL(`/${locale}/login`, request.url)
    );
    return shouldClearAuthCookies
      ? clearSupabaseAuthCookies(redirectResponse, request)
      : redirectResponse;
  }

  if (user && !isPublic) {
    const allowlistMatch = await findAllowedCmsUser(
      supabase,
      user.email,
      getUserGithubUsername(user)
    );

    if (!allowlistMatch) {
      logCmsAuth('middleware-unauthorized', {
        pathname,
        userId: user.id,
        hasEmail: Boolean(user.email),
        hasGithubUsername: Boolean(getUserGithubUsername(user)),
      });
      await supabase.auth.signOut();
      const redirectUrl = new URL(`/${locale}/login`, request.url);
      redirectUrl.searchParams.set(
        'error',
        'Access denied. Please contact the administrator.'
      );
      const redirectResponse = clearSupabaseAuthCookies(
        NextResponse.redirect(redirectUrl),
        request
      );
      return redirectResponse;
    }

    logCmsAuth('middleware-authorized', {
      pathname,
      userId: user.id,
      role: allowlistMatch.role,
      matchSource: allowlistMatch.matchSource,
    });
  }

  // Redirect authenticated users away from auth pages
  if (user && isAuthPath) {
    return NextResponse.redirect(new URL(`/${locale}`, request.url));
  }

  return supabaseResponse;
}

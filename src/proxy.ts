import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { updateSession } from '@/utils/supabase/middleware';

// Environment-based configuration with validation
const LOCALES_ENV = process.env.NEXT_PUBLIC_LOCALES?.split(',') || ['en', 'it'];
const DEFAULT_LOCALE_ENV = process.env.NEXT_PUBLIC_DEFAULT_LOCALE || 'en';

// Validate configuration at startup
if (
  !Array.isArray(LOCALES_ENV) ||
  !LOCALES_ENV.every(
    (locale) => typeof locale === 'string' && locale.length === 2
  )
) {
  throw new Error(
    'Invalid LOCALES configuration: must be array of 2-character strings'
  );
}

if (!LOCALES_ENV.includes(DEFAULT_LOCALE_ENV)) {
  throw new Error(
    `DEFAULT_LOCALE '${DEFAULT_LOCALE_ENV}' must be included in LOCALES array`
  );
}

const LOCALES = LOCALES_ENV as string[];
const DEFAULT_LOCALE = DEFAULT_LOCALE_ENV;
const REDIRECT_HEADER = 'x-redirected';

// Precompiled patterns for performance
const LOCALE_SET = new Set(LOCALES);
const LOCALE_PATTERN = new RegExp(`^/(${LOCALES.join('|')})(?:/|$)`);
const STATIC_ASSET_PATTERN = /\.[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*$/;
const CMS_ROUTE_PATTERN = /^\/[a-z]{2}\/cms(?:\/.*)?$/;
const LOCALE_COOKIE_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ACCEPT_LANGUAGE_PATTERN =
  /^([a-z]{2})(?:-[a-z]{2})?(?:;q=[0-9.]+)?(?:,|$)/i;

// Comprehensive path traversal protection
const PATH_TRAVERSAL_PATTERNS = [
  /\.\./, // ..
  /%2e%2e/i, // URL encoded ..
  /%2f/i, // URL encoded /
  /\0/, // Null bytes
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check for control chars
  /[\u0000-\u001f]/, // Control characters
  /[\u007f-\u009f]/, // Extended control characters
];

const handleI18n = createMiddleware({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localeDetection: true,
});

function isValidLocale(locale: string | null | undefined): locale is string {
  return typeof locale === 'string' && LOCALE_SET.has(locale);
}

function extractLocaleFromPath(pathname: string): string | null {
  const match = pathname.match(LOCALE_PATTERN);
  return match?.[1] && isValidLocale(match[1]) ? match[1] : null;
}

function isCMSRoute(pathname: string): boolean {
  return CMS_ROUTE_PATTERN.test(pathname);
}

function validatePathname(pathname: string): string {
  if (!pathname || typeof pathname !== 'string') return '/';

  // Comprehensive path traversal protection
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(pathname)) {
      console.warn('Path traversal attempt detected:', pathname);
      return '/';
    }
  }

  // Normalize path - single regex operation
  const normalized =
    pathname.replace(/\/+/g, '/').replace(/^\/+/, '/').replace(/\/+$/, '') ||
    '/';

  // Additional validation: ensure path doesn't exceed reasonable length
  if (normalized.length > 2048) {
    console.warn('Path too long:', normalized.length);
    return '/';
  }

  return normalized;
}

function sanitizeCookieValue(value: string | undefined): string | null {
  if (!value || typeof value !== 'string') return null;

  // Additional validation for cookie security
  if (value.length > 100) return null; // Prevent oversized cookies

  if (!LOCALE_COOKIE_PATTERN.test(value)) return null;

  return isValidLocale(value) ? value : null;
}

function parseAcceptLanguage(acceptLanguage: string | null): string | null {
  if (!acceptLanguage) return null;

  try {
    const match = acceptLanguage.match(ACCEPT_LANGUAGE_PATTERN);
    if (match && isValidLocale(match[1])) {
      return match[1];
    }
  } catch (error) {
    console.error('Failed to parse Accept-Language header:', error);
  }

  return null;
}

function createRedirectResponse(
  request: NextRequest,
  pathname: string,
  locale: string
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = validatePathname(`/${locale}${pathname}`);
  const response = NextResponse.redirect(url);
  response.headers.set(REDIRECT_HEADER, 'true');
  return response;
}

function handleAuthError(
  request: NextRequest,
  locale: string,
  error: unknown
): NextResponse {
  console.error('Authentication failed for CMS route:', {
    pathname: request.nextUrl.pathname,
    locale,
    error: error instanceof Error ? error.message : 'Unknown error',
    timestamp: new Date().toISOString(),
  });

  return createRedirectResponse(request, '/cms/login', locale);
}

function handleMiddlewareError(
  request: NextRequest,
  error: unknown
): NextResponse {
  console.error('Middleware processing failed:', {
    pathname: request.nextUrl.pathname,
    error: error instanceof Error ? error.message : 'Unknown error',
    timestamp: new Date().toISOString(),
  });

  try {
    return createRedirectResponse(
      request,
      request.nextUrl.pathname,
      DEFAULT_LOCALE
    );
  } catch (redirectError) {
    console.error('Failed to create redirect URL:', redirectError);
    return NextResponse.next();
  }
}
function getPreferredLocale(request: NextRequest): string {
  try {
    const savedLocale = sanitizeCookieValue(
      request.cookies.get('NEXT_LOCALE')?.value
    );
    if (savedLocale) {
      return savedLocale;
    }

    const acceptLanguage = request.headers.get('accept-language');
    const parsedLocale = parseAcceptLanguage(acceptLanguage);
    if (parsedLocale) {
      return parsedLocale;
    }
  } catch (error) {
    console.error('Locale detection failed:', error);
  }

  return DEFAULT_LOCALE;
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check redirect loop prevention
  if (request.headers.get(REDIRECT_HEADER)) {
    return NextResponse.next();
  }

  // Skip processing for static assets, API routes - matches old matcher behavior
  // Exclude: api, _next/*, favicon.ico, assets/*, fonts/*, images/*, and files with extensions
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/fonts/') ||
    pathname.startsWith('/images/') ||
    STATIC_ASSET_PATTERN.test(pathname)
  ) {
    return NextResponse.next();
  }

  try {
    const currentLocale = extractLocaleFromPath(pathname);
    const hasLocale = currentLocale !== null;

    // Handle CMS routes authentication
    if (hasLocale && isCMSRoute(pathname)) {
      try {
        const response = await updateSession(request, currentLocale);
        if (response instanceof NextResponse) {
          response.headers.set('x-cms-route', 'true');
          return response;
        }
        const nextResponse = NextResponse.next();
        nextResponse.headers.set('x-cms-route', 'true');
        return nextResponse;
      } catch (authError) {
        return handleAuthError(request, currentLocale, authError);
      }
    }

    if (hasLocale) {
      return handleI18n(request);
    }

    const locale = getPreferredLocale(request);

    if (pathname === '/') {
      return createRedirectResponse(request, '/cms/login', locale);
    }

    return createRedirectResponse(request, pathname, locale);
  } catch (error) {
    return handleMiddlewareError(request, error);
  }
}

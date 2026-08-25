import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/utils/supabase/middleware';
import {
  isLegacyCmsPath,
  stripLegacyCmsSegment,
} from '@/utils/cmsRouteMatching';

const REDIRECT_HEADER = 'x-redirected';

// Precompiled patterns for performance
const STATIC_ASSET_PATTERN = /\.[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*$/;

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

/**
 * Validates the pathname: rejects traversal/encoding tricks. The CMS has no
 * locale routing — paths are served as-is at the root.
 */
function validatePathname(pathname: string): string {
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(pathname)) {
      return '/';
    }
  }
  return pathname;
}

function handleMiddlewareError(
  request: NextRequest,
  error: unknown
): NextResponse {
  console.error('Proxy error:', {
    pathname: request.nextUrl.pathname,
    error: error instanceof Error ? error.message : 'Unknown error',
  });

  // Fail closed for non-public paths, but avoid redirect loops
  if (!request.headers.get(REDIRECT_HEADER)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const response = NextResponse.redirect(url);
    response.headers.set(REDIRECT_HEADER, '1');
    return response;
  }
  return NextResponse.next();
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
    const safePathname = validatePathname(pathname);

    // Legacy pre-root-move paths: /cms... -> /... (old bookmarks,
    // public-site redirects that preserved the path). Segment-based:
    // `/something-cms-whatever` never matches.
    if (isLegacyCmsPath(safePathname)) {
      const url = request.nextUrl.clone();
      url.pathname = validatePathname(stripLegacyCmsSegment(safePathname));
      return NextResponse.redirect(url, 307);
    }

    // Session guard for the whole CMS (login + OAuth routes are public).
    try {
      const response = await updateSession(request);
      if (response instanceof NextResponse) {
        return response;
      }
      return NextResponse.next();
    } catch (authError) {
      console.error('CMS session handling failed:', {
        pathname: safePathname,
        error: authError instanceof Error ? authError.message : 'Unknown error',
      });
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      const response = NextResponse.redirect(url);
      response.headers.set(REDIRECT_HEADER, '1');
      return response;
    }
  } catch (error) {
    return handleMiddlewareError(request, error);
  }
}

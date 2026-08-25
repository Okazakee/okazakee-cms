/**
 * Pure CMS route-matching rules (client-safe, unit-tested).
 *
 * Used by the proxy (src/proxy.ts) and the Supabase session middleware
 * (src/utils/supabase/middleware.ts). All matching is explicit path-SEGMENT
 * based: `/login-foo` must never be a public auth route and
 * `/something-cms-whatever` must never trigger the legacy `/cms` compat
 * redirect. There is no URL locale: routes live at the root.
 */
import { describe, expect, it } from 'vitest';
import {
  isAuthPagePath,
  isCmsPublicPath,
  isLegacyCmsPath,
  normalizeTrailingSlash,
  stripLegacyCmsSegment,
} from '@/utils/cmsRouteMatching';

describe('isCmsPublicPath', () => {
  it('matches the exact public auth routes', () => {
    expect(isCmsPublicPath('/login')).toBe(true);
    expect(isCmsPublicPath('/auth/callback')).toBe(true);
    expect(isCmsPublicPath('/auth/github/start')).toBe(true);
  });

  it('accepts a trailing slash on public routes', () => {
    expect(isCmsPublicPath('/login/')).toBe(true);
  });

  it('does NOT match prefix look-alikes', () => {
    expect(isCmsPublicPath('/login-foo')).toBe(false);
    expect(isCmsPublicPath('/logins')).toBe(false);
    expect(isCmsPublicPath('/auth/callback-evil')).toBe(false);
    expect(isCmsPublicPath('/auth/github/start/extra')).toBe(false);
    expect(isCmsPublicPath('/english/login')).toBe(false);
  });
});

describe('isAuthPagePath', () => {
  it('matches only the exact login route', () => {
    expect(isAuthPagePath('/login')).toBe(true);
    expect(isAuthPagePath('/login/')).toBe(true);
    expect(isAuthPagePath('/login-foo')).toBe(false);
    expect(isAuthPagePath('/notlogin')).toBe(false);
    expect(isAuthPagePath('/auth/callback')).toBe(false);
  });
});

describe('legacy /cms compat', () => {
  it('detects and strips the /cms segment', () => {
    expect(isLegacyCmsPath('/cms/login')).toBe(true);
    expect(stripLegacyCmsSegment('/cms/login')).toBe('/login');
    expect(stripLegacyCmsSegment('/cms/auth/github/start')).toBe(
      '/auth/github/start'
    );
  });

  it('keeps non-legacy paths unchanged when stripping', () => {
    expect(stripLegacyCmsSegment('/login')).toBe('/login');
  });
});

describe('normalizeTrailingSlash', () => {
  it('normalizes a single trailing slash', () => {
    expect(normalizeTrailingSlash('/login/')).toBe('/login');
    expect(normalizeTrailingSlash('/login')).toBe('/login');
    expect(normalizeTrailingSlash('/')).toBe('/');
  });
});

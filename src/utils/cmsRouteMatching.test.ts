import { describe, expect, it } from 'vitest';
import {
  isAuthPagePath,
  isCmsPublicPath,
  isLegacyCmsPath,
  normalizeTrailingSlash,
  stripLegacyCmsSegment,
  stripLocalePrefix,
} from '@/utils/cmsRouteMatching';

describe('isCmsPublicPath', () => {
  it('matches the exact public auth routes', () => {
    expect(isCmsPublicPath('/en/login', 'en')).toBe(true);
    expect(isCmsPublicPath('/en/auth/callback', 'en')).toBe(true);
    expect(isCmsPublicPath('/en/auth/github/start', 'en')).toBe(true);
    expect(isCmsPublicPath('/it/login', 'it')).toBe(true);
  });

  it('accepts a trailing slash on public routes', () => {
    expect(isCmsPublicPath('/en/login/', 'en')).toBe(true);
  });

  it('does NOT match prefix look-alikes', () => {
    expect(isCmsPublicPath('/en/login-foo', 'en')).toBe(false);
    expect(isCmsPublicPath('/en/logins', 'en')).toBe(false);
    expect(isCmsPublicPath('/en/auth/callback-evil', 'en')).toBe(false);
    expect(isCmsPublicPath('/en/auth/github/start/extra', 'en')).toBe(false);
  });

  it('does NOT treat the dashboard or unknown routes as public', () => {
    expect(isCmsPublicPath('/en', 'en')).toBe(false);
    expect(isCmsPublicPath('/en/blog', 'en')).toBe(false);
    expect(isCmsPublicPath('/en/auth', 'en')).toBe(false);
  });

  it('requires a full locale segment', () => {
    // `/english/...` must not be treated as locale `en`
    expect(isCmsPublicPath('/english/login', 'en')).toBe(false);
    expect(isCmsPublicPath('/en/login', 'en')).toBe(true);
  });
});

describe('isAuthPagePath', () => {
  it('matches only the exact login route', () => {
    expect(isAuthPagePath('/en/login', 'en')).toBe(true);
    expect(isAuthPagePath('/en/login/', 'en')).toBe(true);
    expect(isAuthPagePath('/en/login-foo', 'en')).toBe(false);
    expect(isAuthPagePath('/en/notlogin', 'en')).toBe(false);
    expect(isAuthPagePath('/en/auth/callback', 'en')).toBe(false);
  });
});

describe('isLegacyCmsPath / stripLegacyCmsSegment', () => {
  it('matches a /cms segment and strips it', () => {
    expect(isLegacyCmsPath('/en/cms')).toBe(true);
    expect(stripLegacyCmsSegment('/en/cms')).toBe('/en');
    expect(isLegacyCmsPath('/en/cms/login')).toBe(true);
    expect(stripLegacyCmsSegment('/en/cms/login')).toBe('/en/login');
    expect(stripLegacyCmsSegment('/en/cms/auth/github/start')).toBe(
      '/en/auth/github/start'
    );
  });

  it('does NOT match paths where cms is only a prefix or suffix', () => {
    expect(isLegacyCmsPath('/en/something-cms-whatever')).toBe(false);
    expect(isLegacyCmsPath('/en/cmslogin')).toBe(false);
    expect(isLegacyCmsPath('/en/mycms')).toBe(false);
    expect(isLegacyCmsPath('/en/cmsx')).toBe(false);
  });

  it('matches a bare /cms segment (locale gating is the proxy concern)', () => {
    // The proxy only consults this after extracting a locale prefix, so a
    // bare /cms is locale-redirected before the legacy check ever runs.
    expect(isLegacyCmsPath('/cms')).toBe(true);
  });

  it('keeps non-legacy paths unchanged when stripping', () => {
    expect(stripLegacyCmsSegment('/en/login')).toBe('/en/login');
  });
});

describe('stripLocalePrefix / normalizeTrailingSlash', () => {
  it('strips a full leading locale segment', () => {
    expect(stripLocalePrefix('/en/login', 'en')).toBe('/login');
    expect(stripLocalePrefix('/en', 'en')).toBe('/');
  });

  it('does not strip a partial locale segment', () => {
    expect(stripLocalePrefix('/english/login', 'en')).toBe('/english/login');
  });

  it('normalizes a single trailing slash', () => {
    expect(normalizeTrailingSlash('/en/login/')).toBe('/en/login');
    expect(normalizeTrailingSlash('/en/login')).toBe('/en/login');
    expect(normalizeTrailingSlash('/')).toBe('/');
  });
});

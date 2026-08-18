import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * GitHub OAuth flow contract guards.
 *
 * The OAuth flow must be self-contained in two request boundaries
 * (/auth/github/start -> /auth/callback) with the callback performing ALL
 * finalization (code exchange, allowlist enforcement with sign-out on
 * unauthorized identities, profile sync, canonical /{locale} redirect). It
 * must never use legacy /cms routes internally and must not reference the
 * removed /auth/ready hop.
 *
 * Source-level on purpose: the flow depends on a live Supabase provider
 * round-trip that cannot be unit-tested.
 */

const callbackSource = readFileSync(
  fileURLToPath(new URL('./callback/route.ts', import.meta.url)),
  'utf8'
);
const startSource = readFileSync(
  fileURLToPath(new URL('./github/start/route.ts', import.meta.url)),
  'utf8'
);
const loginPageSource = readFileSync(
  fileURLToPath(new URL('../login/page.tsx', import.meta.url)),
  'utf8'
);
const accountSectionSource = readFileSync(
  fileURLToPath(
    new URL('../../../../components/common/cms/AccountSection.tsx', import.meta.url)
  ),
  'utf8'
);

describe('no legacy /cms routes used internally', () => {
  it('auth routes, login page and account section never redirect to /cms/login', () => {
    // Guards the actual redirect pattern (a template literal), not the
    // '@app/actions/cms/login' import path.
    for (const [name, source] of [
      ['callback', callbackSource],
      ['github/start', startSource],
      ['login page', loginPageSource],
      ['AccountSection', accountSectionSource],
    ]) {
      expect(source, name).not.toMatch(/\/\$\{locale\}\/cms\/login/);
      expect(source, name).not.toMatch(/'\/\$\{locale\}\/cms\/login'/);
    }
  });
});

describe('no /auth/ready hop remains', () => {
  it('the ready route is removed', () => {
    expect(existsSync(fileURLToPath(new URL('./ready/route.ts', import.meta.url)))).toBe(
      false
    );
  });

  it('callback, start and login page never reference /auth/ready', () => {
    for (const [name, source] of [
      ['callback', callbackSource],
      ['github/start', startSource],
      ['login page', loginPageSource],
    ]) {
      expect(source, name).not.toContain('auth/ready');
    }
  });
});

describe('callback finalizes the OAuth flow in one boundary', () => {
  it('exchanges the code, enforces allowlist, syncs profile and redirects canonically', () => {
    expect(callbackSource).toContain('exchangeCodeForSession');
    expect(callbackSource).toContain('findAllowedCmsUser');
    expect(callbackSource).toContain('signOut');
    expect(callbackSource).toContain('syncCmsUserProfile');
    expect(callbackSource).toContain('resolvePostAuthPath');
    expect(callbackSource).toContain('buildAuthErrorRedirect');
  });
});

describe('github/start builds the canonical callback URL', () => {
  it('starts the provider flow against the locale-prefixed callback', () => {
    expect(startSource).toContain('signInWithOAuth');
    expect(startSource).toContain('buildOAuthCallbackUrl');
    expect(startSource).toContain('buildAuthErrorRedirect');
  });
});

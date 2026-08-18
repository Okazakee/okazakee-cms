import type { User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthErrorRedirect,
  buildOAuthCallbackUrl,
  findAllowedCmsUser,
  getSafeCmsNext,
  getUserAuthProvider,
  getUserAvatarUrl,
  getUserDisplayName,
  getUserGithubUsername,
  resolvePostAuthPath,
} from '@/app/actions/cms/utils/auth';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'test@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as User;
}

describe('getSafeCmsNext', () => {
  it('keeps internal /cms paths', () => {
    expect(getSafeCmsNext('/login')).toBe('/login');
  });

  it('falls back to /cms for null/undefined', () => {
    expect(getSafeCmsNext(null)).toBe('/');
    expect(getSafeCmsNext(undefined)).toBe('/');
  });

  it('rejects protocol-relative and external URLs', () => {
    expect(getSafeCmsNext('//evil.com')).toBe('/');
    expect(getSafeCmsNext('https://evil.com')).toBe('/');
  });

  it('rejects backslash-prefixed host tricks (open redirect)', () => {
    // '/\evil.com' is parsed by browsers as '//evil.com'
    expect(getSafeCmsNext('/\\evil.com')).toBe('/');
    expect(getSafeCmsNext('/foo\\bar')).toBe('/');
  });
});

describe('resolvePostAuthPath', () => {
  it('builds the canonical /{locale} target from next=/', () => {
    expect(resolvePostAuthPath('it', '/')).toBe('/it');
    expect(resolvePostAuthPath('en', '/')).toBe('/en');
  });

  it('strips a redundant trailing slash from deeper targets', () => {
    expect(resolvePostAuthPath('it', '/blog/')).toBe('/it/blog');
    expect(resolvePostAuthPath('it', '/blog')).toBe('/it/blog');
  });

  it('falls back to /{locale} for unsafe next values', () => {
    expect(resolvePostAuthPath('it', '//evil.com')).toBe('/it');
    expect(resolvePostAuthPath('it', '/\\evil.com')).toBe('/it');
    expect(resolvePostAuthPath('it', 'https://evil.com')).toBe('/it');
    expect(resolvePostAuthPath('it', null as unknown as string)).toBe('/it');
  });
});

describe('buildOAuthCallbackUrl', () => {
  it('builds the canonical locale-prefixed callback URL', () => {
    expect(
      buildOAuthCallbackUrl('https://cms.okazakee.dev', 'en', '/')
    ).toBe(
      'https://cms.okazakee.dev/en/auth/callback?next=%2F'
    );
    expect(
      buildOAuthCallbackUrl('https://cms.okazakee.dev', 'it', '/blog')
    ).toBe(
      'https://cms.okazakee.dev/it/auth/callback?next=%2Fblog'
    );
  });

  it('sanitizes unsafe next values before encoding', () => {
    expect(
      buildOAuthCallbackUrl('https://cms.okazakee.dev', 'en', '//evil.com')
    ).toBe('https://cms.okazakee.dev/en/auth/callback?next=%2F');
    expect(
      buildOAuthCallbackUrl('https://cms.okazakee.dev', 'en', '/\\evil.com')
    ).toBe('https://cms.okazakee.dev/en/auth/callback?next=%2F');
  });
});

describe('buildAuthErrorRedirect', () => {
  it('always redirects to canonical /{locale}/login, never a /cms path', () => {
    const url = buildAuthErrorRedirect(
      'https://cms.okazakee.dev',
      'it',
      'Access denied. Please contact the administrator.'
    );
    expect(url.origin).toBe('https://cms.okazakee.dev');
    expect(url.pathname).toBe('/it/login');
    expect(url.pathname).not.toContain('/cms');
    expect(url.searchParams.get('error')).toBe(
      'Access denied. Please contact the administrator.'
    );
  });

  it('encodes the error message safely', () => {
    const url = buildAuthErrorRedirect(
      'https://cms.okazakee.dev',
      'en',
      'Authentication failed'
    );
    expect(url.toString()).toBe(
      'https://cms.okazakee.dev/en/login?error=Authentication+failed'
    );
  });
});

describe('getUserGithubUsername', () => {
  it('returns username from user_metadata', () => {
    expect(
      getUserGithubUsername(
        makeUser({ user_metadata: { user_name: 'octocat' } })
      )
    ).toBe('octocat');
  });

  it('returns null when missing or non-string', () => {
    expect(getUserGithubUsername(makeUser())).toBeNull();
    expect(
      getUserGithubUsername(makeUser({ user_metadata: { user_name: 42 } }))
    ).toBeNull();
  });
});

describe('getUserAuthProvider', () => {
  it('detects github provider', () => {
    expect(
      getUserAuthProvider(makeUser({ app_metadata: { provider: 'github' } }))
    ).toBe('github');
  });

  it('defaults to email', () => {
    expect(getUserAuthProvider(makeUser())).toBe('email');
    expect(
      getUserAuthProvider(makeUser({ app_metadata: { provider: 'google' } }))
    ).toBe('email');
  });
});

describe('getUserDisplayName', () => {
  it('prefers full_name then name then user_name then email prefix', () => {
    expect(
      getUserDisplayName(
        makeUser({ user_metadata: { full_name: 'Ada Lovelace' } })
      )
    ).toBe('Ada Lovelace');
    expect(
      getUserDisplayName(makeUser({ user_metadata: { name: 'Ada' } }))
    ).toBe('Ada');
    expect(
      getUserDisplayName(makeUser({ user_metadata: { user_name: 'ada' } }))
    ).toBe('ada');
    expect(getUserDisplayName(makeUser())).toBe('test');
    expect(getUserDisplayName(makeUser({ email: undefined }))).toBe('User');
  });
});

describe('getUserAvatarUrl', () => {
  it('returns avatar when present', () => {
    expect(
      getUserAvatarUrl(
        makeUser({ user_metadata: { avatar_url: 'https://x/a.png' } })
      )
    ).toBe('https://x/a.png');
  });

  it('returns null for empty or missing avatar', () => {
    expect(getUserAvatarUrl(makeUser())).toBeNull();
    expect(
      getUserAvatarUrl(makeUser({ user_metadata: { avatar_url: '' } }))
    ).toBeNull();
    expect(
      getUserAvatarUrl(makeUser({ user_metadata: { avatar_url: 7 } }))
    ).toBeNull();
  });
});

describe('findAllowedCmsUser', () => {
  function mockSupabase(
    rows: { email?: string; github_username?: string; role: string }[]
  ) {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn((_col: string, value: string) => ({
            maybeSingle: vi.fn(async () => ({
              data:
                rows.find(
                  (r) => r.email === value || r.github_username === value
                ) ?? null,
            })),
          })),
        })),
      })),
    } as unknown as Parameters<typeof findAllowedCmsUser>[0];
  }

  it('matches by email (case-insensitive) with role', async () => {
    const supabase = mockSupabase([
      { email: 'admin@example.com', role: 'admin' },
    ]);
    const result = await findAllowedCmsUser(supabase, 'Admin@Example.com');
    expect(result).toEqual({ role: 'admin', matchSource: 'email' });
  });

  it('matches by GitHub username with role', async () => {
    const supabase = mockSupabase([
      { github_username: 'octocat', role: 'editor' },
    ]);
    const result = await findAllowedCmsUser(supabase, null, 'octocat');
    expect(result).toEqual({ role: 'editor', matchSource: 'github' });
  });

  it('returns null for unknown users', async () => {
    const supabase = mockSupabase([{ email: 'a@b.com', role: 'admin' }]);
    expect(
      await findAllowedCmsUser(supabase, 'nope@b.com', 'nobody')
    ).toBeNull();
  });

  it('returns null when role is not a valid CMS role', async () => {
    const supabase = mockSupabase([{ email: 'x@y.com', role: 'viewer' }]);
    expect(await findAllowedCmsUser(supabase, 'x@y.com')).toBeNull();
  });
});

import type { User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  findAllowedCmsUser,
  getSafeCmsNext,
  getUserAuthProvider,
  getUserAvatarUrl,
  getUserDisplayName,
  getUserGithubUsername,
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
    expect(getSafeCmsNext('/cms/blog')).toBe('/cms/blog');
  });

  it('falls back to /cms for null/undefined', () => {
    expect(getSafeCmsNext(null)).toBe('/cms');
    expect(getSafeCmsNext(undefined)).toBe('/cms');
  });

  it('rejects protocol-relative and external URLs', () => {
    expect(getSafeCmsNext('//evil.com')).toBe('/cms');
    expect(getSafeCmsNext('https://evil.com')).toBe('/cms');
    expect(getSafeCmsNext('/login')).toBe('/cms');
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

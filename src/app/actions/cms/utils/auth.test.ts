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
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
  lookupAllowedCmsUserViaRpc,
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
  it('keeps the root target from next=/', () => {
    expect(resolvePostAuthPath('/')).toBe('/');
  });

  it('strips a redundant trailing slash from deeper targets', () => {
    expect(resolvePostAuthPath('/blog/')).toBe('/blog');
    expect(resolvePostAuthPath('/blog')).toBe('/blog');
  });

  it('falls back to / for unsafe next values', () => {
    expect(resolvePostAuthPath('//evil.com')).toBe('/');
    expect(resolvePostAuthPath('/\\evil.com')).toBe('/');
    expect(resolvePostAuthPath('https://evil.com')).toBe('/');
    expect(resolvePostAuthPath(null as unknown as string)).toBe('/');
  });
});

describe('buildOAuthCallbackUrl', () => {
  it('builds the canonical callback URL', () => {
    expect(buildOAuthCallbackUrl('https://cms.okazakee.dev', '/')).toBe(
      'https://cms.okazakee.dev/auth/callback?next=%2F'
    );
    expect(buildOAuthCallbackUrl('https://cms.okazakee.dev', '/blog')).toBe(
      'https://cms.okazakee.dev/auth/callback?next=%2Fblog'
    );
  });

  it('sanitizes unsafe next values before encoding', () => {
    expect(
      buildOAuthCallbackUrl('https://cms.okazakee.dev', '//evil.com')
    ).toBe('https://cms.okazakee.dev/auth/callback?next=%2F');
    expect(
      buildOAuthCallbackUrl('https://cms.okazakee.dev', '/\\evil.com')
    ).toBe('https://cms.okazakee.dev/auth/callback?next=%2F');
  });
});

describe('buildAuthErrorRedirect', () => {
  it('always redirects to canonical /login, never a /cms path', () => {
    const url = buildAuthErrorRedirect(
      'https://cms.okazakee.dev',
      'Access denied. Please contact the administrator.'
    );
    expect(url.origin).toBe('https://cms.okazakee.dev');
    expect(url.pathname).toBe('/login');
    expect(url.pathname).not.toContain('/cms');
    expect(url.searchParams.get('error')).toBe(
      'Access denied. Please contact the administrator.'
    );
  });

  it('encodes the error message safely', () => {
    const url = buildAuthErrorRedirect(
      'https://cms.okazakee.dev',
      'Authentication failed'
    );
    expect(url.toString()).toBe(
      'https://cms.okazakee.dev/login?error=Authentication+failed'
    );
  });
});

describe('getUserGithubId', () => {
  it('derives the numeric subject from the github identity', () => {
    expect(
      getUserGithubId(
        makeUser({
          identities: [
            {
              id: 'ignored',
              user_id: 'user-1',
              identity_id: 'iid',
              provider: 'github',
              identity_data: { sub: '123456' },
            },
          ],
        })
      )
    ).toBe('123456');
  });

  it('rejects non-numeric subjects and missing github identities', () => {
    expect(getUserGithubId(makeUser())).toBeNull();
    expect(
      getUserGithubId(
        makeUser({
          identities: [
            {
              id: 'x',
              user_id: 'user-1',
              identity_id: 'iid',
              provider: 'github',
              identity_data: { sub: 'octocat' },
            },
          ],
        })
      )
    ).toBeNull();
    expect(
      getUserGithubId(
        makeUser({
          identities: [
            {
              id: 'x',
              user_id: 'user-1',
              identity_id: 'iid',
              provider: 'google',
              identity_data: { sub: '999' },
            },
          ],
        })
      )
    ).toBeNull();
  });

  it('ignores editable user_metadata when deriving the ID', () => {
    expect(
      getUserGithubId(makeUser({ user_metadata: { user_name: 'spoofed' } }))
    ).toBeNull();
  });
});

describe('getUserGithubUsername', () => {
  it('reads the display handle from the github identity', () => {
    expect(
      getUserGithubUsername(
        makeUser({
          identities: [
            {
              id: 'x',
              user_id: 'user-1',
              identity_id: 'iid',
              provider: 'github',
              identity_data: { sub: '42', user_name: 'octocat' },
            },
          ],
        })
      )
    ).toBe('octocat');
  });

  it('returns null when no github identity handle exists', () => {
    expect(getUserGithubUsername(makeUser())).toBeNull();
  });

  it('never trusts user_metadata for the display handle', () => {
    expect(
      getUserGithubUsername(
        makeUser({ user_metadata: { user_name: 'spoofed' } })
      )
    ).toBeNull();
  });
});

describe('getVerifiedUserEmail', () => {
  it('returns the email when the auth record proves verification', () => {
    expect(
      getVerifiedUserEmail(
        makeUser({ email_confirmed_at: '2026-01-01T00:00:00Z' })
      )
    ).toBe('test@example.com');
  });

  it('rejects unverified addresses', () => {
    // Explicit undefined keeps the confirmation keys present via spread
    // while falsy, exercising the present-but-unverified branch.
    expect(
      getVerifiedUserEmail(
        makeUser({ email_confirmed_at: undefined, confirmed_at: undefined })
      )
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
    rows: {
      email?: string;
      github_user_id?: string;
      github_username?: string;
      role: string;
    }[]
  ) {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn((col: string, value: string) => ({
            maybeSingle: vi.fn(async () => ({
              data:
                rows.find(
                  (r) => (r as Record<string, unknown>)[col] === value
                ) ?? null,
            })),
          })),
        })),
      })),
    } as unknown as Parameters<typeof findAllowedCmsUser>[0];
  }

  it('matches the immutable GitHub ID first', async () => {
    const supabase = mockSupabase([{ github_user_id: '123', role: 'admin' }]);
    const result = await findAllowedCmsUser(supabase, {
      email: 'someone@example.com',
      githubUserId: '123',
      githubUsernameLegacy: 'someone-else',
    });
    expect(result).toEqual({ role: 'admin', matchSource: 'github' });
  });

  it('matches by email when no ID matches', async () => {
    const supabase = mockSupabase([
      { email: 'admin@example.com', role: 'admin' },
    ]);
    const result = await findAllowedCmsUser(supabase, {
      email: 'Admin@Example.com',
      githubUserId: null,
      githubUsernameLegacy: null,
    });
    expect(result).toEqual({ role: 'admin', matchSource: 'email' });
  });

  it('falls back to the legacy handle only when dual-allowed', async () => {
    const supabase = mockSupabase([
      { github_username: 'octocat', role: 'editor' },
    ]);
    const result = await findAllowedCmsUser(supabase, {
      email: null,
      githubUserId: null,
      githubUsernameLegacy: 'octocat',
    });
    expect(result).toEqual({ role: 'editor', matchSource: 'github' });
  });

  it('keeps the legacy positional signature for transition callers', async () => {
    const supabase = mockSupabase([
      { github_username: 'octocat', role: 'editor' },
    ]);
    const result = await findAllowedCmsUser(supabase, null, 'octocat');
    expect(result).toEqual({ role: 'editor', matchSource: 'github' });
  });

  it('returns null for unknown users', async () => {
    const supabase = mockSupabase([{ email: 'a@b.com', role: 'admin' }]);
    expect(
      await findAllowedCmsUser(supabase, {
        email: 'nope@b.com',
        githubUserId: '999',
        githubUsernameLegacy: 'nobody',
      })
    ).toBeNull();
  });

  it('returns null when role is not a valid CMS role', async () => {
    const supabase = mockSupabase([{ email: 'x@y.com', role: 'viewer' }]);
    expect(await findAllowedCmsUser(supabase, { email: 'x@y.com' })).toBeNull();
  });
});

describe('findAllowedCmsUser hardened order', () => {
  function sequenceSupabase() {
    const calls: Array<{ col: string; value: string }> = [];
    return {
      calls,
      client: {
        from: () => ({
          select: () => ({
            eq: (col: string, value: string) => ({
              maybeSingle: async () => {
                calls.push({ col, value });
                // Immutable ID claims admin; legacy handle claims editor;
                // email claims nothing (non-admin allowlist gap).
                if (col === 'github_user_id' && value === '123') {
                  return { data: { role: 'admin' } };
                }
                if (col === 'github_username' && value === 'octocat') {
                  return { data: { role: 'editor' } };
                }
                return { data: null };
              },
            }),
          }),
        }),
      } as unknown as Parameters<typeof findAllowedCmsUser>[0],
    };
  }
  it('prefers the immutable ID over a conflicting legacy handle', async () => {
    const { client, calls } = sequenceSupabase();
    const result = await findAllowedCmsUser(client, {
      email: null,
      githubUserId: '123',
      githubUsernameLegacy: 'octocat',
    });
    expect(result).toEqual({ role: 'admin', matchSource: 'github' });
    expect(calls[0]).toEqual({ col: 'github_user_id', value: '123' });
  });

  it('never reaches the legacy handle for an allowlisted non-admin email', async () => {
    const seen: string[] = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: (col: string) => ({
            maybeSingle: async () => {
              seen.push(col);
              if (col === 'email') return { data: { role: 'editor' } };
              return { data: null };
            },
          }),
        }),
      }),
    } as unknown as Parameters<typeof findAllowedCmsUser>[0];
    // findAllowedCmsUser returns the email match directly; callers enforcing
    // the no-fallthrough contract (isAdmin) stop here instead of probing
    // the handle column with a spoofable display value.
    const result = await findAllowedCmsUser(client, {
      email: 'editor@example.com',
      githubUserId: null,
      githubUsernameLegacy: 'victim-admin',
    });
    expect(result).toEqual({ role: 'editor', matchSource: 'email' });
    expect(seen).not.toContain('github_username');
  });
});

describe('lookupAllowedCmsUserViaRpc', () => {
  function mockRpc(result: unknown) {
    return {
      rpc: vi.fn(async () => ({ data: result })),
    } as unknown as Parameters<typeof lookupAllowedCmsUserViaRpc>[0];
  }

  it('returns role + matchSource from an RPC result', async () => {
    const supabase = mockRpc({ role: 'admin', match_source: 'email' });
    expect(await lookupAllowedCmsUserViaRpc(supabase)).toEqual({
      role: 'admin',
      matchSource: 'email',
    });
  });

  it('returns null for unknown users', async () => {
    const supabase = mockRpc(null);
    expect(await lookupAllowedCmsUserViaRpc(supabase)).toBeNull();
  });

  it('returns null when role is not a valid CMS role', async () => {
    const supabase = mockRpc({ role: 'viewer', match_source: 'email' });
    expect(await lookupAllowedCmsUserViaRpc(supabase)).toBeNull();
  });
});

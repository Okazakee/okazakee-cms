import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks: the session client is created WITHOUT a usable `from`
// implementation — if any code path tries to read cms_allowed_users through
// the session client, the test fails immediately (regression guard for the
// allowlist hardening: anon/authenticated must NOT read the allowlist).
const mocks = vi.hoisted(() => {
  const session = {
    auth: { getUser: vi.fn() },
    from: vi.fn(() => {
      throw new Error(
        'session client must never query tables (allowlist hardening)'
      );
    }),
  };
  const admin = { from: vi.fn() };
  return {
    session,
    admin,
    createClient: vi.fn(async () => session),
    getCmsAdminClient: vi.fn(() => admin),
  };
});

vi.mock('@/utils/supabase/server', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: mocks.getCmsAdminClient,
}));

import type { CmsAllowlistMatch } from './auth';
import {
  getCmsActionContext,
  requireAdmin,
  requireAllowedPostWriter,
} from './fileHelpers';

type AllowlistEntry = {
  email?: string;
  github_user_id?: string;
  github_username?: string;
  role: string;
};

function setupAllowlist(entries: AllowlistEntry[]) {
  mocks.admin.from.mockImplementation((table: string) => {
    expect(table).toBe('cms_allowed_users');
    return {
      select: () => ({
        eq: (col: string, value: string) => ({
          maybeSingle: vi.fn(
            async (): Promise<{ data: CmsAllowlistMatch | null }> => {
              const hit = entries.find(
                (e) => (e as Record<string, unknown>)[col] === value
              );
              return {
                data: hit
                  ? {
                      role: hit.role as CmsAllowlistMatch['role'],
                      matchSource: col === 'email' ? 'email' : 'github',
                    }
                  : null,
              };
            }
          ),
        }),
      }),
    };
  });
}

function setupSessionUser(
  user: {
    id: string;
    email?: string | null;
    emailConfirmed?: boolean;
    githubId?: string | null;
    githubUsername?: string | null;
  } | null
) {
  mocks.session.auth.getUser.mockResolvedValue(
    user
      ? {
          data: {
            user: {
              id: user.id,
              email: user.email ?? null,
              email_confirmed_at:
                user.email && user.emailConfirmed !== false
                  ? '2026-01-01T00:00:00Z'
                  : null,
              confirmed_at:
                user.email && user.emailConfirmed !== false
                  ? '2026-01-01T00:00:00Z'
                  : null,
              app_metadata: {},
              user_metadata: {},
              identities:
                user.githubId || user.githubUsername
                  ? [
                      {
                        id: 'iid',
                        user_id: user.id,
                        identity_id: 'iid',
                        provider: 'github',
                        identity_data: {
                          sub: user.githubId ?? undefined,
                          user_name: user.githubUsername ?? undefined,
                        },
                      },
                    ]
                  : [],
            },
          },
          error: null,
        }
      : { data: { user: null }, error: new Error('no session') }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.from.mockReset();
});

describe('getCmsActionContext — trust boundary after allowlist hardening', () => {
  it('authenticated admin: identity from session client, role from admin client, admin succeeds', async () => {
    setupAllowlist([{ email: 'admin@example.com', role: 'admin' }]);
    setupSessionUser({ id: 'u1', email: 'admin@example.com' });

    const context = await getCmsActionContext('admin');

    expect(context.role).toBe('admin');
    expect(context.user.id).toBe('u1');
    // Session client was used for auth only...
    expect(mocks.session.auth.getUser).toHaveBeenCalledTimes(1);
    // ...and the allowlist lookup went through the admin client.
    expect(mocks.admin.from).toHaveBeenCalledWith('cms_allowed_users');
    // The session client was never touched for table access.
    expect(mocks.session.from).not.toHaveBeenCalled();
  });

  it('immutable GitHub ID authorizes before email or handle', async () => {
    setupAllowlist([{ github_user_id: '123', role: 'admin' }]);
    setupSessionUser({
      id: 'u-id',
      email: 'someone@example.com',
      githubId: '123',
      githubUsername: 'someone',
    });

    const context = await getCmsActionContext('admin');
    expect(context.role).toBe('admin');
    expect(context.user.githubUserId).toBe('123');
  });

  it('spoofed user_metadata never authorizes', async () => {
    setupAllowlist([{ github_username: 'octocat', role: 'editor' }]);
    // No verified identity: metadata alone must not match.
    mocks.session.auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'u-spoof',
          email: null,
          app_metadata: {},
          user_metadata: { user_name: 'octocat' },
          identities: [],
        },
      },
      error: null,
    });

    await expect(getCmsActionContext('admin')).rejects.toThrow(
      'Unauthorized: Admin access required'
    );
  });

  it('unverified email never authorizes', async () => {
    setupAllowlist([{ email: 'admin@example.com', role: 'admin' }]);
    setupSessionUser({
      id: 'u-unverified',
      email: 'admin@example.com',
      emailConfirmed: false,
    });

    await expect(getCmsActionContext('admin')).rejects.toThrow(
      'Unauthorized: Admin access required'
    );
  });

  it('authenticated editor: post-writer succeeds, admin fails', async () => {
    setupAllowlist([{ email: 'editor@example.com', role: 'editor' }]);
    setupSessionUser({ id: 'u2', email: 'editor@example.com' });

    const ctx = await getCmsActionContext('post-writer');
    expect(ctx.role).toBe('editor');

    await expect(getCmsActionContext('admin')).rejects.toThrow(
      'Unauthorized: Admin access required'
    );
    expect(mocks.session.from).not.toHaveBeenCalled();
  });

  it('authenticated user not in allowlist: admin and post-writer fail', async () => {
    setupAllowlist([]);
    setupSessionUser({ id: 'u3', email: 'outsider@example.com' });

    await expect(getCmsActionContext('admin')).rejects.toThrow(
      'Unauthorized: Admin access required'
    );
    await expect(getCmsActionContext('post-writer')).rejects.toThrow(
      'Unauthorized: You do not have permission to create or edit posts'
    );
  });

  it('unauthenticated request fails before any role lookup', async () => {
    setupSessionUser(null);

    await expect(getCmsActionContext('admin')).rejects.toThrow(
      'Unauthorized: Authentication required'
    );
    await expect(getCmsActionContext()).rejects.toThrow(
      'Unauthorized: Authentication required'
    );
    // No allowlist lookup attempted at all.
    expect(mocks.admin.from).not.toHaveBeenCalled();
  });

  it('role lookup is never attempted through the session client', async () => {
    setupAllowlist([{ email: 'a@b.com', role: 'admin' }]);
    setupSessionUser({ id: 'u4', email: 'a@b.com' });

    await getCmsActionContext('admin');

    // If the code called session.from('cms_allowed_users') the mock would
    // have thrown. Assert positively that only the admin client saw the
    // allowlist table.
    expect(mocks.admin.from).toHaveBeenCalledWith('cms_allowed_users');
    expect(mocks.admin.from).toHaveBeenCalledTimes(1);
    expect(mocks.session.from).not.toHaveBeenCalled();
  });

  it('requireAdmin delegates to getCmsActionContext(admin)', async () => {
    setupAllowlist([{ email: 'boss@example.com', role: 'admin' }]);
    setupSessionUser({ id: 'u5', email: 'boss@example.com' });

    await expect(requireAdmin()).resolves.toEqual({
      id: 'u5',
      email: 'boss@example.com',
    });
    expect(mocks.admin.from).toHaveBeenCalledWith('cms_allowed_users');
  });

  it('requireAllowedPostWriter returns role for a legacy-handle editor', async () => {
    setupAllowlist([{ github_username: 'octo-editor', role: 'editor' }]);
    setupSessionUser({ id: 'u6', githubUsername: 'octo-editor' });

    await expect(requireAllowedPostWriter()).resolves.toEqual({
      id: 'u6',
      email: '',
      role: 'editor',
    });
    expect(mocks.admin.from).toHaveBeenCalledWith('cms_allowed_users');
  });
});

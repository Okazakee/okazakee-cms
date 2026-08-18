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

import {
  getCmsActionContext,
  requireAdmin,
  requireAllowedPostWriter,
} from './fileHelpers';
import type { CmsAllowlistMatch } from './auth';

type AllowlistEntry = {
  email?: string;
  github_username?: string;
  role: string;
};

function setupAllowlist(entries: AllowlistEntry[]) {
  mocks.admin.from.mockImplementation((table: string) => {
    expect(table).toBe('cms_allowed_users');
    return {
      select: () => ({
        eq: (_col: string, value: string) => ({
          maybeSingle: vi.fn(async (): Promise<{ data: CmsAllowlistMatch | null }> => {
            const hit = entries.find(
              (e) => e.email === value || e.github_username === value
            );
            return {
              data: hit
                ? {
                    role: hit.role as CmsAllowlistMatch['role'],
                    matchSource:
                      hit.email === value ? 'email' : 'github',
                  }
                : null,
            };
          }),
        }),
      }),
    };
  });
}

function setupSessionUser(user: {
  id: string;
  email?: string | null;
  user_name?: string | null;
} | null) {
  mocks.session.auth.getUser.mockResolvedValue(
    user
      ? {
          data: {
            user: {
              id: user.id,
              email: user.email ?? null,
              user_metadata: user.user_name ? { user_name: user.user_name } : {},
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

  it('requireAllowedPostWriter returns role for an editor', async () => {
    setupAllowlist([{ github_username: 'octo-editor', role: 'editor' }]);
    setupSessionUser({ id: 'u6', user_name: 'octo-editor' });

    await expect(requireAllowedPostWriter()).resolves.toEqual({
      id: 'u6',
      email: '',
      role: 'editor',
    });
    expect(mocks.admin.from).toHaveBeenCalledWith('cms_allowed_users');
  });
});

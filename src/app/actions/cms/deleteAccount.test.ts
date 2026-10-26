import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FakeSupabase,
  FakeSupabaseOptions,
} from '@/testing/unit/supabaseFake';
import { createFakeSupabase } from '@/testing/unit/supabaseFake';

/**
 * Self-deletion behaviour for the current CMS user.
 *
 * The action boundaries are injected (Supabase fake, revalidation, redirect)
 * so the role policy is asserted on outcomes — what reaches the database —
 * rather than on source text.
 */
const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  redirect: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  invalidate: vi.fn(async () => 'sent' as const),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.fake.client,
}));
vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.fake.client,
}));
vi.mock('@/libs/public-site/revalidation', () => ({
  invalidatePublicContent: h.invalidate,
}));

import { deleteMyAccount } from './deleteAccount';

type AllowlistRow = {
  id: number;
  email?: string | null;
  github_user_id?: string | null;
  github_username?: string | null;
  role: string;
};

type FakeUser = {
  id: string;
  email: string;
  identities?: Array<{
    provider: string;
    id?: string;
    identity_data?: Record<string, unknown>;
  }>;
  user_metadata?: Record<string, unknown>;
};

function setup({
  allowlist = [],
  profiles = [],
  user = { id: 'auth-user', email: 'admin@example.com' },
}: {
  allowlist?: AllowlistRow[];
  profiles?: Array<Record<string, unknown>>;
  user?: FakeUser | null;
} = {}) {
  // The fake reads only `id`/`email`; richer GoTrue fields (identities,
  // metadata) are inert fixtures for the identity-precedence cases.
  h.fake = createFakeSupabase({
    user: user as FakeSupabaseOptions['user'],
    tables: { cms_allowed_users: allowlist, user_profiles: profiles },
  });
  const fakeAuth = h.fake.client.auth as unknown as {
    signOut: typeof h.signOut;
  };
  fakeAuth.signOut = h.signOut;
}

const noWrites = () =>
  h.fake.state.log.filter((entry) => entry.mode !== 'select');

beforeEach(() => {
  h.redirect.mockReset();
  h.redirect.mockImplementation(() => {
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
  });
  h.signOut.mockClear();
  h.invalidate.mockClear();
});

describe('deleteMyAccount role policy', () => {
  it('refuses a superadmin resolved by verified email before any write', async () => {
    setup({
      allowlist: [{ id: 1, email: 'owner@example.com', role: 'superadmin' }],
      profiles: [{ id: 'auth-user', email: 'owner@example.com' }],
      user: { id: 'auth-user', email: 'owner@example.com' },
    });

    const result = await deleteMyAccount();

    expect(result).toEqual({
      success: false,
      error: 'Superadmin accounts cannot be deleted',
    });
    expect(noWrites()).toEqual([]);
    expect(h.fake.state.tables.cms_allowed_users).toHaveLength(1);
    expect(h.fake.state.tables.user_profiles).toHaveLength(1);
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('refuses a superadmin resolved by immutable GitHub id before any write', async () => {
    setup({
      allowlist: [
        {
          id: 1,
          email: null,
          github_user_id: '4242',
          role: 'superadmin',
        },
      ],
      user: {
        id: 'auth-user',
        email: 'owner@example.com',
        identities: [
          {
            provider: 'github',
            id: 'github-identity',
            identity_data: { sub: '4242' },
          },
        ],
      },
    });

    const result = await deleteMyAccount();

    expect(result).toEqual({
      success: false,
      error: 'Superadmin accounts cannot be deleted',
    });
    expect(noWrites()).toEqual([]);
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('keeps the legacy sole-admin protection', async () => {
    setup({
      allowlist: [{ id: 1, email: 'admin@example.com', role: 'admin' }],
      profiles: [{ id: 'auth-user', email: 'admin@example.com' }],
    });

    const result = await deleteMyAccount();

    expect(result).toEqual({
      success: false,
      error: 'Cannot delete the last admin account',
    });
    expect(noWrites()).toEqual([]);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('does not count a dummy admin as remaining usable access', async () => {
    setup({
      allowlist: [
        { id: 1, email: 'admin@example.com', role: 'admin' },
        { id: 2, email: 'dummy-author@dummy.local', role: 'admin' },
      ],
      profiles: [{ id: 'auth-user', email: 'admin@example.com' }],
    });

    const result = await deleteMyAccount();

    expect(result.success).toBe(false);
    expect(noWrites()).toEqual([]);
    expect(h.fake.state.tables.cms_allowed_users).toHaveLength(2);
    expect(h.fake.state.tables.user_profiles).toHaveLength(1);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('deletes an editor and owns the /login navigation', async () => {
    setup({
      allowlist: [{ id: 7, email: 'editor@example.com', role: 'editor' }],
      profiles: [{ id: 'auth-user', email: 'editor@example.com' }],
      user: { id: 'auth-user', email: 'editor@example.com' },
    });

    await expect(deleteMyAccount()).rejects.toThrow('NEXT_REDIRECT');

    expect(h.fake.state.tables.cms_allowed_users).toEqual([]);
    expect(h.fake.state.tables.user_profiles).toEqual([]);
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith({
      entity: 'author',
      operation: 'update',
      id: 'auth-user',
    });
    expect(h.redirect).toHaveBeenCalledWith('/login');
  });

  it('deletes an admin while another admin remains', async () => {
    setup({
      allowlist: [
        { id: 1, email: 'admin@example.com', role: 'admin' },
        { id: 2, email: 'peer@example.com', role: 'admin' },
      ],
      profiles: [{ id: 'auth-user', email: 'admin@example.com' }],
    });

    await expect(deleteMyAccount()).rejects.toThrow('NEXT_REDIRECT');

    expect(h.fake.state.tables.cms_allowed_users.map((row) => row.id)).toEqual([
      2,
    ]);
    expect(h.redirect).toHaveBeenCalledWith('/login');
  });

  it('deletes an admin while the unremovable superadmin owner remains', async () => {
    setup({
      allowlist: [
        { id: 1, email: 'admin@example.com', role: 'admin' },
        { id: 2, email: 'owner@example.com', role: 'superadmin' },
      ],
      profiles: [
        { id: 'auth-user', email: 'admin@example.com' },
        { id: 'owner-auth', email: 'owner@example.com' },
      ],
    });

    await expect(deleteMyAccount()).rejects.toThrow('NEXT_REDIRECT');

    // Only the leaving admin is removed: the owner allowlist row and profile
    // survive, so privileged access does not depend on the last admin.
    expect(h.fake.state.tables.cms_allowed_users.map((row) => row.id)).toEqual([
      2,
    ]);
    expect(h.fake.state.tables.user_profiles.map((row) => row.id)).toEqual([
      'owner-auth',
    ]);
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.redirect).toHaveBeenCalledWith('/login');
  });

  it('never authorizes deletion from editable user metadata', async () => {
    setup({
      allowlist: [
        {
          id: 3,
          email: null,
          github_username: 'legacy-handle',
          role: 'editor',
        },
      ],
      user: {
        id: 'auth-user',
        email: 'stranger@example.com',
        user_metadata: { user_name: 'legacy-handle' },
      },
    });

    const result = await deleteMyAccount();

    expect(result).toEqual({
      success: false,
      error: 'User not found in allowed users',
    });
    expect(noWrites()).toEqual([]);
    expect(h.fake.state.tables.cms_allowed_users).toHaveLength(1);
  });

  it('fails closed on an unmatched verified email (no legacy-handle fallthrough)', async () => {
    setup({
      allowlist: [
        {
          id: 4,
          email: null,
          github_username: 'legacy-handle',
          role: 'editor',
        },
      ],
      user: {
        id: 'auth-user',
        email: 'stranger@example.com',
        identities: [
          {
            provider: 'github',
            id: 'github-identity',
            identity_data: { user_name: 'legacy-handle' },
          },
        ],
      },
    });

    const result = await deleteMyAccount();

    expect(result).toEqual({
      success: false,
      error: 'User not found in allowed users',
    });
    expect(noWrites()).toEqual([]);
    expect(h.fake.state.tables.cms_allowed_users).toHaveLength(1);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    setup({ user: null });

    const result = await deleteMyAccount();

    expect(result).toEqual({
      success: false,
      error: 'Unauthorized: Authentication required',
    });
    expect(noWrites()).toEqual([]);
  });
});

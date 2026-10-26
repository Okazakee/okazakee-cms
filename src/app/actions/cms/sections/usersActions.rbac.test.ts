import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FakeSupabase,
  FakeSupabaseOptions,
} from '@/testing/unit/supabaseFake';
import { createFakeSupabase } from '@/testing/unit/supabaseFake';

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  invite: vi.fn(),
  invalidate: vi.fn(async () => 'sent' as const),
}));
vi.mock('@/config/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabaseSchema: 'dev_staging',
}));
vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.fake.client,
}));
vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.fake.client,
}));
vi.mock('@/libs/public-site/revalidation', () => ({
  invalidatePublicContent: h.invalidate,
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('blurkit/node', () => ({ encode: vi.fn() }));
vi.mock('@/libs/cms/onboarding/invite', () => ({
  sendCmsInvitation: (email: string) => h.invite(email),
}));

import { updateUserDisplayName, usersActions } from './usersActions';

type Tables = NonNullable<FakeSupabaseOptions['tables']>;

const ADMIN_ACTOR = { id: 'user-admin', email: 'admin@example.com' };
const SUPERADMIN_ACTOR = { id: 'user-owner', email: 'owner@example.com' };

/**
 * Rows cover every management edge: the acting admin, an executable editor,
 * a peer admin, the bootstrap superadmin, and a profile without an allowlist
 * binding.
 */
function baseTables(): Tables {
  return {
    cms_allowed_users: [
      { id: 1, email: 'admin@example.com', role: 'admin' },
      { id: 2, email: 'editor@example.com', role: 'editor' },
      { id: 3, email: 'peer@example.com', role: 'admin' },
      { id: 4, email: 'owner@example.com', role: 'superadmin' },
    ],
    user_profiles: [
      {
        id: 'user-admin',
        email: 'admin@example.com',
        display_name: 'Admin',
        avatar_url: null,
      },
      {
        id: 'editor-profile',
        email: 'editor@example.com',
        display_name: 'Editor',
        avatar_url: null,
      },
      {
        id: 'peer-profile',
        email: 'peer@example.com',
        display_name: 'Peer',
        avatar_url: null,
      },
      {
        id: 'owner-profile',
        email: 'owner@example.com',
        display_name: 'Owner',
        avatar_url: null,
      },
      {
        id: 'orphan-profile',
        email: 'orphan@example.com',
        display_name: 'Orphan',
        avatar_url: null,
      },
    ],
  };
}

function setup(
  tables: Tables,
  user: { id: string; email: string } = ADMIN_ACTOR
): void {
  h.fake = createFakeSupabase({ tables, user });
}

function roleOf(id: number): unknown {
  return h.fake.state.tables.cms_allowed_users.find((row) => row.id === id)
    ?.role;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  h.invalidate.mockClear();
  h.invite.mockReset();
  h.invite.mockResolvedValue({
    status: 'sent',
    invitedAt: '2026-02-01T00:00:00.000Z',
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('runtime role validation', () => {
  it('rejects malformed and privileged role payloads before any write on every add path', async () => {
    setup(baseTables());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const before = h.fake.state.tables.cms_allowed_users.length;

    for (const role of ['superadmin', 'owner', '', 'ADMIN', 1, null, {}]) {
      const results = await Promise.all([
        usersActions({ type: 'ADD_EMAIL', email: 'new@example.com', role }),
        usersActions({ type: 'ADD_GITHUB', github_username: 'new-user', role }),
        usersActions({ type: 'ADD_DUMMY', display_name: 'New dummy', role }),
      ]);
      for (const result of results) {
        expect(result.success).toBe(false);
      }
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.fake.state.tables.cms_allowed_users).toHaveLength(before);
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.fake.state.log.filter((entry) => entry.mode === 'insert')).toEqual(
      []
    );
  });

  it('defaults an omitted role to editor on every add path', async () => {
    setup(baseTables());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ id: 4242, login: 'new-user' }),
      }))
    );

    const emailAdd = await usersActions({
      type: 'ADD_EMAIL',
      email: 'new@example.com',
    });
    expect(emailAdd.success).toBe(true);
    expect(emailAdd.data).toMatchObject({ role: 'editor' });

    const githubAdd = await usersActions({
      type: 'ADD_GITHUB',
      github_username: 'new-user',
    });
    expect(githubAdd.success).toBe(true);
    expect(githubAdd.data).toMatchObject({ role: 'editor' });

    const dummyAdd = await usersActions({
      type: 'ADD_DUMMY',
      display_name: 'New dummy',
    });
    expect(dummyAdd.success).toBe(true);
    expect(
      h.fake.state.tables.cms_allowed_users.find((row) =>
        String(row.email).startsWith('dummy-')
      )?.role
    ).toBe('editor');
  });

  it('cannot escalate a role through UPDATE_ROLE even with a widened DB vocabulary', async () => {
    setup(baseTables());

    const result = await usersActions({
      type: 'UPDATE_ROLE',
      id: 2,
      role: 'superadmin',
    });

    expect(result.success).toBe(false);
    expect(roleOf(2)).toBe('editor');
  });

  it('lets an admin add only editors, never a peer admin', async () => {
    setup(baseTables());

    const adminAdd = await usersActions({
      type: 'ADD_EMAIL',
      email: 'new-admin@example.com',
      role: 'admin',
    });
    expect(adminAdd.success).toBe(false);
    expect(adminAdd.error).toContain('superadmin');

    const editorAdd = await usersActions({
      type: 'ADD_EMAIL',
      email: 'new-editor@example.com',
      role: 'editor',
    });
    expect(editorAdd.success).toBe(true);
    expect(editorAdd.data).toMatchObject({ role: 'editor' });
    expect(h.invite).toHaveBeenCalledWith('new-editor@example.com');
  });

  it('creates dummy identities only as editors', async () => {
    setup(baseTables());

    expect(
      (
        await usersActions({
          type: 'ADD_DUMMY',
          display_name: 'Temp admin',
          role: 'admin',
        })
      ).success
    ).toBe(false);

    expect(
      (
        await usersActions({
          type: 'ADD_DUMMY',
          display_name: 'Temp editor',
          role: 'editor',
        })
      ).success
    ).toBe(true);
    const dummy = h.fake.state.tables.cms_allowed_users.find((row) =>
      String(row.email).startsWith('dummy-')
    );
    expect(dummy?.role).toBe('editor');
  });
});

describe('dummy identity privileges', () => {
  const DUMMY_EDITOR = {
    id: 5,
    email: 'dummy-8b1f@dummy.local',
    role: 'editor',
  };

  it('refuses a superadmin promotion of a dummy editor without writing', async () => {
    const tables = baseTables();
    tables.cms_allowed_users.push({ ...DUMMY_EDITOR });
    setup(tables, SUPERADMIN_ACTOR);
    const allowlistBefore = structuredClone(
      h.fake.state.tables.cms_allowed_users
    );

    const result = await usersActions({
      type: 'UPDATE_ROLE',
      id: DUMMY_EDITOR.id,
      role: 'admin',
    });

    expect(result.success).toBe(false);
    expect(roleOf(DUMMY_EDITOR.id)).toBe('editor');
    expect(h.fake.state.tables.cms_allowed_users).toEqual(allowlistBefore);
    expect(h.fake.state.log.filter((entry) => entry.mode !== 'select')).toEqual(
      []
    );
  });

  it('never mints a privileged dummy identity through ADD_EMAIL', async () => {
    setup(baseTables(), SUPERADMIN_ACTOR);

    const result = await usersActions({
      type: 'ADD_EMAIL',
      email: 'dummy-injected@dummy.local',
      role: 'admin',
    });

    expect(result.success).toBe(false);
    expect(
      h.fake.state.tables.cms_allowed_users.some(
        (row) => row.email === 'dummy-injected@dummy.local'
      )
    ).toBe(false);
    expect(h.fake.state.log.filter((entry) => entry.mode === 'insert')).toEqual(
      []
    );
    expect(h.invite).not.toHaveBeenCalled();
  });

  it('keeps dummy identities non-privileged without letting them stand in for coverage', async () => {
    setup(
      {
        cms_allowed_users: [
          { id: 1, email: 'admin@example.com', role: 'admin' },
          { id: 4, email: 'owner@example.com', role: 'superadmin' },
          { id: 5, email: 'dummy-legacy@dummy.local', role: 'admin' },
        ],
        user_profiles: [],
      },
      SUPERADMIN_ACTOR
    );

    // The only real admin can be revoked because the superadmin owner remains:
    // a compromised admin cannot become permanent.
    const demote = await usersActions({
      type: 'UPDATE_ROLE',
      id: 1,
      role: 'editor',
    });
    expect(demote.success).toBe(true);
    expect(roleOf(1)).toBe('editor');

    // The legacy dummy admin never provided coverage and is reduced to the
    // only role a dummy identity may hold.
    const cleanup = await usersActions({
      type: 'UPDATE_ROLE',
      id: 5,
      role: 'editor',
    });
    expect(cleanup.success).toBe(true);
    expect(roleOf(5)).toBe('editor');

    // The genuine owner row is untouched by either operation.
    expect(roleOf(4)).toBe('superadmin');
  });
});

describe('peer and superadmin protection', () => {
  it('stops an admin from demoting or removing a peer admin', async () => {
    setup(baseTables());

    const demote = await usersActions({
      type: 'UPDATE_ROLE',
      id: 3,
      role: 'editor',
    });
    expect(demote.success).toBe(false);
    expect(demote.error).toContain('superadmin');

    const remove = await usersActions({ type: 'REMOVE', id: 3 });
    expect(remove.success).toBe(false);
    expect(roleOf(3)).toBe('admin');
    expect(
      h.fake.state.tables.cms_allowed_users.some((row) => row.id === 3)
    ).toBe(true);
  });

  it('never lets the superadmin change its own row through the CMS', async () => {
    setup(baseTables(), SUPERADMIN_ACTOR);

    const demote = await usersActions({
      type: 'UPDATE_ROLE',
      id: 4,
      role: 'admin',
    });
    expect(demote.success).toBe(false);

    const remove = await usersActions({ type: 'REMOVE', id: 4 });
    expect(remove.success).toBe(false);
    expect(roleOf(4)).toBe('superadmin');
  });

  it('lets the superadmin manage admins and editors', async () => {
    setup(baseTables(), SUPERADMIN_ACTOR);

    const demotePeer = await usersActions({
      type: 'UPDATE_ROLE',
      id: 3,
      role: 'editor',
    });
    expect(demotePeer.success).toBe(true);
    expect(roleOf(3)).toBe('editor');

    const promoteEditor = await usersActions({
      type: 'UPDATE_ROLE',
      id: 2,
      role: 'admin',
    });
    expect(promoteEditor.success).toBe(true);
    expect(roleOf(2)).toBe('admin');
  });

  it('lets the superadmin demote the only admin while it still holds access', async () => {
    setup(
      {
        cms_allowed_users: [
          { id: 1, email: 'admin@example.com', role: 'admin' },
          { id: 4, email: 'owner@example.com', role: 'superadmin' },
        ],
        user_profiles: [],
      },
      SUPERADMIN_ACTOR
    );

    // The owner superadmin is usable privileged access, so revoking a sole
    // compromised admin loses no coverage.
    const result = await usersActions({
      type: 'UPDATE_ROLE',
      id: 1,
      role: 'editor',
    });
    expect(result.success).toBe(true);
    expect(roleOf(1)).toBe('editor');
    expect(roleOf(4)).toBe('superadmin');
  });

  it('lets the superadmin remove the only admin while it still holds access', async () => {
    setup(
      {
        cms_allowed_users: [
          { id: 1, email: 'admin@example.com', role: 'admin' },
          { id: 4, email: 'owner@example.com', role: 'superadmin' },
        ],
        user_profiles: [],
      },
      SUPERADMIN_ACTOR
    );

    const result = await usersActions({ type: 'REMOVE', id: 1 });
    expect(result.success).toBe(true);
    expect(
      h.fake.state.tables.cms_allowed_users.some((row) => row.id === 1)
    ).toBe(false);
    expect(roleOf(4)).toBe('superadmin');
  });

  it('keeps a sole admin protected before any superadmin is provisioned', async () => {
    setup(
      {
        cms_allowed_users: [
          { id: 1, email: 'admin@example.com', role: 'admin' },
          { id: 2, email: 'editor@example.com', role: 'editor' },
        ],
        user_profiles: [],
      },
      ADMIN_ACTOR
    );

    // Pre-bootstrap this admin is the only source of usable privileged
    // access: it must not be demoted or removed.
    const demote = await usersActions({
      type: 'UPDATE_ROLE',
      id: 1,
      role: 'editor',
    });
    expect(demote.success).toBe(false);
    expect(roleOf(1)).toBe('admin');

    const remove = await usersActions({ type: 'REMOVE', id: 1 });
    expect(remove.success).toBe(false);
    expect(roleOf(1)).toBe('admin');
  });

  it("blocks removing the caller's own directory row without mutation", async () => {
    setup(baseTables());
    // The authenticated admin owns allowlist row 1 (unique email). Removing
    // one's own row must be denied without touching DB rows, profiles or
    // storage.
    const allowlistBefore = structuredClone(
      h.fake.state.tables.cms_allowed_users
    );
    const profilesBefore = structuredClone(h.fake.state.tables.user_profiles);

    const result = await usersActions({ type: 'REMOVE', id: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(h.fake.state.tables.cms_allowed_users).toEqual(allowlistBefore);
    expect(h.fake.state.tables.user_profiles).toEqual(profilesBefore);
    expect(h.fake.state.log.filter((entry) => entry.mode !== 'select')).toEqual(
      []
    );
    expect(h.fake.state.removed).toEqual([]);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('reports a concurrent role change instead of overwriting it', async () => {
    setup(baseTables(), SUPERADMIN_ACTOR);
    h.fake.state.failNext = {
      table: 'cms_allowed_users',
      mode: 'update',
      message: 'no rows',
      zeroRows: true,
    };

    const result = await usersActions({
      type: 'UPDATE_ROLE',
      id: 3,
      role: 'editor',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('concurrently');
    expect(roleOf(3)).toBe('admin');
  });
});

describe('alternate profile mutation routes', () => {
  it('binds profile edits to manageable allowlisted targets only', async () => {
    setup(baseTables());

    expect(
      (await updateUserDisplayName('editor-profile', 'Renamed')).success
    ).toBe(true);
    expect((await updateUserDisplayName('peer-profile', 'Nope')).success).toBe(
      false
    );
    expect((await updateUserDisplayName('owner-profile', 'Nope')).success).toBe(
      false
    );
    expect(
      (await updateUserDisplayName('orphan-profile', 'Nope')).success
    ).toBe(false);
    // Self-service is updateMyProfile only.
    expect((await updateUserDisplayName('user-admin', 'Nope')).success).toBe(
      false
    );

    const edited = h.fake.state.tables.user_profiles.find(
      (row) => row.id === 'editor-profile'
    );
    expect(edited).toMatchObject({
      display_name: 'Renamed',
      email: 'editor@example.com',
    });
    expect(
      h.fake.state.tables.user_profiles.find((row) => row.id === 'peer-profile')
    ).toMatchObject({ display_name: 'Peer' });
  });

  it('applies the same allowlist binding to UPDATE_PROFILE', async () => {
    setup(baseTables());

    const allowed = await usersActions({
      type: 'UPDATE_PROFILE',
      profileId: 'editor-profile',
      displayName: 'From directory',
    });
    expect(allowed.success).toBe(true);

    const protectedTarget = await usersActions({
      type: 'UPDATE_PROFILE',
      profileId: 'owner-profile',
      displayName: 'Hijacked',
    });
    expect(protectedTarget.success).toBe(false);
    expect(
      h.fake.state.tables.user_profiles.find(
        (row) => row.id === 'owner-profile'
      )?.display_name
    ).toBe('Owner');
  });
});

describe('invitation truthfulness', () => {
  it('reports sent / existing / failed without faking the email', async () => {
    setup(baseTables());

    h.invite.mockResolvedValueOnce({
      status: 'failed',
      error: 'Failed to send the invitation email',
    });
    const failed = await usersActions({
      type: 'ADD_EMAIL',
      email: 'invitee@example.com',
      role: 'editor',
    });
    expect(failed.success).toBe(true);
    expect(failed.invitation).toBe('failed');
    expect(failed.invitationError).toContain('invitation email');
    expect(
      h.fake.state.tables.cms_allowed_users.find(
        (row) => row.email === 'invitee@example.com'
      )?.invited_at ?? null
    ).toBeNull();

    h.invite.mockResolvedValueOnce({ status: 'existing-account' });
    const existing = await usersActions({
      type: 'ADD_EMAIL',
      email: 'known@example.com',
      role: 'editor',
    });
    expect(existing.success).toBe(true);
    expect(existing.invitation).toBe('existing-account');
    expect(
      h.fake.state.tables.cms_allowed_users.find(
        (row) => row.email === 'known@example.com'
      )?.invited_at ?? null
    ).toBeNull();

    h.invite.mockResolvedValueOnce({
      status: 'sent',
      invitedAt: '2026-02-02T00:00:00.000Z',
    });
    const sent = await usersActions({
      type: 'ADD_EMAIL',
      email: 'sent@example.com',
      role: 'editor',
    });
    expect(sent.success).toBe(true);
    expect(sent.invitation).toBe('sent');
    expect(
      h.fake.state.tables.cms_allowed_users.find(
        (row) => row.email === 'sent@example.com'
      )?.invited_at
    ).toBe('2026-02-02T00:00:00.000Z');
  });

  it('keeps the committed row when invited_at persistence fails', async () => {
    setup(baseTables());
    h.fake.state.failNext = {
      table: 'cms_allowed_users',
      mode: 'update',
      message: 'stamp denied',
    };

    const result = await usersActions({
      type: 'ADD_EMAIL',
      email: 'stamp@example.com',
      role: 'editor',
    });

    expect(result.success).toBe(true);
    expect(result.invitation).toBe('sent');
    expect(
      h.fake.state.tables.cms_allowed_users.some(
        (row) => row.email === 'stamp@example.com'
      )
    ).toBe(true);
  });

  it('re-reads the invited target and checks permission before resending', async () => {
    setup(baseTables());

    const peer = await usersActions({ type: 'RESEND_INVITE', id: 3 });
    expect(peer.success).toBe(false);
    expect(h.invite).not.toHaveBeenCalled();

    const editor = await usersActions({ type: 'RESEND_INVITE', id: 2 });
    expect(editor.success).toBe(true);
    expect(h.invite).toHaveBeenCalledWith('editor@example.com');
    expect(
      h.fake.state.tables.cms_allowed_users.find((row) => row.id === 2)
        ?.invited_at
    ).toBe('2026-02-01T00:00:00.000Z');
  });
});

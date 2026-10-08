import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FakeSupabase,
  FakeSupabaseOptions,
} from '@/testing/unit/supabaseFake';
import { createFakeSupabase } from '@/testing/unit/supabaseFake';

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  deleteAuth: vi.fn(async () => {
    throw new Error('Shared Auth must remain untouched');
  }),
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

import { usersActions } from './usersActions';

const origin = 'https://fake.supabase.co';
const owned = `${origin}/storage/v1/object/public/website-dev/avatars/dummy.webp`;
function setup(avatar = owned, failure?: FakeSupabaseOptions['failNext']) {
  h.fake = createFakeSupabase({
    tables: {
      cms_allowed_users: [
        { id: 1, email: 'admin@example.com', role: 'admin' },
        { id: 2, email: 'dummy-person@dummy.local', role: 'editor' },
      ],
      user_profiles: [
        {
          id: 'dummy-profile',
          email: 'dummy-person@dummy.local',
          avatar_url: avatar,
        },
      ],
    },
    failNext: failure,
  });
  h.fake.client.auth.admin.deleteUser = h.deleteAuth;
}
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  h.deleteAuth.mockClear();
  h.invalidate.mockClear();
});
afterEach(() => vi.unstubAllEnvs());
describe('user removal storage safety', () => {
  it('commits both rows before exact avatar cleanup and leaves shared Auth untouched', async () => {
    setup();
    const result = await usersActions({ type: 'REMOVE', id: 2 });
    expect(result.success).toBe(true);
    expect(h.fake.state.tables.user_profiles).toEqual([]);
    expect(h.fake.state.tables.cms_allowed_users.map((row) => row.id)).toEqual([
      1,
    ]);
    expect(h.fake.state.removed).toEqual(['avatars/dummy.webp']);
    expect(h.deleteAuth).not.toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith({
      entity: 'author',
      operation: 'update',
      id: 'dummy-profile',
    });
  });
  it.each([
    'https://avatars.githubusercontent.com/u/123',
    'https://wrong.example/storage/v1/object/public/website-dev/avatars/dummy.webp',
    `${origin}/storage/v1/object/public/website/avatars/dummy.webp`,
  ])('does not delete an unowned avatar: %s', async (avatar) => {
    setup(avatar);
    expect((await usersActions({ type: 'REMOVE', id: 2 })).success).toBe(true);
    expect(h.fake.state.removed).toEqual([]);
  });
  it.each(['cms_allowed_users', 'user_profiles'])(
    'preserves the avatar if %s deletion fails',
    async (table) => {
      setup(owned, { table, mode: 'delete', message: 'Delete denied' });
      const result = await usersActions({ type: 'REMOVE', id: 2 });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(h.fake.state.tables.user_profiles).toHaveLength(1);
      expect(h.fake.state.removed).toEqual([]);
      expect(h.deleteAuth).not.toHaveBeenCalled();
    }
  );
  it('protects the last admin and reports a missing target without cleanup', async () => {
    setup();
    expect((await usersActions({ type: 'REMOVE', id: 1 })).error).toContain(
      'last admin'
    );
    expect((await usersActions({ type: 'REMOVE', id: 999 })).success).toBe(
      false
    );
    expect(h.fake.state.removed).toEqual([]);
  });
  it('does not fall back to a recycled GitHub handle when an immutable ID exists', async () => {
    setup();
    h.fake.state.tables.cms_allowed_users[1] = {
      id: 2,
      role: 'editor',
      github_user_id: 'original-id',
      github_username: 'recycled',
    };
    h.fake.state.tables.user_profiles = [
      {
        id: 'other-person',
        github_user_id: 'different-id',
        github_username: 'recycled',
        avatar_url: owned,
      },
    ];
    expect((await usersActions({ type: 'REMOVE', id: 2 })).success).toBe(true);
    expect(h.fake.state.tables.user_profiles).toHaveLength(1);
    expect(h.fake.state.removed).toEqual([]);
  });
});

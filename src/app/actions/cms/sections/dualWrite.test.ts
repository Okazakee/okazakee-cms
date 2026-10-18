import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

/**
 * Blog dual-write integration (Phase 7A). Uses the established fake Supabase /
 * fake Storage harness — no network, no real bucket.
 *
 * The content bucket is `website-content-dev`; the public asset bucket stays
 * `website-dev`, so inspecting `state.objects` keys distinguishes them.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  invalidate: vi.fn(async () => 'sent' as const),
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
vi.mock('next/cache', () => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({ hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })),
}));

import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import { blogActions } from '@/app/actions/cms/sections/blogActions';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];
const CONTENT = 'website-content-dev/';

function webpFile(name = 'image.webp'): File {
  return new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], name, {
    type: 'image/webp',
  });
}

function blogCreate(bodyEn = '# en body', bodyIt = '# it body') {
  return {
    data: {
      title_en: 'Title',
      title_it: 'Titolo',
      image: '',
      description_en: 'd',
      description_it: 'd',
      body_en: bodyEn,
      body_it: bodyIt,
      blurhashURL: '',
      post_tags: '',
      author_id: 'user-1',
    },
    file: webpFile(),
    tempId: 'c1',
  };
}

function fake(
  tables: Record<string, Array<Record<string, unknown>>> = {},
  extra: Partial<Parameters<typeof createFakeSupabase>[0]> = {}
): FakeSupabase {
  return createFakeSupabase({
    tables: { cms_allowed_users: EDITOR, ...tables },
    ...extra,
  });
}

function contentObjectKeys(store: FakeSupabase): string[] {
  return Object.keys(store.state.objects).filter((key) => key.startsWith(CONTENT));
}

beforeEach(() => {
  h.invalidate.mockClear();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
  vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'false');
});

describe('blog dual-write: feature isolation', () => {
  it('is disabled by default: no pointers and no content-bucket objects', async () => {
    h.fake = fake({ blog_posts: [] });
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBeUndefined();
    expect(row?.body_it_path).toBeUndefined();
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('enabled in dev writes pointers and immutable objects', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('# en **final**', '# it final')],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    const id = row?.id as number;
    expect(row?.body_en_path).toMatch(
      new RegExp(`^blog/${id}/en/[0-9a-f]{64}\\.md$`)
    );
    expect(row?.body_it_path).toMatch(
      new RegExp(`^blog/${id}/it/[0-9a-f]{64}\\.md$`)
    );
    // Intended visibility preserved (default published).
    expect(row?.hidden).toBe(false);
    // The provisional INSERT was hidden, then committed with the final value.
    const insert = h.fake.state.log.find((entry) => entry.mode === 'insert');
    expect((insert?.payload as { hidden?: boolean } | undefined)?.hidden).toBe(
      true
    );
    // Objects hold the exact final bytes.
    const enKey = `${CONTENT}${row?.body_en_path as string}`;
    expect(Buffer.from(h.fake.state.objects[enKey] as Buffer).toString('utf8')).toBe(
      '# en **final**'
    );
  });

  it('rejects an enabled flag in production before any DB or Storage call', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('refusing to resolve a content bucket');
    expect(h.fake.state.log).toEqual([]);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('keeps production on the legacy path: no pointer columns, no content bucket', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBeUndefined();
    expect(row?.body_it_path).toBeUndefined();
    expect(contentObjectKeys(h.fake)).toEqual([]);
    for (const entry of h.fake.state.log) {
      expect(JSON.stringify(entry.payload ?? {})).not.toContain('body_en_path');
    }
  });
});

describe('blog dual-write: batch update', () => {
  const seeded = () => ({
    blog_posts: [
      {
        id: 7,
        title_en: 'T',
        title_it: 'T',
        image: '',
        description_en: 'd',
        description_it: 'd',
        body_en: '# old en',
        body_it: '# old it',
        body_en_path: `blog/7/en/${'a'.repeat(64)}.md`,
        body_it_path: `blog/7/it/${'b'.repeat(64)}.md`,
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
        hidden: false,
      },
    ],
  });

  const update = (data: Record<string, unknown>) => ({
    id: 7,
    data,
    currentImageUrl: undefined,
  });

  it('replaces only the changed language pointer', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toMatch(/^blog\/7\/en\/[0-9a-f]{64}\.md$/);
    expect(row?.body_en_path).not.toBe(`blog/7/en/${'a'.repeat(64)}.md`);
    expect(row?.body_it_path).toBe(`blog/7/it/${'b'.repeat(64)}.md`);
  });

  it('makes no Storage call for a metadata-only update', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ title_en: 'Renamed' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('leaves the committed pointers intact when the DB update fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded(), {
      failNext: { table: 'blog_posts', mode: 'update', message: 'db down' },
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(`blog/7/en/${'a'.repeat(64)}.md`);
    expect(row?.body_en).toBe('# old en');
  });

  it('leaves the DB unchanged when the Markdown upload fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded(), {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_en_path).toBe(`blog/7/en/${'a'.repeat(64)}.md`);
  });
});

describe('blog dual-write: single-shot paths', () => {
  it('creates with pointers and the intended visibility', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'CREATE',
      data: {
        title_en: 'T',
        title_it: 'T',
        image: 'https://x.test/a.webp',
        description_en: 'd',
        description_it: 'd',
        body_en: '# single en',
        body_it: '# single it',
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
        hidden: true,
      },
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.hidden).toBe(true);
    expect(row?.body_en_path).toMatch(/^blog\/\d+\/en\/[0-9a-f]{64}\.md$/);
    expect(row?.body_it_path).toMatch(/^blog\/\d+\/it\/[0-9a-f]{64}\.md$/);
  });

  it('preserves the omitted pointer on a partial update', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({
      blog_posts: [
        {
          id: 9,
          title_en: 'T',
          body_en: '# old en',
          body_it: '# old it',
          body_en_path: `blog/9/en/${'c'.repeat(64)}.md`,
          body_it_path: `blog/9/it/${'d'.repeat(64)}.md`,
          image: '',
          hidden: false,
        },
      ],
    });

    const result = await blogActions({
      type: 'UPDATE',
      id: 9,
      data: { body_it: '# new it' },
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(`blog/9/en/${'c'.repeat(64)}.md`);
    expect(row?.body_it_path).not.toBe(`blog/9/it/${'d'.repeat(64)}.md`);
  });

  it('rolls the provisional row back when the Markdown upload fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] }, {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });

    const result = await blogActions({
      type: 'CREATE',
      data: {
        title_en: 'T',
        title_it: 'T',
        image: 'https://x.test/a.webp',
        description_en: 'd',
        description_it: 'd',
        body_en: '# en',
        body_it: '# it',
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
      },
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
  });
});

describe('blog dual-write: review hardening', () => {
  const FORGED_EN = `blog/999/en/${'f'.repeat(64)}.md`;
  const FORGED_IT = `blog/999/it/${'f'.repeat(64)}.md`;

  const seededRow = () => ({
    blog_posts: [
      {
        id: 7,
        title_en: 'T',
        body_en: '# old en',
        body_it: '# old it',
        body_en_path: `blog/7/en/${'a'.repeat(64)}.md`,
        body_it_path: `blog/7/it/${'b'.repeat(64)}.md`,
        image: '',
        hidden: false,
      },
    ],
  });

  it('rejects forged pointers on batch CREATE before any mutation', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] });
    const itemData = { ...blogCreate().data, body_en_path: FORGED_EN };
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [{ ...blogCreate(), data: itemData }],
      updates: [],
      deletes: [],
    });
    expect(result.success).toBe(false);
    // Test boundary: batch actions put BatchCommitEvidence in `data`.
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain('server-generated');
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('rejects forged pointers on batch UPDATE before any mutation', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seededRow());
    const forgedUpdate = { body_en: '# new', body_en_path: FORGED_EN };
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [{ id: 7, data: forgedUpdate }],
      deletes: [],
    });
    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(`blog/7/en/${'a'.repeat(64)}.md`);
    expect(row?.body_en).toBe('# old en');
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('rejects forged pointers on single-shot CREATE', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] });
    const payload = { ...blogCreate().data, body_en_path: FORGED_EN };
    const result = await blogActions({ type: 'CREATE', data: payload });
    expect(result.success).toBe(false);
    expect(result.error).toContain('server-generated');
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
  });

  it('rejects forged pointers on single-shot UPDATE', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seededRow());
    const payload = { body_it: '# new it', body_it_path: FORGED_IT };
    const result = await blogActions({ type: 'UPDATE', id: 7, data: payload });
    expect(result.success).toBe(false);
    expect(result.error).toContain('server-generated');
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_it_path).toBe(`blog/7/it/${'b'.repeat(64)}.md`);
  });

  it('removes only the newly uploaded cover when the Markdown upload fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    const oldCover = `https://fake.supabase.co/storage/v1/object/public/website-dev/blog/7/old.webp`;
    h.fake = fake(
      {
        blog_posts: [
          {
            ...seededRow().blog_posts[0],
            image: oldCover,
          },
        ],
      },
      { failUpload: { pathIncludes: '.md', message: 'bucket down' } }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [{ id: 7, data: { body_en: '# new en' }, file: webpFile() }],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const uploadedCover = h.fake.state.uploads[0];
    expect(uploadedCover).toBeTruthy();
    expect(h.fake.state.removed).toEqual([uploadedCover]);
    // Previous committed state and its cover remain intact.
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.image).toBe(oldCover);
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_en_path).toBe(`blog/7/en/${'a'.repeat(64)}.md`);
  });

  it('cleans staged assets after a successful provisional rollback', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] }, {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });
    expect(result.success).toBe(false);
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    // The staged cover is removed once the row is confirmed gone.
    expect(h.fake.state.removed.length).toBeGreaterThan(0);
  });

  it('retains assets and reports the row when the provisional rollback fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] }, {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
      failNext: { table: 'blog_posts', mode: 'delete', message: 'delete blocked' },
    });
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row).toBeDefined();
    expect(row?.hidden).toBe(true);
    // A surviving row may reference the assets, so nothing is deleted.
    expect(h.fake.state.removed).toEqual([]);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain(
      `provisional row ${row?.id as number}`
    );
    expect(evidence.failed[0]?.error).toContain('manual reconciliation');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('fails the create when the final commit matches zero rows', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ blog_posts: [] }, {
      failNext: {
        table: 'blog_posts',
        mode: 'update',
        message: 'no rows',
        zeroRows: true,
      },
    });
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.created).toEqual([]);
    expect(evidence.createdIds).toEqual({});
    expect(evidence.failed[0]?.error).toContain('expected exactly 1');
    // Rolled back, never reported as created.
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
  type Row,
} from '@/testing/unit/supabaseFake';
import { staticWebpFile } from '@/testing/unit/fileFixtures';

/**
 * Blog WRITE path: Storage-only Markdown (no dual write). Uses the established
 * fake Supabase / fake Storage harness — no network, no real bucket.
 *
 * The content bucket is `website-content-dev` and the public asset bucket stays
 * `website-dev`, so object keys distinguish them. The invariant under test is
 * the order of operations: objects first (immutably, hash-verified), then ONE
 * pointer commit guarded on the pointer this save observed.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  invalidate: vi.fn(async (): Promise<'sent' | 'failed' | 'skipped'> => 'sent'),
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

import { blogActions } from '@/app/actions/cms/sections/blogActions';
import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];
const CONTENT = 'website-content-dev/';

function pathFor(
  markdown: string,
  locale: 'en' | 'it' = 'en',
  postId = 7
): string {
  return `blog/${postId}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

function fake(
  tables: Record<string, Row[]> = {},
  extra: Partial<Parameters<typeof createFakeSupabase>[0]> = {}
): FakeSupabase {
  return createFakeSupabase({
    tables: { cms_allowed_users: EDITOR, ...tables },
    ...extra,
  });
}

function blogCreate(
  bodyEn = '# en body',
  bodyIt = '# it body',
  extra: Row = {}
) {
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
      ...extra,
    },
    file: staticWebpFile(),
    tempId: 'c1',
  };
}

/** Content-bucket object keys (the Markdown), as opposed to asset objects. */
function contentKeys(store: FakeSupabase): string[] {
  return Object.keys(store.state.objects).filter((key) =>
    key.startsWith(CONTENT)
  );
}

/** Records every Storage call the action makes, uploads and downloads. */
function instrument(store: FakeSupabase): {
  uploads: string[];
  downloads: string[];
} {
  const calls = { uploads: [] as string[], downloads: [] as string[] };
  const storage = store.client.storage;
  const originalFrom = storage.from.bind(storage);
  storage.from = (bucket: string) => {
    const api = originalFrom(bucket) as unknown as {
      upload(path: string, data: unknown, options?: unknown): Promise<unknown>;
      download(path: string): Promise<unknown>;
    };
    const originalUpload = api.upload.bind(api);
    const originalDownload = api.download.bind(api);
    api.upload = (path, data, options) => {
      calls.uploads.push(`${bucket}/${path}`);
      return originalUpload(path, data, options);
    };
    api.download = (path) => {
      calls.downloads.push(`${bucket}/${path}`);
      return originalDownload(path);
    };
    return api as never;
  };
  return calls;
}

/**
 * Simulates another editor committing BETWEEN this save's read and its guarded
 * commit: the mutation runs right after the first Markdown object is uploaded.
 */
function raceAfterContentUpload(store: FakeSupabase, mutate: () => void): void {
  const storage = store.client.storage;
  const originalFrom = storage.from.bind(storage);
  let fired = false;
  storage.from = (bucket: string) => {
    const api = originalFrom(bucket) as unknown as {
      upload(path: string, data: unknown, options?: unknown): Promise<unknown>;
    };
    const originalUpload = api.upload.bind(api);
    api.upload = async (path, data, options) => {
      const result = await originalUpload(path, data, options);
      if (!fired && path.endsWith('.md')) {
        fired = true;
        mutate();
      }
      return result;
    };
    return api as never;
  };
}

function blogUpdate(data: Record<string, unknown>) {
  return { id: 7, data, currentImageUrl: undefined };
}

function seeded(overrides: Row = {}): Record<string, Row[]> {
  return {
    blog_posts: [
      {
        id: 7,
        title_en: 'T',
        title_it: 'T',
        image: '',
        description_en: 'd',
        description_it: 'd',
        // Retired columns: whatever a pre-migration row happens to hold.
        body_en: '# old en',
        body_it: '# old it',
        body_en_path: pathFor('# old en'),
        body_it_path: pathFor('# old it', 'it'),
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
        hidden: false,
        ...overrides,
      },
    ],
  };
}

beforeEach(() => {
  h.invalidate.mockReset();
  h.invalidate.mockResolvedValue('sent');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
});

describe('blog create: unknown id', () => {
  it('uploads the objects, then commits both pointers and the visibility', async () => {
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('# en final', '# it final')],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    const id = row?.id as number;
    expect(row?.body_en_path).toBe(pathFor('# en final', 'en', id));
    expect(row?.body_it_path).toBe(pathFor('# it final', 'it', id));
    expect(row?.hidden).toBe(false);
    // The contracted row names no legacy body column at all.
    expect(Object.hasOwn(row ?? {}, 'body_en')).toBe(false);
    expect(Object.hasOwn(row ?? {}, 'body_it')).toBe(false);
    // Objects hold the exact final bytes.
    const enKey = `${CONTENT}${row?.body_en_path as string}`;
    expect((h.fake.state.objects[enKey] as Buffer).toString('utf8')).toBe(
      '# en final'
    );
    // Invalidation happens once, after the commit.
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('stays hidden until the pointers commit, and honours the requested visibility', async () => {
    h.fake = fake({ blog_posts: [] });

    await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('# en', '# it')],
      updates: [],
      deletes: [],
    });

    const writes = h.fake.state.log.filter(
      (entry) => entry.table === 'blog_posts'
    );
    const insert = writes[0]?.payload as Row;
    expect(insert.hidden).toBe(true);
    expect(Object.hasOwn(insert, 'body_en')).toBe(false);
    expect(Object.hasOwn(insert, 'body_it')).toBe(false);
    expect(insert.body_en_path).toBeUndefined();
    // Visibility and the pointers are committed by the SAME statement.
    const commit = writes[1]?.payload as Row;
    expect(commit.hidden).toBe(false);
    expect(commit.body_en_path).toBe(
      h.fake.state.tables.blog_posts[0]?.body_en_path
    );
  });

  it('keeps an explicitly hidden post hidden after the commit', async () => {
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('# en', '# it', { hidden: true })],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    expect(h.fake.state.tables.blog_posts[0]?.hidden).toBe(true);
  });

  it('leaves no pointer behind when the upload fails', async () => {
    h.fake = fake(
      { blog_posts: [] },
      { failUpload: { pathIncludes: '.md', message: 'bucket down' } }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    expect(contentKeys(h.fake)).toEqual([]);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('rolls the provisional row back when the guarded commit conflicts', async () => {
    h.fake = fake(
      { blog_posts: [] },
      {
        failNext: {
          table: 'blog_posts',
          mode: 'update',
          message: 'no rows',
          zeroRows: true,
        },
      }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.createdIds).toEqual({});
    expect(evidence.failed[0]?.error).toContain('Conflicting concurrent edit');
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('rejects forged pointers before any mutation', async () => {
    h.fake = fake({ blog_posts: [] });
    const forged = `blog/999/en/${'f'.repeat(64)}.md`;
    const poisoned = { ...blogCreate().data, body_en_path: forged };

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [{ ...blogCreate(), data: poisoned }],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain('server-generated');
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    expect(contentKeys(h.fake)).toEqual([]);
  });
});

describe('blog edit', () => {
  it('edits EN only: the IT pointer and the IT column stay untouched', async () => {
    h.fake = fake(seeded());

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(pathFor('# new en'));
    expect(row?.body_it_path).toBe(pathFor('# old it', 'it'));
    // A pre-existing legacy value is left exactly as it was: the save writes no
    // legacy body column.
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_it).toBe('# old it');
    // The committed statement names ONLY the EN pointer: an EN edit can never
    // write the IT pointer, not even with its unchanged value.
    const update = h.fake.state.log
      .filter((entry) => entry.table === 'blog_posts')
      .at(-1)?.payload as Row;
    expect(update.body_en_path).toBe(pathFor('# new en'));
    expect(Object.hasOwn(update, 'body_en')).toBe(false);
    expect(Object.hasOwn(update, 'body_it')).toBe(false);
    expect(Object.hasOwn(update, 'body_it_path')).toBe(false);
    // One immutable object written; its bytes are the new Markdown.
    const enKey = `${CONTENT}${row?.body_en_path as string}`;
    expect((h.fake.state.objects[enKey] as Buffer).toString('utf8')).toBe(
      '# new en'
    );
  });

  it('makes zero Storage calls for a metadata-only update', async () => {
    h.fake = fake(seeded());
    const calls = instrument(h.fake);

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ title_en: 'Renamed', hidden: true })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual({ uploads: [], downloads: [] });
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(pathFor('# old en'));
    expect(row?.body_it_path).toBe(pathFor('# old it', 'it'));
    expect(row?.body_en).toBe('# old en');
    expect(row?.title_en).toBe('Renamed');
    expect(row?.hidden).toBe(true);
  });

  it('rejects a spoofed cover before any storage write or DB commit', async () => {
    h.fake = fake(seeded());
    const calls = instrument(h.fake);
    const before = { ...h.fake.state.tables.blog_posts[0] };
    const spoofed = new File(
      [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      'cover.webp',
      { type: 'image/webp' }
    );

    const result = await blogActions({
      type: 'UPLOAD_IMAGE',
      blogId: 7,
      file: spoofed,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SVG and HTML/i);
    expect(calls).toEqual({ uploads: [], downloads: [] });
    expect(h.fake.state.tables.blog_posts[0]).toEqual(before);
  });

  it('uploads nothing when the body bytes already match the committed pointer', async () => {
    h.fake = fake(seeded());
    const calls = instrument(h.fake);

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# old en' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    expect(calls.uploads).toEqual([]);
    expect(h.fake.state.tables.blog_posts[0]?.body_en_path).toBe(
      pathFor('# old en')
    );
  });

  it('leaves the previous pointer and reports a conflict when the guarded commit matches nothing', async () => {
    h.fake = fake(seeded(), {
      failNext: {
        table: 'blog_posts',
        mode: 'update',
        message: 'no rows',
        zeroRows: true,
      },
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(pathFor('# old en'));
    expect(row?.body_en).toBe('# old en');
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain('Conflicting concurrent edit');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('loses cleanly to a concurrent edit of the same locale', async () => {
    h.fake = fake(seeded());
    const concurrent = pathFor('# someone else');
    raceAfterContentUpload(h.fake, () => {
      h.fake.state.tables.blog_posts[0].body_en_path = concurrent;
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    // The concurrent pointer survives; this save wrote nothing.
    expect(h.fake.state.tables.blog_posts[0]?.body_en_path).toBe(concurrent);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain('Conflicting concurrent edit');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('keeps an EN-only edit when a concurrent IT edit lands first', async () => {
    h.fake = fake(seeded());
    const concurrentIt = pathFor('# concurrent it', 'it');
    raceAfterContentUpload(h.fake, () => {
      h.fake.state.tables.blog_posts[0].body_it_path = concurrentIt;
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(pathFor('# new en'));
    expect(row?.body_it_path).toBe(concurrentIt);
  });

  it('leaves the row untouched when the Markdown upload fails', async () => {
    h.fake = fake(seeded(), {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_en_path).toBe(pathFor('# old en'));
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('removes only the newly uploaded cover when the Markdown upload fails', async () => {
    const oldCover =
      'https://fake.supabase.co/storage/v1/object/public/website-dev/blog/7/old.webp';
    h.fake = fake(seeded({ image: oldCover }), {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [
        { id: 7, data: { body_en: '# new en' }, file: staticWebpFile() },
      ],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const uploadedCover = h.fake.state.uploads[0];
    expect(uploadedCover).toBeTruthy();
    expect(h.fake.state.removed).toEqual([uploadedCover]);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.image).toBe(oldCover);
    expect(row?.body_en_path).toBe(pathFor('# old en'));
  });

  it('retains assets and reports the row when the provisional rollback fails', async () => {
    h.fake = fake(
      { blog_posts: [] },
      {
        failUpload: { pathIncludes: '.md', message: 'bucket down' },
        failNext: {
          table: 'blog_posts',
          mode: 'delete',
          message: 'delete blocked',
        },
      }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.hidden).toBe(true);
    expect(row?.body_en_path).toBeUndefined();
    expect(h.fake.state.removed).toEqual([]);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain('manual reconciliation');
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

describe('blog single-shot writes', () => {
  it('creates hidden, then commits the pointers and the visibility', async () => {
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
      },
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    const id = row?.id as number;
    expect(row?.hidden).toBe(false);
    expect(row?.body_en_path).toBe(pathFor('# single en', 'en', id));
    expect(row?.body_it_path).toBe(pathFor('# single it', 'it', id));
    expect(Object.hasOwn(row ?? {}, 'body_en')).toBe(false);
    expect(Object.hasOwn(row ?? {}, 'body_it')).toBe(false);
    const insert = h.fake.state.log.find((entry) => entry.mode === 'insert')
      ?.payload as Row;
    expect(insert.hidden).toBe(true);
  });

  it('deletes the provisional row when the pointer commit fails', async () => {
    h.fake = fake(
      { blog_posts: [] },
      {
        failNext: {
          table: 'blog_posts',
          mode: 'update',
          message: 'no rows',
          zeroRows: true,
        },
      }
    );

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
    expect(result.error).toContain('Conflicting concurrent edit');
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('updates only the edited locale pointer', async () => {
    h.fake = fake(seeded());

    const result = await blogActions({
      type: 'UPDATE',
      id: 7,
      data: { body_it: '# new it' },
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.blog_posts[0];
    expect(row?.body_it_path).toBe(pathFor('# new it', 'it'));
    expect(row?.body_en_path).toBe(pathFor('# old en'));
    expect(row?.body_en).toBe('# old en');
  });

  it('reports a conflict without invalidating, keeping the previous pointer', async () => {
    h.fake = fake(seeded(), {
      failNext: {
        table: 'blog_posts',
        mode: 'update',
        message: 'no rows',
        zeroRows: true,
      },
    });

    const result = await blogActions({
      type: 'UPDATE',
      id: 7,
      data: { body_en: '# new en' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Conflicting concurrent edit');
    expect(h.fake.state.tables.blog_posts[0]?.body_en_path).toBe(
      pathFor('# old en')
    );
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('commits and reports a failed invalidation as retryable', async () => {
    h.fake = fake(seeded());
    h.invalidate.mockResolvedValueOnce('failed');

    const first = await blogActions({
      type: 'UPDATE',
      id: 7,
      data: { body_en: '# new en' },
    });

    // The write is committed; only the cache propagation failed.
    expect(first.success).toBe(true);
    expect(first.revalidation).toBe('failed');
    expect(h.fake.state.tables.blog_posts[0]?.body_en_path).toBe(
      pathFor('# new en')
    );

    // Retrying the same edit is a no-op for Storage and reaches the public site.
    const calls = instrument(h.fake);
    const retry = await blogActions({
      type: 'UPDATE',
      id: 7,
      data: { body_en: '# new en' },
    });
    expect(retry.success).toBe(true);
    expect(retry.revalidation).toBe('sent');
    expect(calls.uploads).toEqual([]);
  });

  it('rejects forged pointers before any mutation', async () => {
    h.fake = fake(seeded());
    const poisoned = {
      body_it: '# new it',
      body_it_path: `blog/7/it/${'f'.repeat(64)}.md`,
    };

    const result = await blogActions({
      type: 'UPDATE',
      id: 7,
      data: poisoned,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('server-generated');
    expect(h.fake.state.tables.blog_posts[0]?.body_it_path).toBe(
      pathFor('# old it', 'it')
    );
  });
});

describe('blog delete', () => {
  it('invalidates after the delete and leaves content objects to the GC', async () => {
    h.fake = fake(seeded());
    // A committed body object for the row being deleted.
    const objectKey = `${CONTENT}${pathFor('# old en')}`;
    h.fake.state.objects[objectKey] = Buffer.from('# old en', 'utf8');

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [],
      deletes: [7],
    });

    expect(result.success).toBe(true);
    expect(h.fake.state.tables.blog_posts ?? []).toEqual([]);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    // The write path never deletes content-bucket Markdown: the GC owns it.
    expect(h.fake.state.objects[objectKey]).toBeDefined();
    expect(h.fake.state.removed).not.toContain(pathFor('# old en'));
  });
});

/**
 * The contraction has run: `body_en`/`body_it` no longer exist, so the write
 * path must name no legacy column at all. The value of these tests is the
 * NEGATIVE assertion — the committed statements are inspected key by key —
 * because the fake cannot enforce a schema the way Postgres does.
 */
describe('no legacy body column in any committed statement', () => {
  it('creates a post without naming body_en or body_it anywhere', async () => {
    h.fake = fake({ blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('# en final', '# it final')],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const writes = h.fake.state.log.filter(
      (entry) => entry.table === 'blog_posts'
    );
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const write of writes) {
      expect(Object.hasOwn(write.payload as Row, 'body_en')).toBe(false);
      expect(Object.hasOwn(write.payload as Row, 'body_it')).toBe(false);
    }
    const row = h.fake.state.tables.blog_posts[0] as Row;
    expect(Object.hasOwn(row, 'body_en')).toBe(false);
    const id = row.id as number;
    expect(row.body_en_path).toBe(pathFor('# en final', 'en', id));
    expect(row.body_it_path).toBe(pathFor('# it final', 'it', id));
    expect(row.hidden).toBe(false);
  });

  it('saves an EN body without naming body_en in the guarded UPDATE', async () => {
    h.fake = fake(seeded());

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [blogUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const update = h.fake.state.log
      .filter((entry) => entry.table === 'blog_posts')
      .at(-1)?.payload as Row;
    expect(update.body_en_path).toBe(pathFor('# new en'));
    expect(Object.hasOwn(update, 'body_en')).toBe(false);
    expect(Object.hasOwn(update, 'body_it')).toBe(false);
    // A pre-existing legacy value is left exactly as it was; the pointer is the
    // committed body state.
    expect(h.fake.state.tables.blog_posts[0]?.body_en).toBe('# old en');
  });
});

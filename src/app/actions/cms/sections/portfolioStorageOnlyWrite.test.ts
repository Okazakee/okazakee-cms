import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
  type Row,
} from '@/testing/unit/supabaseFake';

/**
 * Portfolio WRITE path: Storage-only Markdown. Same invariants as the blog
 * suite (objects first, then ONE guarded pointer commit), plus the delete
 * hand-off: the write path invalidates caches and deletes only ASSET objects,
 * leaving content-bucket Markdown to the Storage garbage collector.
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

import { portfolioActions } from '@/app/actions/cms/sections/portfolioActions';
import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];
const CONTENT = 'website-content-dev/';
const SHIM_PLACEHOLDER = '[content moved to object storage]';

function pathFor(
  markdown: string,
  locale: 'en' | 'it' = 'en',
  postId = 11
): string {
  return `portfolio/${postId}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

function webpFile(name = 'image.webp'): File {
  return new File(
    [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])],
    name,
    {
      type: 'image/webp',
    }
  );
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

function portfolioCreate(
  bodyEn = '# en body',
  bodyIt = '# it body',
  extra: Row = {}
) {
  return {
    data: {
      title_en: 'P',
      title_it: 'P',
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
    file: webpFile(),
    tempId: 'p1',
  };
}

function portfolioUpdate(data: Record<string, unknown>) {
  return { id: 11, data, currentImageUrl: undefined };
}

function seeded(overrides: Row = {}): Record<string, Row[]> {
  return {
    portfolio_posts: [
      {
        id: 11,
        title_en: 'P',
        title_it: 'P',
        image: '',
        description_en: 'd',
        description_it: 'd',
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

beforeEach(() => {
  h.invalidate.mockReset();
  h.invalidate.mockResolvedValue('sent');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
});

describe('portfolio create: unknown id', () => {
  it('uploads the objects, then commits both pointers and the visibility', async () => {
    h.fake = fake({ portfolio_posts: [] });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate('# en final', '# it final')],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    const id = row?.id as number;
    expect(row?.body_en_path).toBe(pathFor('# en final', 'en', id));
    expect(row?.body_it_path).toBe(pathFor('# it final', 'it', id));
    expect(row?.hidden).toBe(false);
    expect(row?.body_en).toBe(SHIM_PLACEHOLDER);
    expect(row?.body_it).toBeUndefined();
    const enKey = `${CONTENT}${row?.body_en_path as string}`;
    expect((h.fake.state.objects[enKey] as Buffer).toString('utf8')).toBe(
      '# en final'
    );
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('stays hidden until the pointers commit', async () => {
    h.fake = fake({ portfolio_posts: [] });

    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    const writes = h.fake.state.log.filter(
      (entry) => entry.table === 'portfolio_posts'
    );
    const insert = writes[0]?.payload as Row;
    expect(insert.hidden).toBe(true);
    expect(insert.body_en_path).toBeUndefined();
    const commit = writes[1]?.payload as Row;
    expect(commit.hidden).toBe(false);
    expect(commit.body_en_path).toBe(
      h.fake.state.tables.portfolio_posts[0]?.body_en_path
    );
  });

  it('leaves no pointer behind when the upload fails', async () => {
    h.fake = fake(
      { portfolio_posts: [] },
      { failUpload: { pathIncludes: '.md', message: 'bucket down' } }
    );

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

describe('portfolio edit', () => {
  it('edits EN only and leaves the IT pointer untouched', async () => {
    h.fake = fake(seeded());

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [portfolioUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toBe(pathFor('# new en'));
    expect(row?.body_it_path).toBe(pathFor('# old it', 'it'));
    expect(row?.body_en).toBe(SHIM_PLACEHOLDER);
    expect(row?.body_it).toBe('# old it');
    // The committed statement names ONLY the EN pointer.
    const update = h.fake.state.log
      .filter((entry) => entry.table === 'portfolio_posts')
      .at(-1)?.payload as Row;
    expect(update.body_en_path).toBe(pathFor('# new en'));
    expect(Object.hasOwn(update, 'body_it_path')).toBe(false);
  });

  it('makes zero Storage calls for a metadata-only update', async () => {
    h.fake = fake(seeded());
    const calls = instrument(h.fake);

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [portfolioUpdate({ title_en: 'Renamed' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual({ uploads: [], downloads: [] });
    expect(h.fake.state.tables.portfolio_posts[0]?.body_en_path).toBe(
      pathFor('# old en')
    );
  });

  it('uploads nothing when the body bytes already match the committed pointer', async () => {
    h.fake = fake(seeded());
    const calls = instrument(h.fake);

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [portfolioUpdate({ body_it: '# old it' })],
      deletes: [],
    });

    expect(result.success).toBe(true);
    expect(calls.uploads).toEqual([]);
    expect(h.fake.state.tables.portfolio_posts[0]?.body_it_path).toBe(
      pathFor('# old it', 'it')
    );
  });

  it('keeps the previous pointer and reports a conflict when the commit matches nothing', async () => {
    h.fake = fake(seeded(), {
      failNext: {
        table: 'portfolio_posts',
        mode: 'update',
        message: 'no rows',
        zeroRows: true,
      },
    });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [portfolioUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.portfolio_posts[0];
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
      h.fake.state.tables.portfolio_posts[0].body_en_path = concurrent;
    });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [portfolioUpdate({ body_en: '# new en' })],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.tables.portfolio_posts[0]?.body_en_path).toBe(
      concurrent
    );
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

describe('portfolio single-shot writes', () => {
  it('creates hidden, then commits the pointers and the visibility', async () => {
    h.fake = fake({ portfolio_posts: [] });

    const result = await portfolioActions({
      type: 'CREATE',
      data: {
        title_en: 'P',
        title_it: 'P',
        image: 'https://x.test/p.webp',
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
    const row = h.fake.state.tables.portfolio_posts[0];
    const id = row?.id as number;
    expect(row?.hidden).toBe(false);
    expect(row?.body_en_path).toBe(pathFor('# single en', 'en', id));
    expect(row?.body_it_path).toBe(pathFor('# single it', 'it', id));
    const insert = h.fake.state.log.find((entry) => entry.mode === 'insert')
      ?.payload as Row;
    expect(insert.hidden).toBe(true);
  });
});

describe('portfolio delete', () => {
  it('invalidates after the delete and leaves content objects to the GC', async () => {
    h.fake = fake(seeded());
    const objectKey = `${CONTENT}${pathFor('# old en')}`;
    h.fake.state.objects[objectKey] = Buffer.from('# old en', 'utf8');

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [],
      deletes: [11],
    });

    expect(result.success).toBe(true);
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.fake.state.objects[objectKey]).toBeDefined();
    expect(h.fake.state.removed).not.toContain(pathFor('# old en'));
  });
});

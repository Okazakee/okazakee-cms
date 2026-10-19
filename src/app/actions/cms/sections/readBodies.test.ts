import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

/**
 * GET_BODIES dispatcher contract (blog + portfolio) after the legacy-body
 * retirement: Storage is the only body store.
 *
 * Uses the established in-process fake Supabase/Storage boundary, so the real
 * action is exercised end to end: environment/bucket resolution, the query
 * projection (which must never name `body_en`/`body_it` again), authorization,
 * EN/IT independence and every integrity failure.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.fake.client,
}));
vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.fake.client,
}));
vi.mock('@/libs/public-site/revalidation', () => ({
  invalidatePublicContent: vi.fn(async () => 'sent' as const),
}));
vi.mock('next/cache', () => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({ hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })),
}));

import { blogActions } from '@/app/actions/cms/sections/blogActions';
import { portfolioActions } from '@/app/actions/cms/sections/portfolioActions';
import type { MutationResult } from '@/libs/cms/mutationResult';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';
import {
  CONTENT_BUCKET_DEV,
  CONTENT_BUCKET_PROD,
} from '@/libs/cms/storage/contentBucket';
import { POST_BODY_POINTER_COLUMNS } from '@/libs/cms/storage/postBodyRead';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];

type EntityName = 'blog' | 'portfolio';
type Locale = 'en' | 'it';

const ENTITIES = [
  {
    name: 'blog' as EntityName,
    table: 'blog_posts',
    run: (id: number): Promise<MutationResult> =>
      blogActions({ type: 'GET_BODIES', id }),
  },
  {
    name: 'portfolio' as EntityName,
    table: 'portfolio_posts',
    run: (id: number): Promise<MutationResult> =>
      portfolioActions({ type: 'GET_BODIES', id }),
  },
];

function hashOf(markdown: string): string {
  return sha256Hex(Buffer.from(markdown, 'utf8'));
}

function pointerPath(
  kind: EntityName,
  postId: number,
  locale: Locale,
  markdown: string
): string {
  return `${kind}/${postId}/${locale}/${hashOf(markdown)}.md`;
}

function objectKey(
  bucket: string,
  kind: EntityName,
  postId: number,
  locale: Locale,
  markdown: string
): string {
  return `${bucket}/${pointerPath(kind, postId, locale, markdown)}`;
}

/** Records the projection of every query and every Storage download. */
function instrument(store: FakeSupabase): {
  selects: Array<{ table: string; columns: string }>;
  downloads: string[];
} {
  const selects: Array<{ table: string; columns: string }> = [];
  const downloads: string[] = [];
  const client = store.client as unknown as {
    from: (table: string) => { select: (columns?: string) => unknown };
    storage: {
      from: (bucket: string) => { download: (path: string) => unknown };
    };
  };

  const originalFrom = client.from.bind(store.client);
  client.from = (table: string) => {
    const builder = originalFrom(table);
    const originalSelect = builder.select.bind(builder);
    builder.select = (columns?: string) => {
      selects.push({ table, columns: columns ?? '*' });
      return originalSelect(columns);
    };
    return builder;
  };

  const storage = client.storage;
  const originalBucket = storage.from.bind(storage);
  storage.from = (bucket: string) => {
    const api = originalBucket(bucket);
    const originalDownload = api.download.bind(api);
    api.download = (path: string) => {
      downloads.push(`${bucket}/${path}`);
      return originalDownload(path);
    };
    return api;
  };

  return { selects, downloads };
}

function fake(
  tables: Record<string, Array<Record<string, unknown>>>,
  options: { user?: { id: string; email: string } | null } = {}
): FakeSupabase {
  return createFakeSupabase({
    tables: { cms_allowed_users: EDITOR, ...tables },
    ...options,
  });
}

/** The row read path: metadata the editor ignores plus the canonical pointers. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    body_en_path: null,
    body_it_path: null,
    hidden: false,
    ...overrides,
  };
}

function seedObject(
  store: FakeSupabase,
  bucket: string,
  kind: EntityName,
  locale: Locale,
  markdown: string,
  bytes: string = markdown
): void {
  store.state.objects[objectKey(bucket, kind, 7, locale, markdown)] =
    Buffer.from(bytes, 'utf8');
}

function projectionFor(
  selects: Array<{ table: string; columns: string }>,
  table: string
): string[] {
  return selects.filter((entry) => entry.table === table).map((e) => e.columns);
}

/** Every column named by any query, split so `body_en_path` is not confused
 * with the retired `body_en`. */
function selectedColumns(
  selects: Array<{ table: string; columns: string }>
): string[] {
  return selects.flatMap((entry) =>
    entry.columns.split(',').map((column) => column.trim())
  );
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
});

describe.each(ENTITIES)('GET_BODIES ($name)', (entity) => {
  it('hydrates both languages from the dev content bucket', async () => {
    const en = '# storage en';
    const it = '# storage it';
    h.fake = fake({
      [entity.table]: [
        row({
          body_en_path: pointerPath(entity.name, 7, 'en', en),
          body_it_path: pointerPath(entity.name, 7, 'it', it),
        }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', en);
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'it', it);
    const { selects, downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result).toEqual({
      success: true,
      data: { id: 7, body_en: en, body_it: it },
    });
    expect(projectionFor(selects, entity.table)).toEqual([
      POST_BODY_POINTER_COLUMNS,
    ]);
    expect(downloads).toEqual([
      `${CONTENT_BUCKET_DEV}/${pointerPath(entity.name, 7, 'en', en)}`,
      `${CONTENT_BUCKET_DEV}/${pointerPath(entity.name, 7, 'it', it)}`,
    ]);
  });

  it('never names the retired PostgreSQL body columns in any query', async () => {
    const en = '# storage en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', en) }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', en);
    const { selects } = instrument(h.fake);

    await entity.run(7);

    const columns = selectedColumns(selects);
    expect(columns).not.toContain('body_en');
    expect(columns).not.toContain('body_it');
    expect(columns).toContain('body_en_path');
  });

  it('resolves the production bucket for a production process', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    const en = '# prod en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', en) }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_PROD, entity.name, 'en', en);
    const { downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.data).toEqual({ id: 7, body_en: en, body_it: '' });
    expect(downloads).toEqual([
      `${CONTENT_BUCKET_PROD}/${pointerPath(entity.name, 7, 'en', en)}`,
    ]);
  });

  it('resolves each language independently', async () => {
    const en = '# storage en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', en) }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', en);
    const { downloads } = instrument(h.fake);

    const result = await entity.run(7);

    // IT has no committed object, so it resolves to an empty body without a
    // download and without touching the retired IT column.
    expect(result.data).toEqual({ id: 7, body_en: en, body_it: '' });
    expect(downloads).toHaveLength(1);
  });

  it('returns empty strings for a post with no committed pointer', async () => {
    // A row created before its first content save: the pointers stay nullable,
    // and the editor must still receive loaded (empty) bodies, never null.
    h.fake = fake({ [entity.table]: [row()] });
    const { downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.data).toEqual({ id: 7, body_en: '', body_it: '' });
    expect(downloads).toEqual([]);
  });

  it('preserves exact Unicode and newlines end to end', async () => {
    const markdown = '# Tïtolo 🎉\r\n\r\n“virgolette” — ok\n\n';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', markdown) }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', markdown);

    const result = await entity.run(7);

    expect(result.data).toEqual({ id: 7, body_en: markdown, body_it: '' });
    // The exact byte length survives, so nothing trimmed or normalized the body.
    const data = result.data as { body_en: string };
    expect(data.body_en.length).toBe(markdown.length);
  });

  it('fails rather than returning an empty body when the object is missing', async () => {
    const en = '# storage en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', en) }),
      ],
    });

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Object not found');
  });

  it('fails when the stored bytes do not hash to the pointer', async () => {
    const en = '# storage en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', en) }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', en, '# tampered');

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('integrity failure');
  });

  it('fails on a malformed pointer instead of serving another post', async () => {
    const other = '# another post';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 8, 'en', other) }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', other);

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('does not belong to');
  });

  it('rejects an incompatible environment before any DB or Storage call', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    h.fake = fake({ [entity.table]: [row()] });
    const { downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(
      'refusing to resolve a content bucket'
    );
    // Nothing reached the database or the bucket.
    expect(h.fake.state.log).toEqual([]);
    expect(downloads).toEqual([]);
  });

  it('includes hidden drafts for an authorized CMS user', async () => {
    const en = '# hidden draft';
    h.fake = fake({
      [entity.table]: [
        row({
          hidden: true,
          body_en_path: pointerPath(entity.name, 7, 'en', en),
        }),
      ],
    });
    seedObject(h.fake, CONTENT_BUCKET_DEV, entity.name, 'en', en);

    const result = await entity.run(7);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 7, body_en: en, body_it: '' });
  });

  it('reports a missing post', async () => {
    h.fake = fake({ [entity.table]: [] });

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found$/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'rejects the invalid post id %s',
    async (id) => {
      h.fake = fake({ [entity.table]: [row()] });

      const result = await entity.run(id);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid post id');
    }
  );

  it('rejects an unauthenticated caller', async () => {
    h.fake = fake({ [entity.table]: [row()] }, { user: null });

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Unauthorized');
  });

  it('rejects an authenticated user who is not allowlisted', async () => {
    h.fake = fake(
      { [entity.table]: [row()] },
      {
        user: { id: 'intruder', email: 'intruder@example.com' },
      }
    );

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('permission');
  });
});

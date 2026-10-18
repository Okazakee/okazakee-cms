import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

/**
 * Phase 9A GET_BODIES dispatcher contract (blog + portfolio).
 *
 * Uses the established in-process fake Supabase/Storage boundary, so the real
 * action is exercised end to end: gate resolution, the runtime query projection,
 * authorization, legacy/Storage precedence and every integrity failure.
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
import { BODY_STORAGE_READ_FLAG } from '@/libs/cms/bodyRead';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';
import type { MutationResult } from '@/libs/cms/mutationResult';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];
const CONTENT_BUCKET = 'website-content-dev';
const LEGACY_EN = '# legacy en';
const LEGACY_IT = '# legacy it';

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
  kind: EntityName,
  postId: number,
  locale: Locale,
  markdown: string
): string {
  return `${CONTENT_BUCKET}/${pointerPath(kind, postId, locale, markdown)}`;
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
    storage: { from: (bucket: string) => { download: (path: string) => unknown } };
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

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    image: '',
    body_en: LEGACY_EN,
    body_it: LEGACY_IT,
    body_en_path: null,
    body_it_path: null,
    hidden: false,
    ...overrides,
  };
}

function seedObject(
  store: FakeSupabase,
  kind: EntityName,
  locale: Locale,
  markdown: string
): void {
  store.state.objects[objectKey(kind, 7, locale, markdown)] = Buffer.from(
    markdown,
    'utf8'
  );
}

function projectionFor(
  selects: Array<{ table: string; columns: string }>,
  table: string
): string[] {
  return selects.filter((entry) => entry.table === table).map((e) => e.columns);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
  vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'false');
  vi.stubEnv(BODY_STORAGE_READ_FLAG, 'false');
});

describe.each(ENTITIES)('GET_BODIES ($name)', (entity) => {
  it('reads the legacy columns by default, ignoring a committed pointer', async () => {
    const stored = '# stored en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en_path: pointerPath(entity.name, 7, 'en', stored) }),
      ],
    });
    seedObject(h.fake, entity.name, 'en', stored);
    const { selects, downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 7,
      body_en: LEGACY_EN,
      body_it: LEGACY_IT,
    });
    // The projection never names the pointer columns, so they cannot be read.
    expect(projectionFor(selects, entity.table)).toEqual([
      'id, body_en, body_it',
    ]);
    // Legacy-only content takes no Storage call at all.
    expect(downloads).toEqual([]);
  });

  it('serves both languages from Storage when enabled in the dev clone', async () => {
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    const en = '# storage en';
    const it = '# storage it';
    h.fake = fake({
      [entity.table]: [
        row({
          body_en: en,
          body_it: it,
          body_en_path: pointerPath(entity.name, 7, 'en', en),
          body_it_path: pointerPath(entity.name, 7, 'it', it),
        }),
      ],
    });
    seedObject(h.fake, entity.name, 'en', en);
    seedObject(h.fake, entity.name, 'it', it);
    const { selects, downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result).toEqual({
      success: true,
      data: { id: 7, body_en: en, body_it: it },
    });
    expect(projectionFor(selects, entity.table)).toEqual([
      'id, body_en, body_it, body_en_path, body_it_path',
    ]);
    expect(downloads).toHaveLength(2);
  });

  it('reads only the referenced language from Storage', async () => {
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    const en = '# storage en';
    h.fake = fake({
      [entity.table]: [
        row({
          body_en: en,
          body_en_path: pointerPath(entity.name, 7, 'en', en),
        }),
      ],
    });
    seedObject(h.fake, entity.name, 'en', en);
    const { downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.data).toEqual({
      id: 7,
      body_en: en,
      body_it: LEGACY_IT,
    });
    expect(downloads).toHaveLength(1);
  });

  it('preserves exact Unicode and newlines end to end', async () => {
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    const markdown = '# Tïtolo 🎉\r\n\r\n“virgolette” — ok\n\n';
    h.fake = fake({
      [entity.table]: [
        row({
          body_en: markdown,
          body_en_path: pointerPath(entity.name, 7, 'en', markdown),
        }),
      ],
    });
    seedObject(h.fake, entity.name, 'en', markdown);

    const result = await entity.run(7);

    expect(result.data).toEqual({
      id: 7,
      body_en: markdown,
      body_it: LEGACY_IT,
    });
    expect((result.data as { body_en: string }).body_en.length).toBe(
      markdown.length
    );
  });

  it('fails rather than returning an empty body when the object is missing', async () => {
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    const en = '# storage en';
    h.fake = fake({
      [entity.table]: [
        row({ body_en: en, body_en_path: pointerPath(entity.name, 7, 'en', en) }),
      ],
    });

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Object not found');
  });

  it('stays legacy-only in production and never names the pointer columns', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    h.fake = fake({ [entity.table]: [row()] });
    const { selects, downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.data).toEqual({
      id: 7,
      body_en: LEGACY_EN,
      body_it: LEGACY_IT,
    });
    expect(projectionFor(selects, entity.table)).toEqual([
      'id, body_en, body_it',
    ]);
    expect(downloads).toEqual([]);
  });

  it('rejects an incompatible enabled configuration before any DB or Storage call', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    h.fake = fake({ [entity.table]: [row()] });
    const { downloads } = instrument(h.fake);

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('refusing to resolve a content bucket');
    // Nothing reached the database or the bucket.
    expect(h.fake.state.log).toEqual([]);
    expect(downloads).toEqual([]);
  });

  it('includes hidden drafts for an authorized CMS user', async () => {
    h.fake = fake({ [entity.table]: [row({ hidden: true })] });

    const result = await entity.run(7);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 7,
      body_en: LEGACY_EN,
      body_it: LEGACY_IT,
    });
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
    h.fake = fake({ [entity.table]: [row()] }, {
      user: { id: 'intruder', email: 'intruder@example.com' },
    });

    const result = await entity.run(7);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('permission');
  });
});

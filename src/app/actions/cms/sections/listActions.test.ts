import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

/**
 * Phase 9B metadata-only list contract (blog + portfolio).
 *
 * Asserts the actual query projection and the returned field set — not helper
 * calls — so a body or a body pointer can never re-enter the list path.
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
import { BLOG_LIST_COLUMNS, PORTFOLIO_LIST_COLUMNS } from '@/libs/cms/postList';
import { deriveButtonsFromPost } from '@/utils/cms/postButtons';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];

const ENTITIES = [
  {
    name: 'blog',
    table: 'blog_posts',
    columns: BLOG_LIST_COLUMNS,
    run: (): Promise<MutationResult> => blogActions({ type: 'GET_LIST' }),
    /** The removed `GET` dispatcher value, reached by a stale caller. */
    retiredGet: (): Promise<MutationResult> =>
      blogActions({ type: 'GET' } as never),
  },
  {
    name: 'portfolio',
    table: 'portfolio_posts',
    columns: PORTFOLIO_LIST_COLUMNS,
    run: (): Promise<MutationResult> => portfolioActions({ type: 'GET_LIST' }),
    /** The removed `GET` dispatcher value, reached by a stale caller. */
    retiredGet: (): Promise<MutationResult> =>
      portfolioActions({ type: 'GET' } as never),
  },
];

/** Captures every `.select(...)` projection and `.order(...)` issued. */
function instrument(store: FakeSupabase): {
  selects: Array<{ table: string; columns: string }>;
  orders: Array<{ table: string; column: string; ascending: boolean }>;
} {
  const selects: Array<{ table: string; columns: string }> = [];
  const orders: Array<{ table: string; column: string; ascending: boolean }> =
    [];
  const client = store.client as unknown as {
    from: (table: string) => {
      select: (columns?: string) => unknown;
      order: (column: string, options?: { ascending?: boolean }) => unknown;
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
    const originalOrder = builder.order.bind(builder);
    builder.order = (column: string, options?: { ascending?: boolean }) => {
      orders.push({ table, column, ascending: options?.ascending !== false });
      return originalOrder(column, options);
    };
    return builder;
  };

  return { selects, orders };
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

const BLOG_ROW = {
  id: 4,
  created_at: '2025-02-01T00:00:00.000Z',
  title: 'legacy title',
  title_en: 'EN title',
  title_it: 'IT title',
  image: 'cover.webp',
  description_en: 'en desc',
  description_it: 'it desc',
  body_en: '# body en',
  body_it: '# body it',
  body_en_path: `blog/4/en/${'a'.repeat(64)}.md`,
  body_it_path: `blog/4/it/${'b'.repeat(64)}.md`,
  blurhashURL: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  post_tags: 'tag1,tag2',
  views: 12,
  hidden: true,
  author_id: 'user-1',
};

const PORTFOLIO_ROW = {
  id: 11,
  created_at: '2025-03-01T00:00:00.000Z',
  title_en: 'EN title',
  title_it: 'IT title',
  image: 'cover.webp',
  source_link: 'https://source.example',
  demo_link: 'https://demo.example',
  description_en: 'en desc',
  description_it: 'it desc',
  body_en: '# body en',
  body_it: '# body it',
  body_en_path: `portfolio/11/en/${'c'.repeat(64)}.md`,
  body_it_path: `portfolio/11/it/${'d'.repeat(64)}.md`,
  blurhashURL: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  post_tags: 'tag1',
  store_link: 'https://store.example',
  fdroid_link: 'https://fdroid.example',
  website: 'https://site.example',
  ios_store_link: 'https://ios.example',
  buttons: null,
  views: 7,
  hidden: false,
  author_id: 'user-1',
};

function rowFor(entityName: string): Record<string, unknown> {
  return entityName === 'blog' ? { ...BLOG_ROW } : { ...PORTFOLIO_ROW };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
});

describe.each(ENTITIES)('GET_LIST ($name)', (entity) => {
  it('selects exactly the explicit metadata projection', async () => {
    h.fake = fake({ [entity.table]: [rowFor(entity.name)] });
    const { selects } = instrument(h.fake);

    const result = await entity.run();

    expect(result.success).toBe(true);
    const projection = selects
      .filter((s) => s.table === entity.table)
      .map((s) => s.columns);
    expect(projection).toEqual([entity.columns]);
    // Never a wildcard on the list path.
    expect(projection).not.toContain('*');
  });

  it('never selects a body or a body pointer column', async () => {
    h.fake = fake({ [entity.table]: [rowFor(entity.name)] });

    const result = await entity.run();

    const rows = result.data as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('body_en');
      expect(Object.keys(row)).not.toContain('body_it');
      expect(Object.keys(row)).not.toContain('body_en_path');
      expect(Object.keys(row)).not.toContain('body_it_path');
    }
    expect(entity.columns).not.toMatch(/body_en|body_it/);
  });

  it('returns every metadata field a card or editor form needs', async () => {
    h.fake = fake({ [entity.table]: [rowFor(entity.name)] });

    const result = await entity.run();

    const rows = result.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title_en).toBe('EN title');
    expect(rows[0]?.title_it).toBe('IT title');
    expect(rows[0]?.image).toBe('cover.webp');
    expect(rows[0]?.description_en).toBe('en desc');
    expect(rows[0]?.blurhashURL).toBe('LEHV6nWB2yk8pyo0adR*.7kCMdnj');
    expect(rows[0]?.post_tags).toBe(
      entity.name === 'blog' ? 'tag1,tag2' : 'tag1'
    );
    expect(rows[0]?.views).toBe(entity.name === 'blog' ? 12 : 7);
    expect(rows[0]?.author_id).toBe('user-1');
  });

  it('keeps an explicit created_at-descending order', async () => {
    const older = {
      ...rowFor(entity.name),
      id: 1,
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const newer = {
      ...rowFor(entity.name),
      id: 2,
      created_at: '2025-06-01T00:00:00.000Z',
    };
    h.fake = fake({ [entity.table]: [older, newer] });
    const { orders } = instrument(h.fake);

    const result = await entity.run();

    const rows = result.data as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
    expect(orders.filter((o) => o.table === entity.table)).toEqual([
      { table: entity.table, column: 'created_at', ascending: false },
    ]);
  });

  it('includes hidden drafts', async () => {
    h.fake = fake({
      [entity.table]: [{ ...rowFor(entity.name), hidden: true }],
    });

    const result = await entity.run();

    const rows = result.data as Array<{ hidden: boolean }>;
    expect(rows[0]?.hidden).toBe(true);
  });

  it('rejects an unauthenticated caller', async () => {
    h.fake = fake({ [entity.table]: [rowFor(entity.name)] }, { user: null });

    const result = await entity.run();

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Unauthorized');
  });

  it('rejects a caller who is not allowlisted (existing authorization model)', async () => {
    h.fake = fake(
      { [entity.table]: [rowFor(entity.name)] },
      {
        user: { id: 'intruder', email: 'intruder@example.com' },
      }
    );

    const result = await entity.run();

    expect(result.success).toBe(false);
    // The shared allowlist gate in the dispatcher reports both the
    // unauthenticated and the non-allowlisted case with one user-safe message.
    expect(String(result.error)).toContain('Unauthorized');
  });

  it('has retired the legacy full-row read, so no editor can select a body column', async () => {
    h.fake = fake({ [entity.table]: [rowFor(entity.name)] });
    const { selects } = instrument(h.fake);

    // The `GET` operation was removed from the action contract; an old caller
    // (or a stale bundle) reaching it now gets a rejection rather than a
    // `select('*')` row carrying the retired `body_en`/`body_it` columns.
    const result = await entity.retiredGet();

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Invalid operation');
    expect(selects.filter((s) => s.table === entity.table)).toEqual([]);
  });
});

/**
 * The projections are enumerated, not derived: every column below was verified
 * to exist in BOTH `dev_staging` and `public` against the live schema. Pinning
 * them here makes any future addition a deliberate act.
 */
describe('list projections', () => {
  it('pins the exact blog metadata projection', () => {
    expect(BLOG_LIST_COLUMNS.split(',').map((c) => c.trim())).toEqual([
      'id',
      'created_at',
      'title_en',
      'title_it',
      'image',
      'description_en',
      'description_it',
      'blurhashURL',
      'post_tags',
      'views',
      'hidden',
      'author_id',
    ]);
  });

  it('pins the exact portfolio metadata projection', () => {
    expect(PORTFOLIO_LIST_COLUMNS.split(',').map((c) => c.trim())).toEqual([
      'id',
      'created_at',
      'title_en',
      'title_it',
      'image',
      'source_link',
      'demo_link',
      'description_en',
      'description_it',
      'blurhashURL',
      'post_tags',
      'store_link',
      'fdroid_link',
      'website',
      'ios_store_link',
      'buttons',
      'views',
      'hidden',
      'author_id',
    ]);
  });

  it('never names a body or pointer column', () => {
    for (const columns of [BLOG_LIST_COLUMNS, PORTFOLIO_LIST_COLUMNS]) {
      expect(columns).not.toMatch(/body_en|body_it/);
      expect(columns).not.toContain('*');
    }
  });
});

describe('GET_LIST (portfolio specifics)', () => {
  it('retains the legacy link columns and buttons for deriveButtonsFromPost', async () => {
    h.fake = fake({ portfolio_posts: [rowFor('portfolio')] });

    const result = await portfolioActions({ type: 'GET_LIST' });

    const rows = result.data as Array<Record<string, unknown>>;
    const row = rows[0] as Record<string, unknown>;
    expect(row.source_link).toBe('https://source.example');
    expect(row.demo_link).toBe('https://demo.example');
    expect(row.store_link).toBe('https://store.example');
    expect(row.fdroid_link).toBe('https://fdroid.example');
    expect(row.ios_store_link).toBe('https://ios.example');
    expect(row.website).toBe('https://site.example');
    expect('buttons' in row).toBe(true);
    // A metadata-only row still derives the legacy buttons.
    expect(deriveButtonsFromPost(row as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'https://demo.example' }),
      ])
    );
  });
});

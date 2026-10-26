import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PRODUCTION / `public` editor-hydration contract, for BLOG and PORTFOLIO.
 *
 * The regression this file guards: the CMS editor opened with EMPTY Markdown in
 * production. Production runs schema `public` and does not set
 * `NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED`, so the editor fell back to a legacy
 * `select('*')` list read. That read returns the retired `body_en`/`body_it`
 * columns, which Storage-only writes never populate (they stay NULL), while the
 * real Markdown sits in the production content bucket behind the row's
 * canonical pointers.
 *
 * These scenarios run the REAL actions against a real Postgres (PGlite) on the
 * shape production is actually in — `body_en`/`body_it` still present and
 * nullable, pointers and CHECK constraints in place — with `APP_ENV=production`
 * and schema `public`, so the content bucket resolves to `website-content` (the
 * production bucket), not the dev clone's. A test that only ran on
 * `dev_staging` would not have caught this.
 *
 * Flow per entity: create (provisional row -> cover upload -> Storage objects ->
 * guarded pointer commit), then reopen exactly as the editor does (metadata-only
 * list read, then the authenticated per-post body read) and assert the exact EN
 * and IT Markdown comes back from Storage.
 */

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.client,
}));
vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.client,
}));
vi.mock('@/libs/public-site/revalidation', () => ({
  invalidatePublicContent: vi.fn(async () => 'sent' as const),
}));
vi.mock('next/cache', () => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({
    hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    dataURL: 'data:image/webp;base64,AAAA',
  })),
}));

import { blogActions } from '@/app/actions/cms/sections/blogActions';
import { portfolioActions } from '@/app/actions/cms/sections/portfolioActions';
import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import type { MutationResult } from '@/libs/cms/mutationResult';
import {
  BLOG_LIST_COLUMNS,
  bodyLazyLoadEnabled,
  PORTFOLIO_LIST_COLUMNS,
} from '@/libs/cms/postList';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';
import { CMS_PROD_STORAGE_BUCKET } from '@/libs/cms/storage/bucket';
import { CONTENT_BUCKET_PROD } from '@/libs/cms/storage/contentBucket';
import {
  type ContentSchemaShape,
  createPostgrestFixture,
  insertExistingColumns,
  objectsInBucket,
  openContentDatabase,
  type PostgrestFixture,
  resetContentRows,
  rowById,
  tableRows,
} from '@/testing/unit/postgrestPgliteFixture';
import { staticWebpFile as webpFile } from '@/testing/unit/fileFixtures';

const EDITOR = { id: 'user-1', email: 'admin@example.com' };
/** The PRODUCTION content bucket the production read and write paths resolve. */
const CONTENT = CONTENT_BUCKET_PROD;
const STORAGE_ORIGIN = 'https://fixture.supabase.co';
const EN_BODY = '# EN production body 🎉\n\nsecond line\n';
const IT_BODY = '# IT production body\n\nseconda riga\n';

const databases = new Map<ContentSchemaShape, Promise<PGlite>>();

/** One isolated database per shape, opened on first use and shared by its tests. */
function databaseFor(shape: ContentSchemaShape): Promise<PGlite> {
  const opened = databases.get(shape) ?? openContentDatabase(shape);
  databases.set(shape, opened);
  return opened;
}

function pointerPath(
  kind: 'blog' | 'portfolio',
  id: number,
  locale: 'en' | 'it',
  markdown: string
): string {
  return `${kind}/${id}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

type LooseBatch = {
  creates: Array<{ data: never; file: File; tempId?: string }>;
  updates: Array<{ id: number; data: Record<string, unknown> }>;
  deletes: number[];
};

type Entity = {
  name: 'blog' | 'portfolio';
  table: string;
  columns: string;
  createData: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  publish: (batch: LooseBatch) => Promise<MutationResult>;
  list: () => Promise<MutationResult>;
  bodies: (id: number) => Promise<MutationResult>;
};

/** The two action dispatchers, narrowed to the one call signature this file needs. */
type ActionDispatcher = (operation: never) => Promise<MutationResult>;

function entity(
  name: 'blog' | 'portfolio',
  table: string,
  columns: string,
  createData: (overrides?: Record<string, unknown>) => Record<string, unknown>,
  actions: ActionDispatcher
): Entity {
  return {
    name,
    table,
    columns,
    createData,
    publish: (batch) =>
      actions({
        type: 'BATCH_PUBLISH',
        creates: batch.creates,
        updates: batch.updates,
        deletes: batch.deletes,
      } as never),
    list: () => actions({ type: 'GET_LIST' } as never),
    bodies: (id) => actions({ type: 'GET_BODIES', id } as never),
  };
}

const BLOG = entity(
  'blog',
  'blog_posts',
  BLOG_LIST_COLUMNS,
  (overrides = {}) => ({
    title_en: 'Created EN',
    title_it: 'Created IT',
    image: '',
    description_en: 'en description',
    description_it: 'it description',
    body_en: EN_BODY,
    body_it: IT_BODY,
    blurhashURL: '',
    post_tags: '',
    author_id: EDITOR.id,
    ...overrides,
  }),
  blogActions
);

const PORTFOLIO = entity(
  'portfolio',
  'portfolio_posts',
  PORTFOLIO_LIST_COLUMNS,
  (overrides = {}) => ({
    title_en: 'Created EN',
    title_it: 'Created IT',
    image: '',
    description_en: 'en description',
    description_it: 'it description',
    body_en: EN_BODY,
    body_it: IT_BODY,
    blurhashURL: '',
    post_tags: '',
    buttons: [],
    author_id: EDITOR.id,
    ...overrides,
  }),
  portfolioActions
);

const ENTITIES = [BLOG, PORTFOLIO];

const SHAPES: ContentSchemaShape[] = [
  // Today's production shape: the legacy columns still exist and are nullable,
  // while the pointers are the authoritative body state.
  'legacy-nullable',
  // The contracted shape the same code must keep working on.
  'contracted',
];

/** Fresh rows, fresh Storage state and a fresh client for one scenario. */
async function prepare(
  shape: ContentSchemaShape
): Promise<{ db: PGlite; fixture: PostgrestFixture }> {
  const db = await databaseFor(shape);
  await resetContentRows(db);
  await db.exec('delete from public.cms_allowed_users');
  await insertExistingColumns(db, 'cms_allowed_users', {
    email: EDITOR.email,
    role: 'editor',
  });
  const fixture = createPostgrestFixture(db, { user: EDITOR });
  h.client = fixture.client;
  return { db, fixture };
}

/** Creates one post through the real batch-create path and returns its id. */
async function createPost(
  fixture: PostgrestFixture,
  row: Entity,
  overrides: Record<string, unknown> = {}
): Promise<number> {
  const result = await row.publish({
    creates: [
      {
        data: row.createData(overrides) as never,
        file: webpFile(),
        tempId: 'c1',
      },
    ],
    updates: [],
    deletes: [],
  });
  expect(result.error).toBeUndefined();
  const evidence = result.data as BatchCommitEvidence;
  expect(evidence.failed).toEqual([]);
  const id = evidence.createdIds.c1 as number;
  expect(typeof id).toBe('number');
  // The environment paired as production/public, so the cover landed in the
  // production ASSET bucket — proof this is not a dev-clone rehearsal.
  expect(objectsInBucket(fixture.state, CMS_PROD_STORAGE_BUCKET)).toHaveLength(
    1
  );
  return id;
}

beforeEach(() => {
  // Production: schema `public`, APP_ENV=production, and NO lazy-body variable.
  vi.unstubAllEnvs();
  delete process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED;
  vi.stubEnv('APP_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STORAGE_ORIGIN);
});

afterAll(async () => {
  await Promise.all(
    [...databases.values()].map(async (opened) => (await opened).close())
  );
});

describe.each(SHAPES)('production/public contract — $shape', (shape) => {
  let db: PGlite;
  let fixture: PostgrestFixture;

  beforeEach(async () => {
    ({ db, fixture } = await prepare(shape));
  });

  describe.each(ENTITIES)('$name editor', (row) => {
    it('hydrates the reopened post with the exact EN and IT Markdown from Storage', async () => {
      expect(bodyLazyLoadEnabled()).toBe(true);
      const id = await createPost(fixture, row);

      // The objects really live in the PRODUCTION content bucket, under keys
      // whose SHA-256 is the content's own hash.
      expect(objectsInBucket(fixture.state, CONTENT)).toEqual(
        expect.arrayContaining([
          pointerPath(row.name, id, 'en', EN_BODY),
          pointerPath(row.name, id, 'it', IT_BODY),
        ])
      );

      // 1. The list read the editor performs first: metadata only.
      const listCallsBefore = fixture.state.storage.length;
      const list = await row.list();
      expect(list.success).toBe(true);
      const listRow = (list.data as Array<Record<string, unknown>>).find(
        (entry) => entry.id === id
      );
      expect(listRow).toBeDefined();
      for (const absent of [
        'body_en',
        'body_it',
        'body_en_path',
        'body_it_path',
      ]) {
        expect(Object.keys(listRow as object)).not.toContain(absent);
      }
      // A list render resolves no body: no Storage call at all.
      expect(fixture.state.storage.length).toBe(listCallsBefore);

      // 2. The per-post read that must populate the editor.
      const readsBefore = fixture.state.storage.length;
      const read = await row.bodies(id);
      expect(read.success).toBe(true);
      expect(read.data).toEqual({ id, body_en: EN_BODY, body_it: IT_BODY });

      // Both downloads came from the production content bucket, in locale
      // order, and nothing else was touched.
      expect(
        fixture.state.storage
          .slice(readsBefore)
          .map((call) => [call.bucket, call.op, call.path])
      ).toEqual([
        [CONTENT, 'download', pointerPath(row.name, id, 'en', EN_BODY)],
        [CONTENT, 'download', pointerPath(row.name, id, 'it', IT_BODY)],
      ]);
    });

    it('keeps EN and IT isolated: an EN-only post reads back it as empty', async () => {
      // Not an empty IT body — an IT locale that was never committed. The create
      // validation rejects `''`, and a missing key leaves the pointer NULL.
      const id = await createPost(fixture, row, { body_it: undefined });

      expect(objectsInBucket(fixture.state, CONTENT)).not.toEqual(
        expect.arrayContaining([pointerPath(row.name, id, 'it', IT_BODY)])
      );
      const stored = await rowById(db, row.table, id);
      expect(stored?.body_en_path).toBe(
        pointerPath(row.name, id, 'en', EN_BODY)
      );
      expect(stored?.body_it_path).toBeNull();

      const readsBefore = fixture.state.storage.length;
      const read = await row.bodies(id);
      expect(read.data).toEqual({ id, body_en: EN_BODY, body_it: '' });
      // Only the EN object was fetched: one locale's key never decides the other.
      expect(
        fixture.state.storage
          .slice(readsBefore)
          .filter((call) => call.op === 'download')
          .map((call) => call.path)
      ).toEqual([pointerPath(row.name, id, 'en', EN_BODY)]);
    });

    it('moves only the EN pointer on an EN-only update and keeps IT committed', async () => {
      const id = await createPost(fixture, row);
      const itPath = pointerPath(row.name, id, 'it', IT_BODY);
      const editedEn = '# EN edited in production\n';

      const result = await row.publish({
        creates: [],
        updates: [{ id, data: { body_en: editedEn } }],
        deletes: [],
      });
      expect(result.error).toBeUndefined();
      expect((result.data as BatchCommitEvidence).failed).toEqual([]);

      const stored = await rowById(db, row.table, id);
      expect(stored?.body_en_path).toBe(
        pointerPath(row.name, id, 'en', editedEn)
      );
      expect(stored?.body_it_path).toBe(itPath);

      const read = await row.bodies(id);
      expect(read.data).toEqual({ id, body_en: editedEn, body_it: IT_BODY });
    });

    it('makes a metadata-only update with no Storage call and no body change', async () => {
      const id = await createPost(fixture, row);
      const before = await rowById(db, row.table, id);
      const storageBefore = fixture.state.storage.length;

      const result = await row.publish({
        creates: [],
        updates: [{ id, data: { hidden: !(before?.hidden as boolean) } }],
        deletes: [],
      });
      expect(result.error).toBeUndefined();
      expect((result.data as BatchCommitEvidence).failed).toEqual([]);

      // A metadata/visibility-only edit never touches Storage and never moves a
      // pointer: the committed Markdown is exactly as it was.
      expect(fixture.state.storage.length).toBe(storageBefore);
      const after = await rowById(db, row.table, id);
      expect(after?.body_en_path).toBe(before?.body_en_path);
      expect(after?.body_it_path).toBe(before?.body_it_path);
      expect(await row.bodies(id)).toEqual({
        success: true,
        data: { id, body_en: EN_BODY, body_it: IT_BODY },
      });
    });

    it('lists a hidden post and still resolves its Markdown', async () => {
      const id = await createPost(fixture, row, { hidden: true });

      const list = await row.list();
      const listRow = (list.data as Array<Record<string, unknown>>).find(
        (entry) => entry.id === id
      );
      expect(listRow?.hidden).toBe(true);

      const read = await row.bodies(id);
      expect(read.data).toEqual({ id, body_en: EN_BODY, body_it: IT_BODY });
    });

    it('fails the body read when the referenced object is missing, never returning an empty body', async () => {
      const id = await createPost(fixture, row);
      const enPath = pointerPath(row.name, id, 'en', EN_BODY);
      fixture.state.objects.delete(`${CONTENT}/${enPath}`);

      const read = await row.bodies(id);

      expect(read.success).toBe(false);
      expect(read.data).toBeUndefined();
      expect(String(read.error)).toMatch(/body|integrity|not found/i);
      // The row still points at the (now missing) object: the failure is
      // reported, not papered over with an empty body, and nothing is mutated.
      const stored = await rowById(db, row.table, id);
      expect(stored?.body_en_path).toBe(enPath);
    });

    it('rejects a pointer whose content no longer matches its SHA-256 key', async () => {
      const id = await createPost(fixture, row);
      const enPath = pointerPath(row.name, id, 'en', EN_BODY);
      fixture.state.objects.set(
        `${CONTENT}/${enPath}`,
        new TextEncoder().encode('# tampered bytes\n')
      );

      const read = await row.bodies(id);

      expect(read.success).toBe(false);
      expect(read.data).toBeUndefined();
      expect(String(read.error)).toContain('integrity');
      expect((await rowById(db, row.table, id))?.body_en_path).toBe(enPath);
    });
  });

  it('exposes exactly the metadata columns and never a body column on the list path', async () => {
    for (const row of ENTITIES) {
      const list = await row.list();
      expect(list.success).toBe(true);
      for (const entry of list.data as Array<Record<string, unknown>>) {
        expect(Object.keys(entry)).not.toContain('body_en');
        expect(Object.keys(entry)).not.toContain('body_it');
        expect(Object.keys(entry)).not.toContain('body_en_path');
        expect(Object.keys(entry)).not.toContain('body_it_path');
      }
      expect(row.columns).not.toMatch(/body_en|body_it/);
    }
  });

  it('refuses the retired full-row read instead of returning NULL legacy bodies', async () => {
    // A committed post must exist for the legacy columns to be observably NULL.
    await createPost(fixture, BLOG);

    // A stale client (or an old bundle) asking for the removed `GET` must not
    // receive rows whose `body_en`/`body_it` are NULL — that is exactly the
    // production editor that opened empty.
    const blog = await blogActions({ type: 'GET' } as never);
    expect(blog.success).toBe(false);
    expect(String(blog.error)).toContain('Invalid operation');

    const portfolio = await portfolioActions({ type: 'GET' } as never);
    expect(portfolio.success).toBe(false);
    expect(String(portfolio.error)).toContain('Invalid operation');

    expect(
      fixture.state.statements.some(
        (statement) =>
          statement.mode === 'select' && statement.projection === '*'
      )
    ).toBe(false);
    // The legacy columns exist on this shape and are still NULL, which is why
    // the list/body split (not a column read) is what fixed production.
    if (shape === 'legacy-nullable') {
      const rows = await tableRows(db, 'blog_posts');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((entry) => entry.body_en === null)).toBe(true);
    }
  });
});

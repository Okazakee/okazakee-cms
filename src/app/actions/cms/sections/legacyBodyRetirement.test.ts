import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rehearsal of the legacy-body retirement against a REAL Postgres, with
 * `body_en` / `body_it` absent.
 *
 * The other retirement tests assert what the SOURCE says (projections, payload
 * keys, the helper that strips the retired columns). Those cannot show that the
 * application still RUNS once the columns are gone: on an in-memory fake an
 * unknown column is simply absent from every row. Here the schema is built from
 * the real reviewed artifacts, in the runbook's order — pre-contraction tables,
 * `prod_markdown_backfill_cas.sql`, the `body_en` nullability step, then
 * `prod_legacy_body_retirement.sql` — and every statement the actions issue is
 * translated to SQL and executed, so a leftover reference to a retired column
 * fails exactly where it would fail in production (Postgres `42703`, or
 * PostgREST `PGRST204` for a write payload).
 *
 * Exercised through the real action dispatcher:
 *   - the detail read for both locales (GET_BODIES);
 *   - create (provisional row -> objects -> ONE guarded pointer commit);
 *   - single-locale edit (only that pointer moves, guard names only it);
 *   - metadata-only update (no Storage call at all);
 *   - delete (row and assets go, Markdown objects stay for the collector);
 *   - the lost-update path when a concurrent edit moves the pointer mid-save.
 *
 * `legacy-nullable` is the negative control the same assertions run against: the
 * legacy columns are still there and already nullable (the release plan's step
 * 4/5 state), so a pass proves the contract tolerates the columns either way
 * instead of being an artifact of a schema that cannot name them.
 */
const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  invalidate: vi.fn(async (): Promise<'sent' | 'failed' | 'skipped'> => 'sent'),
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.client,
}));
vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.client,
}));
vi.mock('@/libs/public-site/revalidation', () => ({
  invalidatePublicContent: h.invalidate,
}));
vi.mock('next/cache', () => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({
    hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    dataURL: 'data:image/webp;base64,AAAA',
  })),
}));

import { blogActions } from '@/app/actions/cms/sections/blogActions';
import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import type { MutationResult } from '@/libs/cms/mutationResult';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';
import { CMS_DEV_STORAGE_BUCKET } from '@/libs/cms/storage/bucket';
import { CONTENT_BUCKET_DEV } from '@/libs/cms/storage/contentBucket';
import {
  type ContentSchemaShape,
  columnNullable,
  createPostgrestFixture,
  insertExistingColumns,
  objectsInBucket,
  openContentDatabase,
  POINTER_PATH_CHECKS,
  type PostgrestFixture,
  pointerPathChecks,
  prodBackfillFunctions,
  resetContentRows,
  retiredColumnReferences,
  rowById,
  storageCallsIn,
  tableColumns,
  tableRows,
} from '@/testing/unit/postgrestPgliteFixture';
import { staticWebpFile as webpFile } from '@/testing/unit/fileFixtures';

const EDITOR = { id: 'user-1', email: 'admin@example.com' };
/** The dev content bucket the write path and the dev read path both resolve. */
const CONTENT = CONTENT_BUCKET_DEV;
/** The public ASSET bucket — never a body store. */
const ASSET = CMS_DEV_STORAGE_BUCKET;
const STORAGE_ORIGIN = 'https://fixture.supabase.co';
const EN_BODY = '# EN storage body 🎉\n\nsecond line\n';
const IT_BODY = '# IT storage body\n\nseconda riga\n';

const databases = new Map<ContentSchemaShape, Promise<PGlite>>();

/** One isolated database per shape, opened on first use and shared by its tests. */
function databaseFor(shape: ContentSchemaShape): Promise<PGlite> {
  const opened = databases.get(shape) ?? openContentDatabase(shape);
  databases.set(shape, opened);
  return opened;
}

function pointerPath(
  id: number,
  locale: 'en' | 'it',
  markdown: string
): string {
  return `blog/${id}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

function imagePath(id: number): string {
  return `blog/${id}/cover.webp`;
}

/** Public URL shape the fixture's `getPublicUrl` produces for the asset bucket. */
function imageUrl(id: number): string {
  return `${STORAGE_ORIGIN}/storage/v1/object/public/${ASSET}/${imagePath(id)}`;
}

function blogCreateData(
  overrides: Partial<CreateBlogData> = {}
): CreateBlogData {
  return {
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
  };
}

type SeededBlog = { id: number; enPath: string; itPath: string };

/**
 * A committed post: metadata, both canonical pointers, the referenced objects
 * and a cover in the asset bucket. The legacy `body_en` / `body_it` values are
 * dropped on the contracted shape (they cannot exist there).
 */
async function seedBlog(
  db: PGlite,
  fixture: PostgrestFixture
): Promise<SeededBlog> {
  const row = await insertExistingColumns(db, 'blog_posts', {
    title_en: 'Seeded EN',
    title_it: 'Seeded IT',
    description_en: 'en',
    description_it: 'it',
    body_en: '# legacy EN copy',
    body_it: '# legacy IT copy',
    image: '',
    post_tags: '',
    author_id: EDITOR.id,
    hidden: false,
  });
  const id = row.id as number;
  const enPath = pointerPath(id, 'en', EN_BODY);
  const itPath = pointerPath(id, 'it', IT_BODY);
  await db.query(
    `update public.blog_posts
        set body_en_path = $1, body_it_path = $2, image = $3
      where id = $4`,
    [enPath, itPath, imageUrl(id), id]
  );
  fixture.state.objects.set(
    `${CONTENT}/${enPath}`,
    new TextEncoder().encode(EN_BODY)
  );
  fixture.state.objects.set(
    `${CONTENT}/${itPath}`,
    new TextEncoder().encode(IT_BODY)
  );
  fixture.state.objects.set(
    `${ASSET}/${imagePath(id)}`,
    new TextEncoder().encode('cover bytes')
  );
  return { id, enPath, itPath };
}

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
  h.invalidate.mockClear();
  h.invalidate.mockResolvedValue('sent');
  return { db, fixture };
}

/**
 * Runs `after` once, immediately after the first Markdown object is uploaded —
 * i.e. between this save's pointer READ and its guarded commit, which is the
 * window a concurrent edit has to land in.
 */
function raceAfterContentUpload(
  fixture: PostgrestFixture,
  after: () => Promise<void> | void
): void {
  // The rehearsal has to wrap the Storage factory the actions call; the
  // `SupabaseClient` type does not describe the fixture's in-memory bucket, so
  // the shaped view is named here once instead of being re-asserted inline.
  const supabaseLike = fixture.client as unknown as {
    storage: { from: (bucket: string) => unknown };
  };
  const storage = supabaseLike.storage;
  const originalFrom = storage.from.bind(storage);
  let fired = false;
  storage.from = (bucket: string) => {
    const api = originalFrom(bucket) as {
      upload(path: string, data: unknown, options?: unknown): Promise<unknown>;
    };
    const originalUpload = api.upload.bind(api);
    api.upload = async (path, data, options) => {
      const result = await originalUpload(path, data, options);
      if (!fired && path.endsWith('.md')) {
        fired = true;
        await after();
      }
      return result;
    };
    return api as never;
  };
}

type BatchPublish = Extract<
  Parameters<typeof blogActions>[0],
  { type: 'BATCH_PUBLISH' }
>;
type CreateBlogData = BatchPublish['creates'][number]['data'];

function publish(
  operation: Omit<BatchPublish, 'type'>
): Promise<MutationResult> {
  return blogActions({ type: 'BATCH_PUBLISH', ...operation });
}

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STORAGE_ORIGIN);
});

afterAll(async () => {
  await Promise.all(
    [...databases.values()].map(async (opened) => (await opened).close())
  );
});

const SHAPES: Array<{ shape: ContentSchemaShape; legacyColumns: boolean }> = [
  { shape: 'contracted', legacyColumns: false },
  // Negative control: the retired columns still exist (release-plan step 5).
  { shape: 'legacy-nullable', legacyColumns: true },
];

describe.each(SHAPES)(
  'legacy-body retirement rehearsal — $shape',
  ({ shape, legacyColumns }) => {
    let db: PGlite;
    let fixture: PostgrestFixture;

    beforeEach(async () => {
      ({ db, fixture } = await prepare(shape));
    });

    it('keeps the pointer contract and removes exactly the retired objects', async () => {
      const blogColumns = await tableColumns(db, 'blog_posts');
      const retired = blogColumns.filter(
        (column) => column === 'body_en' || column === 'body_it'
      );
      expect(retired).toEqual(legacyColumns ? ['body_en', 'body_it'] : []);
      expect(blogColumns).toContain('body_en_path');
      expect(blogColumns).toContain('body_it_path');
      expect(await pointerPathChecks(db)).toEqual([...POINTER_PATH_CHECKS]);
      // Only the contraction removes the CAS functions; the control keeps them,
      // which is what makes the pair a real "before/after" comparison.
      expect(await prodBackfillFunctions(db)).toEqual(
        legacyColumns
          ? [
              'prod_backfill_body_pointer_cas',
              'prod_backfill_body_pointer_rollback',
            ]
          : []
      );
      // Nullable on purpose: a new post needs its row id before a canonical
      // path can exist.
      expect(await columnNullable(db, 'blog_posts', 'body_en_path')).toBe(true);
      expect(await columnNullable(db, 'blog_posts', 'body_it_path')).toBe(true);
    });

    it('reads both locales from the content bucket', async () => {
      const seeded = await seedBlog(db, fixture);

      const result = await blogActions({ type: 'GET_BODIES', id: seeded.id });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        id: seeded.id,
        body_en: EN_BODY,
        body_it: IT_BODY,
      });
      const select = fixture.state.statements.find(
        (statement) =>
          statement.table === 'blog_posts' && statement.mode === 'select'
      );
      expect(select?.projection).toBe('body_en_path, body_it_path');
      expect(select?.filterColumns).toEqual(['id']);
      expect(select?.errorCode).toBeNull();
      // Both bodies came from the environment's content bucket, in locale
      // order, and nothing else was touched.
      expect(
        fixture.state.storage.map((call) => [call.bucket, call.op, call.path])
      ).toEqual([
        [CONTENT, 'download', seeded.enPath],
        [CONTENT, 'download', seeded.itPath],
      ]);
    });

    it('creates a post: provisional row, objects, then one guarded pointer commit', async () => {
      let provisional: Record<string, unknown> | undefined;
      raceAfterContentUpload(fixture, async () => {
        provisional = (await tableRows(db, 'blog_posts'))[0];
      });

      const result = await publish({
        creates: [{ data: blogCreateData(), file: webpFile(), tempId: 'c1' }],
        updates: [],
        deletes: [],
      });

      expect(result.error).toBeUndefined();
      const evidence = result.data as BatchCommitEvidence;
      expect(evidence.failed).toEqual([]);
      const id = evidence.createdIds.c1 as number;
      expect(evidence.created).toEqual(['c1']);

      // While the save is in flight the row exists but is hidden and unpointed:
      // it cannot be publicly readable before its objects are proven in place.
      expect(provisional?.hidden).toBe(true);
      expect(provisional?.body_en_path).toBeNull();
      expect(provisional?.body_it_path).toBeNull();

      const insert = fixture.state.statements.find(
        (statement) => statement.mode === 'insert'
      );
      expect(insert?.errorCode).toBeNull();
      expect(insert?.payloadColumns).not.toContain('body_en');
      expect(insert?.payloadColumns).not.toContain('body_it');

      const commit = fixture.state.statements.find(
        (statement) =>
          statement.mode === 'update' &&
          statement.payloadColumns.includes('body_en_path')
      );
      // One statement carries both pointers AND the intended visibility,
      // guarded on the unpointed provisional row.
      expect(commit?.payloadColumns.sort()).toEqual([
        'body_en_path',
        'body_it_path',
        'hidden',
      ]);
      expect(commit?.filterColumns).toEqual([
        'id',
        'body_en_path',
        'body_it_path',
      ]);
      expect(commit?.rows).toBe(1);

      const uploads = fixture.state.storage.filter(
        (call) => call.bucket === CONTENT && call.op === 'upload'
      );
      expect(uploads.map((call) => call.path)).toEqual([
        pointerPath(id, 'en', EN_BODY),
        pointerPath(id, 'it', IT_BODY),
      ]);
      // Sequencing: the row exists first, then the objects, then the pointers.
      expect(insert?.at).toBeLessThan(uploads[0].at);
      expect(uploads[1].at).toBeLessThan(commit?.at ?? -1);

      const row = await rowById(db, 'blog_posts', id);
      expect(row?.body_en_path).toBe(pointerPath(id, 'en', EN_BODY));
      expect(row?.body_it_path).toBe(pointerPath(id, 'it', IT_BODY));
      expect(row?.hidden).toBe(false);
      // The committed pointers resolve to the exact bytes that were uploaded,
      // and the CHECK constraints accepted them (the commit would have failed
      // otherwise, because they pin the row's own id and locale).
      const enObject = fixture.state.objects.get(
        `${CONTENT}/${pointerPath(id, 'en', EN_BODY)}`
      );
      expect(new TextDecoder().decode(enObject)).toBe(EN_BODY);
    });

    it('edits one locale: only that pointer moves, and the guard names only it', async () => {
      const seeded = await seedBlog(db, fixture);
      const edited = '# EN edited in place\n';

      const result = await publish({
        creates: [],
        updates: [{ id: seeded.id, data: { body_en: edited } }],
        deletes: [],
      });

      expect(result.error).toBeUndefined();
      const commit = fixture.state.statements.find(
        (statement) =>
          statement.mode === 'update' &&
          statement.payloadColumns.includes('body_en_path')
      );
      // An EN-only edit can never be rejected — or blocked — by the IT pointer.
      expect(commit?.payloadColumns).toEqual(['body_en_path']);
      expect(commit?.filterColumns).toEqual(['id', 'body_en_path']);
      expect(commit?.rows).toBe(1);

      const row = await rowById(db, 'blog_posts', seeded.id);
      expect(row?.body_en_path).toBe(pointerPath(seeded.id, 'en', edited));
      expect(row?.body_it_path).toBe(seeded.itPath);
      const contentObjects = objectsInBucket(fixture.state, CONTENT);
      expect(contentObjects).toContain(pointerPath(seeded.id, 'en', edited));
      expect(contentObjects).toContain(seeded.itPath);
      // The replaced object is left in place: unreferenced Markdown is the
      // garbage collector's job, never the save's.
      expect(contentObjects).toContain(seeded.enPath);
      expect(storageCallsIn(fixture.state, ASSET)).toEqual([]);
      expect(h.invalidate).toHaveBeenCalledTimes(1);
    });

    it('metadata-only update: one row write, zero Storage calls, no pointer write', async () => {
      const seeded = await seedBlog(db, fixture);

      const result = await publish({
        creates: [],
        updates: [{ id: seeded.id, data: { title_en: 'Renamed EN' } }],
        deletes: [],
      });

      expect(result.error).toBeUndefined();
      const updates = fixture.state.statements.filter(
        (statement) => statement.mode === 'update'
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].payloadColumns).toEqual(['title_en']);
      expect(updates[0].filterColumns).toEqual(['id']);
      expect(updates[0].errorCode).toBeNull();
      // No upload, no download, no list, no remove — anywhere.
      expect(fixture.state.storage).toEqual([]);

      const row = await rowById(db, 'blog_posts', seeded.id);
      expect(row?.title_en).toBe('Renamed EN');
      expect(row?.body_en_path).toBe(seeded.enPath);
      expect(row?.body_it_path).toBe(seeded.itPath);
    });

    it('deletes the row and its assets, and leaves the Markdown to the collector', async () => {
      const seeded = await seedBlog(db, fixture);

      const result = await publish({
        creates: [],
        updates: [],
        deletes: [seeded.id],
      });

      const evidence = result.data as BatchCommitEvidence;
      expect(evidence.failed).toEqual([]);
      expect(evidence.deleted).toEqual([seeded.id]);
      expect(await rowById(db, 'blog_posts', seeded.id)).toBeNull();
      // Content-bucket Markdown is never deleted by the write path.
      expect(storageCallsIn(fixture.state, CONTENT)).toEqual([]);
      expect(objectsInBucket(fixture.state, CONTENT).sort()).toEqual(
        [seeded.enPath, seeded.itPath].sort()
      );
      // The asset bucket is cleaned instead.
      expect(objectsInBucket(fixture.state, ASSET)).toEqual([]);
    });

    it('loses cleanly when a concurrent edit moves the pointer mid-save', async () => {
      const seeded = await seedBlog(db, fixture);
      const loser = '# EN from the losing save\n';
      const concurrent = pointerPath(seeded.id, 'en', '# concurrent editor\n');
      raceAfterContentUpload(fixture, async () => {
        await db.query(
          'update public.blog_posts set body_en_path = $1 where id = $2',
          [concurrent, seeded.id]
        );
      });

      const result = await publish({
        creates: [],
        updates: [{ id: seeded.id, data: { body_en: loser } }],
        deletes: [],
      });

      expect(result.success).toBe(false);
      const evidence = result.data as BatchCommitEvidence;
      expect(evidence.updated).toEqual([]);
      expect(evidence.failed[0]?.error).toContain(
        'Conflicting concurrent edit'
      );
      // The concurrent write stands; nothing of the losing save was applied.
      const row = await rowById(db, 'blog_posts', seeded.id);
      expect(row?.body_en_path).toBe(concurrent);
      expect(row?.body_it_path).toBe(seeded.itPath);
      // The uploaded object is unreferenced, not deleted: the collector owns it.
      expect(objectsInBucket(fixture.state, CONTENT)).toContain(
        pointerPath(seeded.id, 'en', loser)
      );
      expect(h.invalidate).not.toHaveBeenCalled();
    });

    it('never names a retired column in any statement it executes', async () => {
      const seeded = await seedBlog(db, fixture);

      // Every path, in one log: read, create, edit, metadata, delete.
      await blogActions({ type: 'GET_BODIES', id: seeded.id });
      await publish({
        creates: [{ data: blogCreateData(), file: webpFile(), tempId: 'c1' }],
        updates: [],
        deletes: [],
      });
      await publish({
        creates: [],
        updates: [{ id: seeded.id, data: { body_en: '# EN edited again\n' } }],
        deletes: [],
      });
      await publish({
        creates: [],
        updates: [{ id: seeded.id, data: { title_en: 'Renamed again' } }],
        deletes: [],
      });
      await publish({ creates: [], updates: [], deletes: [seeded.id] });

      // Guard against a vacuous pass: the assertion below must cover real work.
      expect(fixture.state.statements.length).toBeGreaterThan(8);
      expect(fixture.state.storage.length).toBeGreaterThan(4);

      const references = retiredColumnReferences(fixture.state.statements);
      expect(
        references.map(
          (reference) =>
            `${reference.statement.mode} ${reference.statement.table} -> ${reference.column}`
        )
      ).toEqual([]);
    });
  }
);

describe('fixture enforcement (so a pass is not vacuous)', () => {
  it('fails a statement that names a retired column, with the real error', async () => {
    const db = await databaseFor('contracted');
    await resetContentRows(db);
    const fixture = createPostgrestFixture(db);
    h.client = fixture.client;

    const selected = await fixture.client
      .from('blog_posts')
      .select('id, body_en')
      .eq('id', 1)
      .single();
    expect(selected.error?.code).toBe('42703');
    expect(selected.error?.message).toContain('body_en');

    const inserted = await fixture.client
      .from('blog_posts')
      .insert({ title_en: 'x', body_en: 'shim value' })
      .select()
      .single();
    expect(inserted.error?.code).toBe('PGRST204');
    expect(inserted.error?.message).toContain('body_en');

    // The retired-column detector sees both, so "no retired column" above is a
    // real assertion rather than a detector that never fires.
    expect(
      retiredColumnReferences(fixture.state.statements).map(
        (reference) => reference.column
      )
    ).toEqual(['body_en', 'body_en']);
    // `body_en_path` is a different column and must never be reported.
    expect(
      retiredColumnReferences([
        {
          table: 'blog_posts',
          mode: 'select',
          projection: 'id, body_en_path, body_it_path',
          payloadColumns: ['body_en_path'],
          filterColumns: ['body_it_path'],
          rows: 0,
          errorCode: null,
          at: 0,
        },
      ])
    ).toEqual([]);
  });

  it('still enforces the preserved pointer CHECK constraints', async () => {
    const db = await databaseFor('contracted');
    await resetContentRows(db);
    const fixture = createPostgrestFixture(db);
    h.client = fixture.client;
    const row = await insertExistingColumns(db, 'blog_posts', {
      title_en: 'T',
      body_en: '# legacy EN',
    });
    const id = row.id as number;

    // A pointer that names another post id is rejected by the constraint, not
    // silently accepted: the contraction preserves the pointer contract.
    const wrongPost = await fixture.client
      .from('blog_posts')
      .update({ body_en_path: `blog/${id + 1}/en/${'a'.repeat(64)}.md` })
      .eq('id', id)
      .select();
    expect(wrongPost.error?.code).toBe('23514');
    expect(wrongPost.data).toBeNull();

    const wrongShape = await fixture.client
      .from('blog_posts')
      .update({ body_it_path: `blog/${id}/it/${'A'.repeat(64)}.md` })
      .eq('id', id)
      .select();
    expect(wrongShape.error?.code).toBe('23514');

    const canonical = await fixture.client
      .from('blog_posts')
      .update({ body_en_path: `blog/${id}/en/${'a'.repeat(64)}.md` })
      .eq('id', id)
      .select();
    expect(canonical.error).toBeNull();
    expect(canonical.data).toHaveLength(1);
  });
});

/**
 * Historical ordering evidence. While `body_en` was still `NOT NULL`, a save
 * that named no legacy column failed the constraint (`23502`). That is why the
 * release plan relaxed the column before the contraction; the shim that bridged
 * the gap has since been removed and the columns dropped, so the failure is
 * purely a schema-shape rehearsal.
 */
describe('retired column vs. schema shape (historical ordering)', () => {
  it('a save that names no legacy column fails while body_en is still NOT NULL', async () => {
    const { db, fixture } = await prepare('legacy-not-null');

    const result = await publish({
      creates: [{ data: blogCreateData(), file: webpFile(), tempId: 'c1' }],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const insert = fixture.state.statements.find(
      (statement) => statement.mode === 'insert'
    );
    expect(insert?.errorCode).toBe('23502');
    expect(insert?.payloadColumns).not.toContain('body_en');
    expect(await tableRows(db, 'blog_posts')).toEqual([]);
    // The cover upload is rolled back and no Markdown was ever written.
    expect(objectsInBucket(fixture.state, CONTENT)).toEqual([]);
    expect(objectsInBucket(fixture.state, ASSET)).toEqual([]);
  });
});

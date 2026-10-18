import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the REVIEW-ONLY production Storage read policy against a real
 * Postgres (PGlite, WASM) with the minimum Storage surface it needs:
 *
 * - `storage.objects` with RLS enabled, carrying a pre-existing unrelated
 *   `INSERT` policy that must survive untouched, plus a pre-existing
 *   `storage.buckets` policy;
 * - `storage.operation()` / `storage.allow_any_operation(text[])` stubs that
 *   mirror the live helpers, so the object-DOWNLOAD gate is exercised exactly
 *   as the real function evaluates it;
 * - `public.blog_posts` / `public.portfolio_posts` carrying the production read
 *   policy (`cms_published_read USING (hidden = false)`, migration
 *   20261006060140) and the `body_en_path` / `body_it_path` pointers;
 * - the permissive Storage grant surface (SELECT/INSERT/UPDATE/DELETE to the
 *   API roles), so every write denial below provably comes from RLS and not
 *   from a missing GRANT.
 *
 * The test proves the effective visibility model through actual RLS
 * enforcement as `anon` / `authenticated` / `service_role` — real query
 * results and `pg_policies` / `pg_depend` / ACL catalogs, never the SQL text.
 *
 * NOT MODELLED HERE (Phase 14 live checks on the production project): the
 * Storage API's own operation names and execution path (which statements the
 * `download` and `list` endpoints issue), the publishable/anon key -> `anon`
 * role mapping done by PostgREST/GoTrue, `service_role`'s BYPASSRLS attribute
 * as Supabase configures it, and CDN/edge caching of authorized downloads.
 */

const policyPath = fileURLToPath(
  new URL(
    '../../../supabase/review/prod_website_content_storage_rls.sql',
    import.meta.url
  )
);

const POLICY = 'website_content_body_read';
const PROD_BUCKET = 'website-content';
const DEV_BUCKET = 'website-content-dev';
const ASSET_BUCKET = 'website-dev';
// The two operation values the staged policy authorizes (an object download /
// an object-info request); anything else — notably a listing — stays denied.
const DOWNLOAD_OP = 'object.get_authenticated';
const DOWNLOAD_INFO_OP = 'object.get_authenticated_info';
const LIST_OP = 'object.list';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_F = 'f'.repeat(64);
const HASH_G = '7'.repeat(64);
const HASH_H = '8'.repeat(64);

// blog/1 visible (EN pointer), blog/2 hidden, blog/3 visible (IT pointer),
// blog/4 visible but future-dated, blog/9 has no row at all.
const OBJ_A = `blog/1/en/${HASH_A}.md`;
const OBJ_B = `blog/2/en/${HASH_B}.md`;
const OBJ_C = `blog/3/it/${HASH_C}.md`;
const OBJ_D = `blog/9/en/${HASH_D}.md`;
const OBJ_H = `blog/4/en/${HASH_H}.md`;
// portfolio/11 visible, portfolio/12 hidden.
const OBJ_F = `portfolio/11/en/${HASH_F}.md`;
const OBJ_G = `portfolio/12/it/${HASH_G}.md`;
// A public asset object and a bare prefix that matches no pointer.
const OBJ_ASSET = 'assets/hero.png';
const OBJ_PREFIX = 'blog/1/en/';

/** Seeded `storage.objects` rows: [bucket, name]. */
const SEEDED_OBJECTS: Array<[string, string]> = [
  [PROD_BUCKET, OBJ_A],
  [PROD_BUCKET, OBJ_B],
  [PROD_BUCKET, OBJ_C],
  [PROD_BUCKET, OBJ_D],
  [PROD_BUCKET, OBJ_F],
  [PROD_BUCKET, OBJ_G],
  [PROD_BUCKET, OBJ_H],
  [PROD_BUCKET, OBJ_PREFIX],
  // The dev bucket's object deliberately reuses blog/1's pointer name, so the
  // bucket predicate — not the name — is what denies it.
  [DEV_BUCKET, OBJ_A],
  [ASSET_BUCKET, OBJ_ASSET],
];
/** Names only, in the order SQL's `order by name` yields. */
const ALL_OBJECTS = SEEDED_OBJECTS.map(([, name]) => name).sort();
/** `bucket/name`, in the order SQL's `order by bucket_id, name` yields. */
const ALL_ROWS = [...SEEDED_OBJECTS]
  .sort(
    ([bucketA, nameA], [bucketB, nameB]) =>
      bucketA.localeCompare(bucketB) || nameA.localeCompare(nameB)
  )
  .map(([bucket, name]) => `${bucket}/${name}`);

/** Exactly the bodies the anon download path may reach (lexicographic). */
const VISIBLE_DOWNLOADS = [OBJ_A, OBJ_C, OBJ_H, OBJ_F].sort();

let db: PGlite;
let policiesBefore: string[] = [];
let policiesAfter: string[] = [];
let allStorageBefore: string[] = [];
let allStorageAfter: string[] = [];
let postPoliciesBefore: string[] = [];
let postPoliciesAfter: string[] = [];
let bucketsBefore: string[] = [];
let bucketsAfter: string[] = [];
let aclsBefore: string[] = [];
let aclsAfter: string[] = [];
let publicBefore: string[] = [];
let publicAfter: string[] = [];
let anonVisibleBefore: string[] = [];
let authVisibleBefore: string[] = [];

async function objectsVisibleTo(
  role: 'anon' | 'authenticated' | 'service_role',
  operation: string,
  prefix?: string
): Promise<string[]> {
  await db.exec(
    `select set_config('storage.operation', '${operation}', false)`
  );
  await db.exec(`set role ${role}`);
  try {
    const res =
      prefix === undefined
        ? await db.query<{ name: string }>(
            `select name from storage.objects order by name`
          )
        : await db.query<{ name: string }>(
            `select name from storage.objects where name like $1 order by name`,
            [`${prefix}%`]
          );
    return res.rows.map((row) => row.name);
  } finally {
    await db.exec('reset role');
  }
}

/** Runs a write as `role`; an RLS refusal surfaces as its SQLSTATE. */
async function attemptWrite(
  role: 'anon' | 'authenticated',
  statement: string
): Promise<{ code: string | null; rows: number }> {
  await db.exec(`set role ${role}`);
  try {
    const res = await db.query(statement);
    return { code: null, rows: res.rows.length };
  } catch (error) {
    // Narrow instead of asserting a shape: the driver error carries `code`.
    if (error !== null && typeof error === 'object' && 'code' in error) {
      return { code: String(error.code), rows: 0 };
    }
    const message = error instanceof Error ? error.message : 'unknown';
    return { code: message, rows: 0 };
  } finally {
    await db.exec('reset role');
  }
}

async function policiesOn(schema: string, table: string): Promise<string[]> {
  const res = await db.query<{ policyname: string; cmd: string }>(
    `select policyname, cmd from pg_policies
      where schemaname = $1 and tablename = $2 order by policyname`,
    [schema, table]
  );
  return res.rows.map((row) => `${table}.${row.policyname}/${row.cmd}`);
}

async function allStoragePolicies(): Promise<string[]> {
  const res = await db.query<{
    tablename: string;
    policyname: string;
    cmd: string;
  }>(
    `select tablename, policyname, cmd from pg_policies
      where schemaname = 'storage' order by tablename, policyname`
  );
  return res.rows.map((row) => `${row.tablename}.${row.policyname}/${row.cmd}`);
}

async function publicObjects(): Promise<string[]> {
  const res = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','i','S') order by c.relname`
  );
  return res.rows.map((row) => row.relname);
}

async function objectRows(): Promise<string[]> {
  const res = await db.query<{ bucket_id: string; name: string }>(
    `select bucket_id, name from storage.objects order by bucket_id, name`
  );
  return res.rows.map((row) => `${row.bucket_id}/${row.name}`);
}

async function bucketRows(): Promise<string[]> {
  const res = await db.query<{ id: string; name: string; public: boolean }>(
    `select id, name, public from storage.buckets order by id`
  );
  return res.rows.map((row) => `${row.id}/${row.name}/${row.public}`);
}

async function tableAcl(table: string): Promise<string | null> {
  const res = await db.query<{ acl: string | null }>(
    `select relacl::text as acl from pg_class where oid = to_regclass($1)`,
    [table]
  );
  return res.rows[0]?.acl ?? null;
}

async function visiblePostIds(
  role: 'anon' | 'authenticated',
  table: 'blog_posts' | 'portfolio_posts'
): Promise<number[]> {
  await db.exec(`set role ${role}`);
  try {
    const res = await db.query<{ id: number }>(
      `select id from public.${table} order by id`
    );
    return res.rows.map((row) => row.id);
  } finally {
    await db.exec('reset role');
  }
}

/** Relations the staged policy depends on (no dev schema, no other bucket). */
async function policyRelations(): Promise<string[]> {
  const res = await db.query<{ relation: string }>(
    `select distinct n.nspname || '.' || c.relname as relation
       from pg_policy pol
       join pg_depend d
         on d.objid = pol.oid
        and d.classid = 'pg_policy'::regclass
        and d.refclassid = 'pg_class'::regclass
       join pg_class c on c.oid = d.refobjid
       join pg_namespace n on n.oid = c.relnamespace
      where pol.polname = $1
      order by relation`,
    [POLICY]
  );
  return res.rows.map((row) => row.relation);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    -- Supabase ships service_role with BYPASSRLS; modelled here so the
    -- administrative path is exercised as configured live.
    create role service_role bypassrls;

    create schema storage;

    create function storage.operation() returns text language plpgsql stable as $fn$
    begin
      return current_setting('storage.operation', true);
    end $fn$;

    create function storage.allow_any_operation(expected_operations text[])
      returns boolean language sql stable as $fn$
      select exists (
        select 1
          from unnest(expected_operations) as expected
         where expected is not null
           and expected <> ''
           and current_setting('storage.operation', true) = expected
      );
    $fn$;

    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
    alter table storage.buckets enable row level security;
    -- Pre-existing policy on a DIFFERENT storage table: must not be touched.
    create policy buckets_keep_read on storage.buckets
      for select to anon using (public = true);

    create table storage.objects (
      id uuid primary key,
      bucket_id text not null,
      name text not null
    );
    alter table storage.objects enable row level security;
    -- Pre-existing, unrelated policy on storage.objects: real projects carry
    -- asset-bucket policies, and this one must survive untouched.
    create policy website_dev_asset_upload on storage.objects
      for insert to authenticated with check (bucket_id = '${ASSET_BUCKET}');

    create table public.blog_posts (
      id bigint primary key,
      created_at timestamptz not null default now(),
      hidden boolean not null default false,
      body_en_path text,
      body_it_path text
    );
    create table public.portfolio_posts (
      id bigint primary key,
      created_at timestamptz not null default now(),
      hidden boolean not null default false,
      body_en_path text,
      body_it_path text
    );
    alter table public.blog_posts enable row level security;
    alter table public.portfolio_posts enable row level security;

    -- Production read contract (20261006060140 §7), carried into the fixture.
    create policy cms_published_read on public.blog_posts
      for select to anon, authenticated using (hidden = false);
    create policy cms_published_read on public.portfolio_posts
      for select to anon, authenticated using (hidden = false);

    grant usage on schema public, storage to anon, authenticated, service_role;
    grant select on public.blog_posts, public.portfolio_posts
      to anon, authenticated, service_role;
    -- Deliberately permissive: every write denial must come from RLS, not from
    -- the absence of a GRANT.
    grant select, insert, update, delete on storage.objects
      to anon, authenticated, service_role;
    grant select on storage.buckets to anon, authenticated, service_role;

    insert into storage.buckets (id, name, public) values
      ('${PROD_BUCKET}', '${PROD_BUCKET}', false),
      ('${DEV_BUCKET}', '${DEV_BUCKET}', false),
      ('${ASSET_BUCKET}', '${ASSET_BUCKET}', true);

    insert into storage.objects (id, bucket_id, name) values
      ('00000000-0000-0000-0000-000000000001', '${PROD_BUCKET}', '${OBJ_A}'),
      ('00000000-0000-0000-0000-000000000002', '${PROD_BUCKET}', '${OBJ_B}'),
      ('00000000-0000-0000-0000-000000000003', '${PROD_BUCKET}', '${OBJ_C}'),
      ('00000000-0000-0000-0000-000000000004', '${PROD_BUCKET}', '${OBJ_D}'),
      ('00000000-0000-0000-0000-000000000005', '${DEV_BUCKET}', '${OBJ_A}'),
      ('00000000-0000-0000-0000-000000000006', '${ASSET_BUCKET}', '${OBJ_ASSET}'),
      ('00000000-0000-0000-0000-000000000007', '${PROD_BUCKET}', '${OBJ_F}'),
      ('00000000-0000-0000-0000-000000000008', '${PROD_BUCKET}', '${OBJ_G}'),
      ('00000000-0000-0000-0000-000000000009', '${PROD_BUCKET}', '${OBJ_H}'),
      ('00000000-0000-0000-0000-00000000000a', '${PROD_BUCKET}', '${OBJ_PREFIX}');

    insert into public.blog_posts
      (id, hidden, created_at, body_en_path, body_it_path) values
      (1, false, now() - interval '1 day', '${OBJ_A}', null),
      (2, true,  now() - interval '1 day', '${OBJ_B}', null),
      (3, false, now() - interval '1 day', null, '${OBJ_C}'),
      (4, false, now() + interval '1 day', '${OBJ_H}', null),
      (5, false, now() - interval '1 day', null, null);
    insert into public.portfolio_posts
      (id, hidden, created_at, body_en_path, body_it_path) values
      (11, false, now() - interval '1 day', '${OBJ_F}', null),
      (12, true,  now() - interval '1 day', null, '${OBJ_G}');
  `);

  // Before the staged policy exists NOTHING is downloadable: the policy is the
  // sole grantor of anonymous object reads.
  anonVisibleBefore = await objectsVisibleTo('anon', DOWNLOAD_OP);
  authVisibleBefore = await objectsVisibleTo('authenticated', DOWNLOAD_INFO_OP);

  policiesBefore = await policiesOn('storage', 'objects');
  allStorageBefore = await allStoragePolicies();
  postPoliciesBefore = [
    ...(await policiesOn('public', 'blog_posts')),
    ...(await policiesOn('public', 'portfolio_posts')),
  ];
  bucketsBefore = await bucketRows();
  aclsBefore = [
    (await tableAcl('storage.objects')) ?? 'null',
    (await tableAcl('storage.buckets')) ?? 'null',
  ];
  publicBefore = await publicObjects();

  const sql = await readFile(policyPath, 'utf8');
  await db.exec(sql);
  // Replay proves idempotency: a retried or resumed apply is a no-op.
  await db.exec(sql);

  policiesAfter = await policiesOn('storage', 'objects');
  allStorageAfter = await allStoragePolicies();
  postPoliciesAfter = [
    ...(await policiesOn('public', 'blog_posts')),
    ...(await policiesOn('public', 'portfolio_posts')),
  ];
  bucketsAfter = await bucketRows();
  aclsAfter = [
    (await tableAcl('storage.objects')) ?? 'null',
    (await tableAcl('storage.buckets')) ?? 'null',
  ];
  publicAfter = await publicObjects();
}, 120_000);

afterAll(async () => db.close());

describe('production content storage read policy', () => {
  it('replays safely to exactly one SELECT policy on storage.objects', () => {
    expect(policiesBefore).toEqual(['objects.website_dev_asset_upload/INSERT']);
    expect(policiesAfter).toEqual([
      `objects.${POLICY}/SELECT`,
      'objects.website_dev_asset_upload/INSERT',
    ]);
  });

  it('authorizes only the anon/authenticated download operations', async () => {
    const res = await db.query<{ cmd: string; roles: string; qual: string }>(
      `select cmd, roles::text as roles, qual from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = $1`,
      [POLICY]
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.cmd).toBe('SELECT');
    expect(res.rows[0]?.roles).toBe('{anon,authenticated}');
    const qual = res.rows[0]?.qual ?? '';
    expect(qual).toContain('allow_any_operation');
    expect(qual).toContain('hidden');
    expect(qual).toContain(`'${PROD_BUCKET}'`);
    expect(qual).not.toContain(DEV_BUCKET);
  }, 30_000);

  it('is the sole grantor of object downloads', () => {
    expect(anonVisibleBefore).toEqual([]);
    expect(authVisibleBefore).toEqual([]);
  });

  it('grants anon exactly the referenced visible bodies', async () => {
    expect(await objectsVisibleTo('anon', DOWNLOAD_OP)).toEqual(
      VISIBLE_DOWNLOADS
    );
  });

  it('grants the same to authenticated callers', async () => {
    expect(await objectsVisibleTo('authenticated', DOWNLOAD_INFO_OP)).toEqual(
      VISIBLE_DOWNLOADS
    );
    expect(await objectsVisibleTo('authenticated', DOWNLOAD_OP)).toEqual(
      VISIBLE_DOWNLOADS
    );
  });

  it('denies hidden, orphan, other-bucket and prefix objects to anon', async () => {
    const visible = await objectsVisibleTo('anon', DOWNLOAD_OP);
    expect(visible).not.toContain(OBJ_B); // hidden blog post pointer
    expect(visible).not.toContain(OBJ_G); // hidden portfolio post pointer
    expect(visible).not.toContain(OBJ_D); // orphan, referenced by no row
    expect(visible).not.toContain(OBJ_PREFIX); // bare prefix, no pointer
    expect(visible).not.toContain(OBJ_ASSET); // public asset bucket
  });

  it('never authorizes a listing or a prefix scan', async () => {
    expect(await objectsVisibleTo('anon', LIST_OP)).toEqual([]);
    expect(await objectsVisibleTo('authenticated', LIST_OP)).toEqual([]);
    // A Storage "list" request carries a prefix, not a download operation: the
    // prefix must yield nothing — neither hidden nor orphan objects.
    expect(await objectsVisibleTo('anon', LIST_OP, 'blog/')).toEqual([]);
    expect(await objectsVisibleTo('anon', LIST_OP, 'blog/1/')).toEqual([]);
    // Even an authorized download filtered by prefix stays inside the pointer
    // boundary.
    expect(await objectsVisibleTo('anon', DOWNLOAD_OP, 'blog/')).toEqual(
      [OBJ_A, OBJ_C, OBJ_H].sort()
    );
  }, 30_000);

  it('denies anonymous INSERT/UPDATE/DELETE on storage.objects', async () => {
    const before = await objectRows();
    const insert = await attemptWrite(
      'anon',
      `insert into storage.objects (id, bucket_id, name)
       values ('00000000-0000-0000-0000-0000000000ff', '${PROD_BUCKET}',
               '${OBJ_D}')
       returning name`
    );
    expect(insert.code).toBe('42501');
    expect(insert.rows).toBe(0);

    // UPDATE/DELETE match no row at all: anon cannot see a row for writing.
    const update = await attemptWrite(
      'anon',
      `update storage.objects set bucket_id = '${DEV_BUCKET}'
        where name = '${OBJ_A}' returning name`
    );
    expect(update).toEqual({ code: null, rows: 0 });
    const del = await attemptWrite(
      'anon',
      `delete from storage.objects where name = '${OBJ_A}' returning name`
    );
    expect(del).toEqual({ code: null, rows: 0 });
    expect(await objectRows()).toEqual(before);
  }, 30_000);

  it('keeps service-role administration working', async () => {
    // BYPASSRLS: the CMS path still sees every object in every bucket — hidden
    // and orphaned ones included — and is not bound to a download operation.
    expect(await objectsVisibleTo('service_role', DOWNLOAD_OP)).toEqual(
      ALL_OBJECTS
    );
    expect(await objectsVisibleTo('service_role', LIST_OP)).toEqual(
      ALL_OBJECTS
    );

    const inserted = await db.query<{ name: string }>(
      `insert into storage.objects (id, bucket_id, name)
       values ('00000000-0000-0000-0000-0000000000fe', '${PROD_BUCKET}',
               '${OBJ_A}')
       returning name`
    );
    expect(inserted.rows).toHaveLength(1);
    const deleted = await db.query<{ name: string }>(
      `delete from storage.objects
        where id = '00000000-0000-0000-0000-0000000000fe' returning name`
    );
    expect(deleted.rows).toHaveLength(1);
    expect(await objectRows()).toEqual(ALL_ROWS);
  }, 30_000);

  it('follows the post boundary: hiding a post hides its body', async () => {
    await db.exec(`update public.blog_posts set hidden = true where id = 1`);
    expect(await objectsVisibleTo('anon', DOWNLOAD_OP)).toEqual(
      [OBJ_C, OBJ_H, OBJ_F].sort()
    );
    await db.exec(`update public.blog_posts set hidden = false where id = 1`);
    expect(await objectsVisibleTo('anon', DOWNLOAD_OP)).toEqual(
      VISIBLE_DOWNLOADS
    );
  }, 30_000);

  it('keeps hidden bodies denied even if the table policy regresses', async () => {
    await db.exec(`
      drop policy cms_published_read on public.blog_posts;
      create policy widened_public_read on public.blog_posts
        for select to anon, authenticated using (true);
    `);
    // The regression is real: the hidden row is now table-readable...
    expect(await visiblePostIds('anon', 'blog_posts')).toEqual([1, 2, 3, 4, 5]);
    // ...but its body object is not: the object predicate is load-bearing.
    const visible = await objectsVisibleTo('anon', DOWNLOAD_OP);
    expect(visible).toEqual(VISIBLE_DOWNLOADS);
    expect(visible).not.toContain(OBJ_B);

    await db.exec(`
      drop policy widened_public_read on public.blog_posts;
      create policy cms_published_read on public.blog_posts
        for select to anon, authenticated using (hidden = false);
    `);
    expect(await visiblePostIds('anon', 'blog_posts')).toEqual([1, 3, 4, 5]);
    expect(await visiblePostIds('anon', 'portfolio_posts')).toEqual([11]);
  }, 30_000);

  it('binds only the two public post tables and storage.objects', async () => {
    expect(await policyRelations()).toEqual([
      'public.blog_posts',
      'public.portfolio_posts',
      'storage.objects',
    ]);
  }, 30_000);

  it('adds no write policy, bucket change or grant change', () => {
    // The only policy added anywhere in `storage` is the staged SELECT policy.
    expect(allStorageBefore).toEqual([
      'buckets.buckets_keep_read/SELECT',
      'objects.website_dev_asset_upload/INSERT',
    ]);
    expect(allStorageAfter).toEqual([
      'buckets.buckets_keep_read/SELECT',
      'objects.website_content_body_read/SELECT',
      'objects.website_dev_asset_upload/INSERT',
    ]);
    expect(
      policiesAfter.some(
        (p) => /\/(INSERT|UPDATE|DELETE|ALL)$/.test(p) && p.includes('content')
      )
    ).toBe(false);
    // Bucket metadata (private flag included) and storage ACLs are untouched.
    expect(bucketsAfter).toEqual(bucketsBefore);
    expect(bucketsAfter).toContain(`${PROD_BUCKET}/${PROD_BUCKET}/false`);
    expect(aclsAfter).toEqual(aclsBefore);
  });

  it('changes no post policy and no public object', () => {
    expect(postPoliciesAfter).toEqual(postPoliciesBefore);
    expect(postPoliciesAfter).toEqual([
      'blog_posts.cms_published_read/SELECT',
      'portfolio_posts.cms_published_read/SELECT',
    ]);
    expect(publicAfter).toEqual(publicBefore);
    // The staged SQL creates no `public` object: only the fixture's two tables
    // and their primary-key indexes exist.
    expect(publicAfter).toEqual([
      'blog_posts',
      'blog_posts_pkey',
      'portfolio_posts',
      'portfolio_posts_pkey',
    ]);
  });

  it('leaves exactly the staged policy after the mutating cases', async () => {
    expect(await policiesOn('storage', 'objects')).toEqual(policiesAfter);
    expect(await allStoragePolicies()).toEqual(allStorageAfter);
  }, 30_000);
});

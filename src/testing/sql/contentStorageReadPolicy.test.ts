import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the dev content-bucket read-policy migration against a real Postgres
 * (PGlite, WASM) with the minimum Storage surface it needs:
 *
 * - `storage.objects` with RLS enabled, plus a pre-existing policy on
 *   `storage.buckets` that must survive untouched;
 * - `storage.operation()` / `storage.allow_any_operation(text[])` stubs that
 *   mirror the live helpers' behaviour (the migration's real helper call is
 *   asserted separately in devCheck's storage contract);
 * - `dev_staging` post tables carrying the Phase 2B `cms_published_read` RLS.
 *
 * The test proves the effective visibility model through actual RLS enforcement
 * as `anon` / `authenticated`, not by reading SQL text.
 */

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261017185848_add_content_storage_read_policy_dev_staging.sql',
    import.meta.url
  )
);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);

const OBJ_A = `blog/1/en/${HASH_A}.md`;
const OBJ_B = `blog/2/en/${HASH_B}.md`;
const OBJ_C = `blog/3/en/${HASH_C}.md`;
const OBJ_D = `blog/9/en/${HASH_D}.md`;
const OBJ_E = `blog/1/en/${HASH_E}.md`;
const OBJ_F = `portfolio/11/it/${HASH_F}.md`;

let db: PGlite;
let storagePoliciesBefore: string[] = [];
let storagePoliciesAfter: string[] = [];
let devPostPoliciesBefore: string[] = [];
let devPostPoliciesAfter: string[] = [];
let publicBefore: string[] = [];
let publicAfter: string[] = [];

async function visibleObjects(
  role: 'anon' | 'authenticated',
  operation: string
): Promise<string[]> {
  await db.exec(`select set_config('storage.operation', '${operation}', false)`);
  await db.exec(`set role ${role}`);
  try {
    const res = await db.query<{ name: string }>(
      `select name from storage.objects order by name`
    );
    return res.rows.map((row) => row.name);
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
  return res.rows.map((row) => `${row.policyname}/${row.cmd}`);
}

async function publicObjects(): Promise<string[]> {
  const res = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','i','S') order by c.relname`
  );
  return res.rows.map((row) => row.relname);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;

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
    -- A pre-existing policy on a DIFFERENT storage table: must not be touched.
    create policy buckets_keep_read on storage.buckets
      for select to anon using (public = true);

    create table storage.objects (
      id uuid primary key,
      bucket_id text not null,
      name text not null
    );
    alter table storage.objects enable row level security;

    create schema dev_staging;

    create table dev_staging.blog_posts (
      id bigint primary key,
      hidden boolean not null default false,
      created_at timestamptz not null default now(),
      body_en_path text,
      body_it_path text
    );
    create table dev_staging.portfolio_posts (
      id bigint primary key,
      hidden boolean not null default false,
      created_at timestamptz not null default now(),
      body_en_path text,
      body_it_path text
    );
    alter table dev_staging.blog_posts enable row level security;
    alter table dev_staging.portfolio_posts enable row level security;

    -- Phase 2B post visibility contract, carried into this fixture.
    create policy cms_published_read on dev_staging.blog_posts
      for select to anon, authenticated using (hidden = false);
    create policy cms_published_read on dev_staging.portfolio_posts
      for select to anon, authenticated using (hidden = false);

    grant usage on schema dev_staging to anon, authenticated;
    grant select on dev_staging.blog_posts, dev_staging.portfolio_posts
      to anon, authenticated;
    grant usage on schema storage to anon, authenticated;
    grant select on storage.objects, storage.buckets to anon, authenticated;

    insert into storage.buckets (id, name, public) values
      ('website-content-dev', 'website-content-dev', false),
      ('website-dev', 'website-dev', true);

    insert into storage.objects (id, bucket_id, name) values
      ('00000000-0000-0000-0000-00000000000a', 'website-content-dev', '${OBJ_A}'),
      ('00000000-0000-0000-0000-00000000000b', 'website-content-dev', '${OBJ_B}'),
      ('00000000-0000-0000-0000-00000000000c', 'website-content-dev', '${OBJ_C}'),
      ('00000000-0000-0000-0000-00000000000d', 'website-content-dev', '${OBJ_D}'),
      ('00000000-0000-0000-0000-00000000000e', 'website-dev',         '${OBJ_E}'),
      ('00000000-0000-0000-0000-00000000000f', 'website-content-dev', '${OBJ_F}');

    insert into dev_staging.blog_posts (id, hidden, created_at, body_en_path) values
      (1, false, now() - interval '1 day', '${OBJ_A}'),
      (2, true,  now() - interval '1 day', '${OBJ_B}'),
      (3, false, now() + interval '1 day', '${OBJ_C}');
    insert into dev_staging.portfolio_posts (id, hidden, created_at, body_it_path) values
      (11, false, now() - interval '1 day', '${OBJ_F}');
  `);

  storagePoliciesBefore = await policiesOn('storage', 'objects');
  devPostPoliciesBefore = [
    ...(await policiesOn('dev_staging', 'blog_posts')),
    ...(await policiesOn('dev_staging', 'portfolio_posts')),
  ];
  publicBefore = await publicObjects();

  const sql = await readFile(migrationPath, 'utf8');
  await db.exec(sql);
  // Replay proves idempotency: a retried or resumed apply is a no-op.
  await db.exec(sql);

  storagePoliciesAfter = await policiesOn('storage', 'objects');
  devPostPoliciesAfter = [
    ...(await policiesOn('dev_staging', 'blog_posts')),
    ...(await policiesOn('dev_staging', 'portfolio_posts')),
  ];
  publicAfter = await publicObjects();
}, 120_000);

afterAll(async () => db.close());

describe('dev content storage read policy', () => {
  it('replays safely to exactly one SELECT policy on storage.objects', () => {
    expect(storagePoliciesAfter).toEqual([
      'website_content_dev_body_read/SELECT',
    ]);
    expect(storagePoliciesBefore).toEqual([]);
  });

  it('grants anon object download for referenced visible bodies only', async () => {
    const visible = await visibleObjects('anon', 'object.get_authenticated');
    expect(visible).toEqual([OBJ_A, OBJ_C, OBJ_F].sort());
  });

  it('grants the same to authenticated callers', async () => {
    const visible = await visibleObjects(
      'authenticated',
      'object.get_authenticated_info'
    );
    expect(visible).toEqual([OBJ_A, OBJ_C, OBJ_F].sort());
  });

  it('does not expose hidden, orphan or other-bucket objects', async () => {
    const visible = await visibleObjects('anon', 'object.get_authenticated');
    expect(visible).not.toContain(OBJ_B); // hidden post pointer
    expect(visible).not.toContain(OBJ_D); // orphan, unreferenced
    expect(visible).not.toContain(OBJ_E); // different bucket
  });

  it('does not authorize bucket listing operations', async () => {
    expect(await visibleObjects('anon', 'object.list')).toEqual([]);
    expect(await visibleObjects('authenticated', 'object.list')).toEqual([]);
  });

  it('inherits the dev post RLS boundary rather than duplicating it', async () => {
    // Flipping the referenced post to hidden removes its object from visibility.
    await db.exec(`update dev_staging.blog_posts set hidden = true where id = 1`);
    expect(await visibleObjects('anon', 'object.get_authenticated')).toEqual(
      [OBJ_C, OBJ_F].sort()
    );
    await db.exec(`update dev_staging.blog_posts set hidden = false where id = 1`);
  }, 30_000);

  it('adds no write policy and changes no other storage policy', async () => {
    const all = await db.query<{ policyname: string; cmd: string }>(
      `select policyname, cmd from pg_policies where schemaname = 'storage' order by policyname`
    );
    const byName = all.rows.map((row) => `${row.policyname}/${row.cmd}`);
    expect(byName).toEqual([
      'buckets_keep_read/SELECT',
      'website_content_dev_body_read/SELECT',
    ]);
    expect(
      byName.some(
        (p) =>
          /\/(INSERT|UPDATE|DELETE|ALL)$/.test(p) && p.includes('content')
      )
    ).toBe(false);
  }, 30_000);

  it('changes no dev post policy and no public object', () => {
    expect(devPostPoliciesAfter).toEqual(devPostPoliciesBefore);
    expect(publicAfter).toEqual(publicBefore);
    expect(publicAfter).toEqual([]);
  });

  it('contains no bucket-metadata SQL', async () => {
    const raw = await readFile(migrationPath, 'utf8');
    const sql = raw
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .toLowerCase();
    expect(sql).not.toMatch(/storage\.buckets/);
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate)\b/);
    expect(sql).not.toMatch(/\b(create policy|drop policy)\b[^;]*\bfor\s+(insert|update|delete|all)\b/);
    expect(sql).toMatch(/create policy website_content_dev_body_read on storage\.objects/);
    expect(sql).toMatch(/for select to anon, authenticated/);
    expect(sql).toMatch(/storage\.allow_any_operation/);
  });
});

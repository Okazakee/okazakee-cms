import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the dev body-path schema migration against a real Postgres (PGlite,
 * WASM) seeded with the current dev shape (legacy `body_en`/`body_it`, no path
 * columns) and proves the new pointers are nullable, correctly constrained and
 * fully backward-compatible.
 */

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261017170828_add_body_storage_paths_dev_staging.sql',
    import.meta.url
  )
);

const HASH = '0123456789abcdef'.repeat(4); // 64 lowercase hex chars

let db: PGlite;
let bodyBefore: Record<string, unknown>[] = [];
let bodyAfter: Record<string, unknown>[] = [];
let pathsAfter: Record<string, unknown>[] = [];
let policiesBefore: string[] = [];
let policiesAfter: string[] = [];
let indexesBefore: string[] = [];
let indexesAfter: string[] = [];
let aclBefore: (string | null)[] = [];
let aclAfter: (string | null)[] = [];
let publicBefore: string[] = [];
let publicAfter: string[] = [];

async function columnInfo(
  table: string
): Promise<Record<string, { type: string; nullable: boolean }>> {
  const res = await db.query<{
    attname: string;
    formatted_type: string;
    nullable: boolean;
  }>(
    `select a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted_type,
            not a.attnotnull as nullable
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'dev_staging' and c.relname = $1
        and a.attnum > 0 and not a.attisdropped`,
    [table]
  );
  const out: Record<string, { type: string; nullable: boolean }> = {};
  for (const row of res.rows) {
    out[row.attname] = {
      type: row.formatted_type,
      nullable: Boolean(row.nullable),
    };
  }
  return out;
}

async function bodyRows(): Promise<Record<string, unknown>[]> {
  const res = await db.query<Record<string, unknown>>(
    `select id, body_en, body_it
       from dev_staging.blog_posts order by id`
  );
  return res.rows;
}

async function pathRows(): Promise<Record<string, unknown>[]> {
  const res = await db.query<Record<string, unknown>>(
    `select id, body_en_path, body_it_path
       from dev_staging.blog_posts order by id`
  );
  return res.rows;
}

async function policyNames(): Promise<string[]> {
  const res = await db.query<{ policyname: string }>(
    `select policyname from pg_policies where schemaname = 'dev_staging' order by policyname`
  );
  return res.rows.map((row) => row.policyname);
}

async function indexNames(): Promise<string[]> {
  const res = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'dev_staging' order by indexname`
  );
  return res.rows.map((row) => row.indexname);
}

async function tableAcl(table: string): Promise<string | null> {
  const res = await db.query<{ acl: string | null }>(
    `select relacl::text as acl from pg_class where oid = to_regclass($1)`,
    [table]
  );
  return res.rows[0]?.acl ?? null;
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
    create schema dev_staging;

    create table dev_staging.blog_posts (
      id bigint primary key,
      author_id uuid,
      hidden boolean not null default false,
      body_en text not null,
      body_it text,
      created_at timestamptz not null default now()
    );
    create table dev_staging.portfolio_posts (
      id bigint primary key,
      author_id uuid,
      hidden boolean not null default false,
      body_en text not null,
      body_it text,
      created_at timestamptz not null default now()
    );

    grant usage on schema dev_staging to anon;
    grant select on dev_staging.blog_posts, dev_staging.portfolio_posts to anon;

    -- Existing policy / index / grant that must survive unchanged.
    create policy cms_published_read
      on dev_staging.blog_posts for select to anon using (hidden = false);
    create index blog_posts_author_id_idx on dev_staging.blog_posts (author_id);

    insert into dev_staging.blog_posts (id, body_en, body_it) values
      (7, '# legacy en seven', '# legacy it seven'),
      (8, '# legacy en eight', null);
    insert into dev_staging.portfolio_posts (id, body_en, body_it) values
      (11, '# legacy en eleven', '# legacy it eleven');
  `);

  bodyBefore = await bodyRows();
  policiesBefore = await policyNames();
  indexesBefore = await indexNames();
  aclBefore = [
    await tableAcl('dev_staging.blog_posts'),
    await tableAcl('dev_staging.portfolio_posts'),
  ];
  publicBefore = await publicObjects();

  const sql = await readFile(migrationPath, 'utf8');
  await db.exec(sql);
  // Replay proves idempotency: a retried or resumed apply is a no-op.
  await db.exec(sql);

  bodyAfter = await bodyRows();
  pathsAfter = await pathRows();
  policiesAfter = await policyNames();
  indexesAfter = await indexNames();
  aclAfter = [
    await tableAcl('dev_staging.blog_posts'),
    await tableAcl('dev_staging.portfolio_posts'),
  ];
  publicAfter = await publicObjects();
}, 120_000);

afterAll(async () => db.close());

describe('dev body storage path schema', () => {
  it('adds nullable text path columns on both tables', async () => {
    for (const table of ['blog_posts', 'portfolio_posts']) {
      const cols = await columnInfo(table);
      expect(cols.body_en_path).toEqual({ type: 'text', nullable: true });
      expect(cols.body_it_path).toEqual({ type: 'text', nullable: true });
    }
  }, 30_000);

  it('keeps the legacy columns exactly as they were', async () => {
    for (const table of ['blog_posts', 'portfolio_posts']) {
      const cols = await columnInfo(table);
      expect(cols.body_en).toEqual({ type: 'text', nullable: false });
      expect(cols.body_it).toEqual({ type: 'text', nullable: true });
    }
  }, 30_000);

  it('leaves legacy body values unchanged and paths NULL during the transition', () => {
    expect(bodyAfter).toEqual(bodyBefore);
    expect(pathsAfter).toEqual([
      { id: 7, body_en_path: null, body_it_path: null },
      { id: 8, body_en_path: null, body_it_path: null },
    ]);
  });

  it('accepts canonical content-addressed paths for the row itself', async () => {
    await db.exec(
      `update dev_staging.blog_posts
          set body_en_path = 'blog/7/en/${HASH}.md',
              body_it_path = 'blog/7/it/${HASH}.md'
        where id = 7`
    );
    await db.exec(
      `update dev_staging.portfolio_posts
          set body_en_path = 'portfolio/11/en/${HASH}.md',
              body_it_path = 'portfolio/11/it/${HASH}.md'
        where id = 11`
    );
    const blog = await db.query<{ body_en_path: string; body_it_path: string }>(
      `select body_en_path, body_it_path from dev_staging.blog_posts where id = 7`
    );
    expect(blog.rows[0]?.body_en_path).toBe(`blog/7/en/${HASH}.md`);
    expect(blog.rows[0]?.body_it_path).toBe(`blog/7/it/${HASH}.md`);
  }, 30_000);

  it.each([
    ['wrong row id', 'blog/8/en'],
    ['wrong content type prefix', 'portfolio/7/en'],
    ['wrong language', 'blog/7/fr'],
  ])('rejects %s', async (_label, prefix) => {
    await expect(
      db.exec(
        `update dev_staging.blog_posts set body_en_path = '${prefix}/${HASH}.md' where id = 7`
      )
    ).rejects.toThrow();
  }, 30_000);

  it.each([
    ['63-char hash', `${HASH.slice(0, 63)}`],
    ['65-char hash', `${HASH}a`],
    ['uppercase hash', HASH.toUpperCase().slice(0, 64)],
  ])('rejects %s', async (_label, hash) => {
    await expect(
      db.exec(
        `update dev_staging.blog_posts set body_en_path = 'blog/7/en/${hash}.md' where id = 7`
      )
    ).rejects.toThrow();
  }, 30_000);

  it.each([
    ['leading slash', `/blog/7/en/${HASH}.md`],
    ['mdx extension', `blog/7/en/${HASH}.mdx`],
    ['trailing path component', `blog/7/en/${HASH}.md/extra`],
  ])('rejects %s', async (_label, value) => {
    await expect(
      db.exec(
        `update dev_staging.blog_posts set body_en_path = '${value}' where id = 7`
      )
    ).rejects.toThrow();
  }, 30_000);

  it('accepts NULL paths (transition state)', async () => {
    await db.exec(
      `update dev_staging.blog_posts set body_en_path = null, body_it_path = null where id = 8`
    );
    const res = await db.query<{ body_en_path: null }>(
      `select body_en_path from dev_staging.blog_posts where id = 8`
    );
    expect(res.rows[0]?.body_en_path).toBeNull();
  }, 30_000);

  it('creates all four expected CHECK constraints', async () => {
    const res = await db.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid in ('dev_staging.blog_posts'::regclass,
                           'dev_staging.portfolio_posts'::regclass)
          and contype = 'c'
        order by conname`
    );
    expect(res.rows.map((r) => r.conname)).toEqual([
      'blog_posts_body_en_path_check',
      'blog_posts_body_it_path_check',
      'portfolio_posts_body_en_path_check',
      'portfolio_posts_body_it_path_check',
    ]);
  }, 30_000);

  it('touches no public or storage object, policy, grant or index', async () => {
    expect(publicAfter).toEqual(publicBefore);
    expect(publicAfter).toEqual([]);
    expect(policiesAfter).toEqual(policiesBefore);
    expect(indexesAfter).toEqual(indexesBefore);
    expect(aclAfter).toEqual(aclBefore);
    const storage = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'storage'`
    );
    expect(storage.rows[0]?.n).toBe(0);
  }, 30_000);

  it('contains only column adds and guarded constraint additions', async () => {
    const raw = await readFile(migrationPath, 'utf8');
    const stripped = raw
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .toLowerCase();
    expect(stripped).not.toMatch(/\bpublic\./);
    expect(stripped).not.toMatch(/\bstorage\b\s*\./);
    expect(stripped).not.toMatch(
      /\b(drop|insert into|update .*set|delete|truncate|grant|revoke|create policy|drop policy|create index|create function)\b/
    );
    expect(stripped).toContain('add column if not exists');
    expect(stripped).toContain('add constraint');
  });
});

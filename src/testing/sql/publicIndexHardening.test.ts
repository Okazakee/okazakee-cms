import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the production (`public`) FK-index migration against a real Postgres
 * (PGlite, WASM) seeded with the live production index shape — including the
 * historically named primary keys / indexes — and proves it adds only the three
 * required indexes while dropping nothing.
 *
 * The fixture intentionally reproduces the non-standard live names
 * (`posts_pkey`, `skills_pkey1`, `skill_categories_pkey`,
 * `idx_blog_posts_views`, `idx_portfolio_posts_views`,
 * `idx_skills_categories_position`) so the test would fail if the migration ever
 * tried to normalize or recreate them.
 */

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261017161925_optimize_indexes_public.sql',
    import.meta.url
  )
);

const REQUIRED_INDEXES = [
  'blog_posts_author_id_idx',
  'portfolio_posts_author_id_idx',
  'skills_category_position_id_idx',
];

const KEEP_INDEXES = [
  'blog_posts_pkey',
  'posts_pkey',
  'skills_pkey1',
  'skill_categories_pkey',
  'project_requests_pkey',
  'site_settings_pkey',
  'idx_blog_posts_views',
  'idx_portfolio_posts_views',
  'idx_skills_categories_position',
  'project_requests_active_idx',
];

let db: PGlite;
let indexesBefore: string[] = [];
let indexesAfter: string[] = [];

async function indexNames(schema: string): Promise<string[]> {
  const res = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = $1 order by indexname`,
    [schema]
  );
  return res.rows.map((row) => row.indexname);
}

/** Column names of an index, in index key order. */
async function indexColumns(name: string): Promise<string[]> {
  const res = await db.query<{ attname: string }>(
    `select a.attname
       from pg_index i
       cross join lateral unnest(i.indkey::smallint[])
         with ordinality as k(attnum, ord)
       join pg_attribute a
         on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indexrelid = to_regclass('public.' || $1)
      order by k.ord`,
    [name]
  );
  return res.rows.map((row) => row.attname);
}

beforeAll(async () => {
  db = new PGlite();
  // Live production shape: real (non-standard) primary-key and index names.
  await db.exec(`
    create table public.blog_posts (
      id bigint,
      author_id uuid,
      views integer not null default 0,
      constraint blog_posts_pkey primary key (id)
    );
    create index idx_blog_posts_views on public.blog_posts (views);

    create table public.portfolio_posts (
      id bigint,
      author_id uuid,
      views integer not null default 0,
      constraint posts_pkey primary key (id)
    );
    create index idx_portfolio_posts_views on public.portfolio_posts (views);

    create table public.skills_categories (
      id bigint,
      position integer not null default 0,
      constraint skill_categories_pkey primary key (id)
    );
    create index idx_skills_categories_position
      on public.skills_categories (position);

    create table public.skills (
      id bigint,
      category_id bigint references public.skills_categories (id),
      position integer,
      constraint skills_pkey1 primary key (id)
    );

    create table public.project_requests (
      id bigint,
      archived boolean not null default false,
      created_at timestamptz not null default now(),
      constraint project_requests_pkey primary key (id)
    );
    create index project_requests_active_idx
      on public.project_requests (archived, created_at desc);

    create table public.site_settings (
      id bigint,
      constraint site_settings_pkey primary key (id)
    );
  `);
  indexesBefore = await indexNames('public');
  const sql = await readFile(migrationPath, 'utf8');
  await db.exec(sql);
  // Replay proves idempotency: a retried or resumed apply is a no-op.
  await db.exec(sql);
  indexesAfter = await indexNames('public');
}, 120_000);

afterAll(async () => db.close());

describe('production FK index hardening', () => {
  it('creates the three required indexes', async () => {
    expect(indexesAfter).toEqual(expect.arrayContaining(REQUIRED_INDEXES));
  }, 30_000);

  it('builds the skills composite as exactly (category_id, position, id)', async () => {
    expect(await indexColumns('skills_category_position_id_idx')).toEqual([
      'category_id',
      'position',
      'id',
    ]);
    // The composite covers the FK, so no standalone category_id index is added.
    expect(indexesAfter).not.toContain('skills_category_id_idx');
  }, 30_000);

  it('creates no redundant index beyond the three required ones', () => {
    const added = indexesAfter.filter((n) => !indexesBefore.includes(n));
    expect([...added].sort()).toEqual([...REQUIRED_INDEXES].sort());
  });

  it('drops no existing index and keeps the non-standard live names', () => {
    for (const kept of KEEP_INDEXES) {
      expect(indexesBefore).toContain(kept);
      expect(indexesAfter).toContain(kept);
    }
    expect(indexesBefore.every((n) => indexesAfter.includes(n))).toBe(true);
  });

  it('touches no dev_staging object', async () => {
    const schemas = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_namespace where nspname = 'dev_staging'`
    );
    expect(schemas.rows[0]?.n).toBe(0);
    expect(await indexNames('dev_staging')).toEqual([]);
  });

  it('contains exactly the three CREATE INDEX statements and nothing else', async () => {
    const raw = await readFile(migrationPath, 'utf8');
    // Comments may explain context (including the dev_staging counterpart);
    // only the executable SQL is a scope contract.
    const stripped = raw
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const statements = stripped
      .split(';')
      .map((part) => part.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
    expect(statements).toEqual([
      'create index if not exists blog_posts_author_id_idx on public.blog_posts (author_id)',
      'create index if not exists portfolio_posts_author_id_idx on public.portfolio_posts (author_id)',
      'create index if not exists skills_category_position_id_idx on public.skills (category_id, position, id)',
    ]);
    const sql = stripped.toLowerCase();
    expect(sql).not.toContain('dev_staging');
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(
      /\b(insert|update|delete|truncate|alter|grant|revoke|create policy)\b/
    );
  });
});

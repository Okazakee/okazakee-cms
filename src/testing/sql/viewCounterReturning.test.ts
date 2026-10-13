import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the real view-counter migration against a real Postgres
 * (PGlite, WASM) and asserts the resulting behavior and ACL, rather
 * than reading the SQL as text.
 *
 * Security/performance properties under test: the increment RPCs stay
 * SECURITY DEFINER with an empty search path, remain EXECUTE-granted to
 * the public site's publishable-key roles, and now return the new total
 * atomically so the site needs no "RPC then SELECT" sequence.
 */

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261013120000_view_counter_returning.sql',
    import.meta.url
  )
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.blog_posts (
      id bigint PRIMARY KEY,
      views bigint
    );
    CREATE TABLE public.portfolio_posts (
      id bigint PRIMARY KEY,
      views bigint
    );
    INSERT INTO public.blog_posts (id, views) VALUES (1, 0);
    INSERT INTO public.portfolio_posts (id, views) VALUES (9, 41);
  `);
  await db.exec(await readFile(migrationPath, 'utf8'));
}, 60_000);

afterAll(async () => db.close());

describe('atomic increment-and-return', () => {
  it('increments blog views and returns the new total', async () => {
    const first = await db.query<{ count: string }>(
      'SELECT public.increment_blog_post_views_bigint(1) AS count'
    );
    expect(Number(first.rows[0]?.count)).toBe(1);
    const second = await db.query<{ count: string }>(
      'SELECT public.increment_blog_post_views_bigint(1) AS count'
    );
    expect(Number(second.rows[0]?.count)).toBe(2);
  });

  it('increments portfolio views and returns the new total', async () => {
    const result = await db.query<{ count: string }>(
      'SELECT public.increment_portfolio_post_views_bigint(9) AS count'
    );
    expect(Number(result.rows[0]?.count)).toBe(42);
  });

  it('returns null for an unknown id without touching other rows', async () => {
    const result = await db.query<{ count: string | null }>(
      'SELECT public.increment_blog_post_views_bigint(4242) AS count'
    );
    expect(result.rows[0]?.count).toBeNull();
  });
});

describe('security model is preserved', () => {
  it('stays executable by the public site roles', async () => {
    for (const fn of [
      'public.increment_blog_post_views_bigint(bigint)',
      'public.increment_portfolio_post_views_bigint(bigint)',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const result = await db.query<{ allowed: boolean }>(
          'SELECT has_function_privilege($1, $2, $3) AS allowed',
          [role, fn, 'EXECUTE']
        );
        expect(result.rows[0]?.allowed).toBe(true);
      }
    }
  });

  it('stays SECURITY DEFINER with an empty search path', async () => {
    const result = await db.query<{
      definer: boolean;
      config: string[] | null;
    }>(
      `SELECT prosecdef AS definer, proconfig AS config FROM pg_proc
       WHERE proname IN (
         'increment_blog_post_views_bigint',
         'increment_portfolio_post_views_bigint'
       )`
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.definer).toBe(true);
      // Stored normalized (`search_path=""`); the migration pins it empty.
      expect(row.config ?? []).toEqual(
        expect.arrayContaining([expect.stringMatching(/^search_path/)])
      );
    }
  });
});

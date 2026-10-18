import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the REVIEW-ONLY CAS artifact against a real Postgres (PGlite, WASM)
 * on an isolated `dev_staging` schema. It proves, without touching the live
 * project:
 *
 *   - the guard lives in the write statement (a stale body hash or a drifted
 *     pointer yields STALE and leaves the row untouched);
 *   - APPLIED / ALREADY_CURRENT / STALE / MISSING and the INVALID_* input
 *     refusals are unambiguous;
 *   - rollback restores only while the installed pointer and the hashed body
 *     are unchanged;
 *   - the security model holds: SECURITY DEFINER, fixed search_path, EXECUTE
 *     revoked from PUBLIC/anon/authenticated and granted to service_role only,
 *     functions in `dev_staging`, and no reference to `public` or Storage.
 */

const casPath = fileURLToPath(
  new URL('../../../supabase/review/dev_markdown_backfill_cas.sql', import.meta.url)
);
const bodyPathsMigrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261017170828_add_body_storage_paths_dev_staging.sql',
    import.meta.url
  )
);

let db: PGlite;
let casSql = '';

const sha = (body: string) =>
  createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');

const path = (
  kind: 'blog' | 'portfolio',
  id: number,
  locale: 'en' | 'it',
  body: string
) => `${kind}/${id}/${locale}/${sha(body)}.md`;

type CasRow = { outcome: string; reason: string | null };

async function cas(args: [
  string,
  number,
  string,
  string,
  string | null,
  string,
]): Promise<CasRow> {
  const res = await db.query<CasRow>(
    `select outcome, reason
       from dev_staging.dev_backfill_body_pointer_cas($1, $2, $3, $4, $5, $6)`,
    args
  );
  return res.rows[0];
}

async function rollback(args: [
  string,
  number,
  string,
  string,
  string,
  string | null,
]): Promise<CasRow> {
  const res = await db.query<CasRow>(
    `select outcome, reason
       from dev_staging.dev_backfill_body_pointer_rollback($1, $2, $3, $4, $5, $6)`,
    args
  );
  return res.rows[0];
}

async function state(
  table: 'blog_posts' | 'portfolio_posts',
  id: number
): Promise<{ body_en: string; body_it: string; body_en_path: string | null; body_it_path: string | null }> {
  const res = await db.query<{
    body_en: string;
    body_it: string;
    body_en_path: string | null;
    body_it_path: string | null;
  }>(
    `select body_en, body_it, body_en_path, body_it_path
       from dev_staging.${table} where id = $1`,
    [id]
  );
  return res.rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  casSql = await readFile(casPath, 'utf8');

  // Roles the live project provides; created here so the GRANT/REVOKE block
  // exercises the same privileges.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema dev_staging;
    create table dev_staging.blog_posts (
      id bigint primary key,
      body_en text not null,
      body_it text,
      title_en text not null default ''
    );
    create table dev_staging.portfolio_posts (
      id bigint primary key,
      body_en text not null,
      body_it text,
      title_en text not null default ''
    );
  `);

  // The shipped dev pointer migration adds body_*_path + the canonical CHECKs.
  await db.exec(await readFile(bodyPathsMigrationPath, 'utf8'));

  // The staged review artifact, exactly as it would be promoted.
  await db.exec(casSql);
});

afterAll(async () => {
  await db?.close();
});

describe('staged CAS SQL: artifact shape', () => {
  it('is review-only and free of dynamic SQL or public/Storage references', () => {
    expect(casSql).toContain('REVIEW-ONLY');
    expect(casSql).toContain('security definer');
    expect(casSql).toContain('set search_path = pg_catalog, pg_temp');
    expect(casSql.toLowerCase()).not.toContain('execute format');
    expect(casSql.toLowerCase()).not.toContain('execute immediate');
    // No statement may target the storage schema or the public schema.
    expect(casSql.toLowerCase()).not.toMatch(/\b(from|into|update|join)\s+storage\./);
    expect(casSql.toLowerCase()).not.toMatch(/\b(from|into|update|join)\s+public\./);
    // Only the two dev_staging tables are touched, and only pointer columns.
    expect(casSql.match(/update dev_staging\.(blog_posts|portfolio_posts) [bp]/g)).toHaveLength(4);
    expect(casSql).toContain('grant execute on function dev_staging.dev_backfill_body_pointer_cas');
    expect(casSql).toContain('revoke all on function dev_staging.dev_backfill_body_pointer_cas');
    expect(casSql).toContain('from anon');
    expect(casSql).toContain('from authenticated');
    expect(casSql).toContain('from public');
  });

  it('installs both functions in dev_staging as SECURITY DEFINER with a fixed search_path', async () => {
    const res = await db.query<{
      proname: string;
      nspname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      proacl: string[] | null;
    }>(
      `select p.proname, n.nspname, p.prosecdef, p.proconfig, p.proacl
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.proname like 'dev_backfill%'
        order by p.proname`
    );
    expect(res.rows.map((r) => r.proname)).toEqual([
      'dev_backfill_body_pointer_cas',
      'dev_backfill_body_pointer_rollback',
    ]);
    for (const row of res.rows) {
      expect(row.nspname).toBe('dev_staging');
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      const acl = row.proacl ?? [];
      // PUBLIC has no grant (`=X/...` entries are the PUBLIC default).
      expect(acl.some((entry) => entry.startsWith('='))).toBe(false);
      expect(acl.some((entry) => entry.startsWith('anon='))).toBe(false);
      expect(acl.some((entry) => entry.startsWith('authenticated='))).toBe(false);
      expect(acl.some((entry) => entry.startsWith('service_role=X'))).toBe(true);
    }
  });

  it('defines no function in the public schema and none outside dev_staging', async () => {
    const res = await db.query<{ n: number }>(
      `select count(*)::int as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname like 'dev_backfill%' and n.nspname <> 'dev_staging'`
    );
    expect(res.rows[0].n).toBe(0);
  });
});

describe('forward CAS', () => {
  const bodyEn = '# blog 1 EN 🎉\r\n\r\nünïcodé ✓\r\n';

  beforeAll(async () => {
    await db.query(
      `insert into dev_staging.blog_posts (id, body_en, body_it) values
         (1, $1, '# blog 1 IT à'),
         (2, '# blog 2 EN', null),
         (3, '# blog 3 EN moved', '# blog 3 IT')`,
      [bodyEn]
    );
    await db.query(
      `insert into dev_staging.portfolio_posts (id, body_en, body_it) values
         (1, '# pf 1 EN', '# pf 1 IT')`
    );
  });

  it('applies a NULL -> canonical pointer when the body hash and previous pointer match', async () => {
    const target = path('blog', 1, 'en', bodyEn);
    expect(await cas(['blog', 1, 'en', sha(bodyEn), null, target])).toEqual({
      outcome: 'APPLIED',
      reason: null,
    });
    const row = await state('blog_posts', 1);
    expect(row.body_en_path).toBe(target);
    expect(row.body_it_path).toBeNull();
    // legacy columns untouched, byte for byte (CRLF + Unicode preserved)
    expect(row.body_en).toBe(bodyEn);
    expect(sha(row.body_en)).toBe(sha(bodyEn));
  });

  it('reports ALREADY_CURRENT without writing when the pointer is already the target', async () => {
    const target = path('blog', 1, 'en', bodyEn);
    expect(await cas(['blog', 1, 'en', sha(bodyEn), null, target])).toEqual({
      outcome: 'ALREADY_CURRENT',
      reason: null,
    });
    expect((await state('blog_posts', 1)).body_en_path).toBe(target);
  });

  it('returns STALE (body_changed) and leaves the pointer untouched when the committed body changed', async () => {
    // A CMS edit lands after planning: same row, different body.
    await db.query(`update dev_staging.blog_posts set body_en = '# edited by a CMS user' where id = 3`);
    const planned = sha('# blog 3 EN moved');
    const target = path('blog', 3, 'en', '# blog 3 EN moved');

    expect(await cas(['blog', 3, 'en', planned, null, target])).toEqual({
      outcome: 'STALE',
      reason: 'body_changed',
    });
    // The critical atomicity property: no write happened.
    expect((await state('blog_posts', 3)).body_en_path).toBeNull();
  });

  it('returns STALE (pointer_drift) and leaves the pointer untouched when it moved since planning', async () => {
    const drifted = `blog/2/en/${'a'.repeat(64)}.md`;
    await db.query(`update dev_staging.blog_posts set body_en_path = $1 where id = 2`, [drifted]);

    const target = path('blog', 2, 'en', '# blog 2 EN');
    // expected_previous is NULL, but the row now carries another canonical key.
    expect(await cas(['blog', 2, 'en', sha('# blog 2 EN'), null, target])).toEqual({
      outcome: 'STALE',
      reason: 'pointer_drift',
    });
    expect((await state('blog_posts', 2)).body_en_path).toBe(drifted);
  });

  it('applies to portfolio rows and leaves blog rows untouched', async () => {
    const blogBefore = await state('blog_posts', 2);
    const target = path('portfolio', 1, 'it', '# pf 1 IT');
    expect(await cas(['portfolio', 1, 'it', sha('# pf 1 IT'), null, target])).toEqual({
      outcome: 'APPLIED',
      reason: null,
    });
    const pf = await state('portfolio_posts', 1);
    expect(pf.body_it_path).toBe(target);
    expect(pf.body_en_path).toBeNull();
    expect(await state('blog_posts', 2)).toEqual(blogBefore);
  });

  it('rejects a missing row with MISSING', async () => {
    const ghost = '# ghost';
    expect(await cas(['blog', 999, 'en', sha(ghost), null, path('blog', 999, 'en', ghost)])).toEqual({
      outcome: 'MISSING',
      reason: null,
    });
  });

  it('refuses every invalid input before touching a row', async () => {
    const body = '# blog 1 EN 🎉\r\n\r\nünïcodé ✓\r\n';
    const good = path('blog', 1, 'en', body);
    const h = sha(body);

    expect(await cas(['careers', 1, 'en', h, null, good])).toEqual({
      outcome: 'INVALID_ENTITY',
      reason: null,
    });
    expect(await cas(['BLOG', 1, 'en', h, null, good])).toEqual({
      outcome: 'INVALID_ENTITY',
      reason: null,
    });
    expect(await cas(['blog', 1, 'fr', h, null, good])).toEqual({
      outcome: 'INVALID_LOCALE',
      reason: null,
    });
    expect(await cas(['blog', 0, 'en', h, null, good])).toEqual({
      outcome: 'INVALID_ID',
      reason: null,
    });
    expect(await cas(['blog', 1, 'en', 'not-a-hash', null, good])).toEqual({
      outcome: 'INVALID_HASH',
      reason: null,
    });
    // canonical but for another id / locale / entity
    expect(await cas(['blog', 1, 'en', h, null, path('blog', 2, 'en', body)])).toEqual({
      outcome: 'INVALID_PATH',
      reason: null,
    });
    expect(await cas(['blog', 1, 'en', h, null, path('blog', 1, 'it', body)])).toEqual({
      outcome: 'INVALID_PATH',
      reason: null,
    });
    expect(await cas(['blog', 1, 'en', h, null, path('portfolio', 1, 'en', body)])).toEqual({
      outcome: 'INVALID_PATH',
      reason: null,
    });
    expect(await cas(['blog', 1, 'en', h, null, `${good} `])).toEqual({
      outcome: 'INVALID_PATH',
      reason: null,
    });
    // expected previous pointer that is not canonical for this row
    expect(await cas(['blog', 1, 'en', h, path('portfolio', 9, 'en', body), good])).toEqual({
      outcome: 'INVALID_PREVIOUS',
      reason: null,
    });
    // nothing above changed a row
    expect((await state('blog_posts', 1)).body_en_path).toBe(good);
  });
});

describe('rollback CAS', () => {
  const bodyEn = '# rollback row EN ✓\r\n';
  const previous = null;

  beforeAll(async () => {
    await db.query(
      `insert into dev_staging.blog_posts (id, body_en, body_it) values (10, $1, null)`,
      [bodyEn]
    );
  });

  it('restores the previous pointer while body and installed pointer are unchanged', async () => {
    const installed = path('blog', 10, 'en', bodyEn);
    expect(await cas(['blog', 10, 'en', sha(bodyEn), previous, installed])).toEqual({
      outcome: 'APPLIED',
      reason: null,
    });
    expect((await state('blog_posts', 10)).body_en_path).toBe(installed);

    expect(
      await rollback(['blog', 10, 'en', installed, sha(bodyEn), previous])
    ).toEqual({ outcome: 'ROLLED_BACK', reason: null });
    const row = await state('blog_posts', 10);
    expect(row.body_en_path).toBeNull();
    expect(row.body_en).toBe(bodyEn);
  });

  it('reports ALREADY_CURRENT when the pointer already holds the previous value', async () => {
    const installed = path('blog', 10, 'en', bodyEn);
    expect(await rollback(['blog', 10, 'en', installed, sha(bodyEn), null])).toEqual({
      outcome: 'ALREADY_CURRENT',
      reason: 'already_previous',
    });
  });

  it('refuses to roll back over a newer CMS body', async () => {
    const installed = path('blog', 10, 'en', bodyEn);
    await cas(['blog', 10, 'en', sha(bodyEn), null, installed]);
    await db.query(`update dev_staging.blog_posts set body_en = '# newer CMS edit' where id = 10`);

    expect(await rollback(['blog', 10, 'en', installed, sha(bodyEn), null])).toEqual({
      outcome: 'STALE',
      reason: 'body_changed',
    });
    expect((await state('blog_posts', 10)).body_en_path).toBe(installed);

    await db.query(`update dev_staging.blog_posts set body_en = $1 where id = 10`, [bodyEn]);
    await rollback(['blog', 10, 'en', installed, sha(bodyEn), null]);
  });

  it('refuses to roll back when the pointer drifted', async () => {
    const installed = path('blog', 10, 'en', bodyEn);
    const drifted = `blog/10/en/${'f'.repeat(64)}.md`;
    await cas(['blog', 10, 'en', sha(bodyEn), null, installed]);
    await db.query(`update dev_staging.blog_posts set body_en_path = $1 where id = 10`, [drifted]);

    expect(await rollback(['blog', 10, 'en', installed, sha(bodyEn), null])).toEqual({
      outcome: 'STALE',
      reason: 'pointer_drift',
    });
    expect((await state('blog_posts', 10)).body_en_path).toBe(drifted);
  });

  it('reports MISSING and refuses malformed input', async () => {
    expect(await rollback(['blog', 999, 'en', path('blog', 999, 'en', '# x'), sha('# x'), null])).toEqual(
      { outcome: 'MISSING', reason: null }
    );
    const installed = path('blog', 10, 'en', bodyEn);
    expect(await rollback(['blog', 10, 'en', 'not-canonical', sha(bodyEn), null])).toEqual({
      outcome: 'INVALID_INSTALLED',
      reason: null,
    });
    expect(await rollback(['blog', 10, 'en', installed, sha(bodyEn), installed])).toEqual({
      outcome: 'INVALID_PREVIOUS',
      reason: 'same_as_installed',
    });
    expect(
      await rollback(['blog', 10, 'en', installed, sha(bodyEn), path('portfolio', 1, 'en', bodyEn)])
    ).toEqual({ outcome: 'INVALID_PREVIOUS', reason: null });
    expect(await rollback(['blog', 10, 'en', installed, 'nope', null])).toEqual({
      outcome: 'INVALID_HASH',
      reason: null,
    });
  });

  it('never writes the legacy body columns', async () => {
    const before = await state('blog_posts', 10);
    const installed = path('blog', 10, 'en', bodyEn);
    await cas(['blog', 10, 'en', sha(bodyEn), null, installed]);
    await rollback(['blog', 10, 'en', installed, sha(bodyEn), null]);
    const after = await state('blog_posts', 10);
    expect(after.body_en).toBe(before.body_en);
    expect(after.body_it).toBe(before.body_it);
  });
});

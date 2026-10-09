import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261008213304_cms_allowed_users_sequence_usage.sql',
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
    CREATE SCHEMA dev_staging;
    CREATE SEQUENCE public.cms_allowed_users_id_seq;
    CREATE SEQUENCE dev_staging.cms_allowed_users_id_seq;
    CREATE TABLE dev_staging.cms_allowed_users (
      id bigint PRIMARY KEY DEFAULT nextval('dev_staging.cms_allowed_users_id_seq'),
      email text UNIQUE NOT NULL,
      role text NOT NULL CHECK (role IN ('admin', 'editor'))
    );
    ALTER TABLE dev_staging.cms_allowed_users ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA dev_staging TO service_role;
    GRANT SELECT, INSERT ON dev_staging.cms_allowed_users TO service_role;
  `);
}, 60_000);

afterAll(async () => db.close());

it('restores service-role insertion without opening either sequence to client roles or touching public', async () => {
  await db.exec('SET ROLE service_role');
  try {
    await expect(
      db.query(
        `INSERT INTO dev_staging.cms_allowed_users (email, role)
         VALUES ('before@example.test', 'editor') RETURNING id`
      )
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await db.exec('RESET ROLE');
  }

  await db.exec(await readFile(migrationPath, 'utf8'));
  await db.exec('SET ROLE service_role');
  try {
    const inserted = await db.query<{ email: string; role: string }>(
      `INSERT INTO dev_staging.cms_allowed_users (email, role)
       VALUES ('after@example.test', 'editor') RETURNING email, role`
    );
    expect(inserted.rows).toEqual([
      { email: 'after@example.test', role: 'editor' },
    ]);
  } finally {
    await db.exec('RESET ROLE');
  }

  for (const role of ['anon', 'authenticated']) {
    const result = await db.query<{ allowed: boolean }>(
      `SELECT has_sequence_privilege($1, 'dev_staging.cms_allowed_users_id_seq', 'USAGE') AS allowed`,
      [role]
    );
    expect(result.rows[0]?.allowed).toBe(false);
  }
  const publicGrant = await db.query<{ allowed: boolean }>(
    `SELECT has_sequence_privilege('service_role', 'public.cms_allowed_users_id_seq', 'USAGE') AS allowed`
  );
  expect(publicGrant.rows[0]?.allowed).toBe(false);
});

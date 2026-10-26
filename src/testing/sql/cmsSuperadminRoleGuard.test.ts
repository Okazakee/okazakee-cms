import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261026125511_cms_superadmin_role.sql',
    import.meta.url
  )
);

const ROLES_SQL = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
`;

// Supabase auth objects the identity RPC reads. auth.uid() is driven by a
// session setting so each test decides who the caller is.
const AUTH_STUBS_SQL = `
  CREATE SCHEMA auth;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    email text,
    email_confirmed_at timestamptz
  );

  CREATE TABLE auth.identities (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    identity_data jsonb NOT NULL
  );
`;

const PUBLIC_ALLOWLIST_SQL = `
  CREATE TABLE public.cms_allowed_users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text UNIQUE,
    github_user_id text,
    github_username text,
    role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor')),
    invited_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

const DEV_ALLOWLIST_SQL = `
  CREATE TABLE dev_staging.cms_allowed_users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text UNIQUE,
    github_user_id text,
    github_username text,
    role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor')),
    invited_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

type LookupResult = { role: string; match_source: string } | null;

async function applyMigration(db: PGlite): Promise<void> {
  await db.exec(await readFile(migrationPath, 'utf8'));
}

async function insertAllowlist(
  db: PGlite,
  schema: string,
  email: string,
  role: string
): Promise<number> {
  const { rows } = await db.query<{ id: number | string }>(
    `INSERT INTO ${schema}.cms_allowed_users (email, role)
     VALUES ($1, $2) RETURNING id`,
    [email, role]
  );
  return Number(rows[0]?.id);
}

async function insertVerifiedUser(
  db: PGlite,
  id: string,
  email: string
): Promise<void> {
  await db.query(
    `INSERT INTO auth.users (id, email, email_confirmed_at)
     VALUES ($1, $2, now())`,
    [id, email]
  );
}

async function setAuthUid(db: PGlite, uid: string | null): Promise<void> {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [uid ?? '']);
}

/**
 * Calls the single identity RPC. `undefined` omits the argument entirely (the
 * already-deployed no-argument call shape); `null` passes SQL NULL explicitly
 * (which must NOT fall back to the default).
 */
async function lookupCmsUser(
  db: PGlite,
  schema?: string | null
): Promise<LookupResult> {
  const sql =
    schema === undefined
      ? 'SELECT public.cms_lookup_current_user() AS result'
      : 'SELECT public.cms_lookup_current_user($1) AS result';
  const params = schema === undefined ? [] : [schema];
  const { rows } = await db.query<{ result: LookupResult }>(sql, params);
  return rows[0]?.result ?? null;
}

describe('cms_superadmin_role without dev_staging', () => {
  const PUBLIC_EDITOR_ID = '11111111-1111-1111-1111-111111111111';
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(ROLES_SQL);
    await db.exec(AUTH_STUBS_SQL);
    await db.exec(PUBLIC_ALLOWLIST_SQL);
    // No dev_staging schema at all: the migration must still apply cleanly.
    await applyMigration(db);

    // Public-only CMS editor used by the identity-RPC regressions.
    await insertVerifiedUser(
      db,
      PUBLIC_EDITOR_ID,
      'public-editor@example.test'
    );
    await insertAllowlist(db, 'public', 'public-editor@example.test', 'editor');
    await setAuthUid(db, PUBLIC_EDITOR_ID);
  }, 60_000);

  afterAll(async () => db.close());

  it('widens the role vocabulary but still rejects malformed tokens', async () => {
    const superadminId = await insertAllowlist(
      db,
      'public',
      'owner@example.test',
      'superadmin'
    );
    expect(superadminId).toBeGreaterThan(0);

    await expect(
      insertAllowlist(db, 'public', 'bogus@example.test', 'owner')
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses to demote or delete the last superadmin', async () => {
    await insertAllowlist(db, 'public', 'owner2@example.test', 'superadmin');
    const target = await db.query<{ id: number | string }>(
      `SELECT id FROM public.cms_allowed_users WHERE email = 'owner2@example.test'`
    );
    const remainingId = Number(target.rows[0]?.id);

    // Two superadmins exist, so demoting one is allowed …
    await db.query(
      `UPDATE public.cms_allowed_users SET role = 'admin' WHERE id = $1`,
      [remainingId]
    );
    const demoted = await db.query<{ role: string }>(
      `SELECT role FROM public.cms_allowed_users WHERE id = $1`,
      [remainingId]
    );
    expect(demoted.rows[0]?.role).toBe('admin');

    const onlySuperadmin = await db.query<{ id: number | string }>(
      `SELECT id FROM public.cms_allowed_users WHERE role = 'superadmin'`
    );
    const lastId = Number(onlySuperadmin.rows[0]?.id);

    // … but the last one cannot be demoted or removed.
    await expect(
      db.query(
        `UPDATE public.cms_allowed_users SET role = 'editor' WHERE id = $1`,
        [lastId]
      )
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      db.query(`DELETE FROM public.cms_allowed_users WHERE id = $1`, [lastId])
    ).rejects.toMatchObject({ code: '55000' });

    const stillSuperadmin = await db.query<{ role: string }>(
      `SELECT role FROM public.cms_allowed_users WHERE id = $1`,
      [lastId]
    );
    expect(stillSuperadmin.rows[0]?.role).toBe('superadmin');
  });

  it('exposes exactly one identity RPC with restricted grants', async () => {
    const signature = 'public.cms_lookup_current_user(text)';
    const { rows } = await db.query<{
      anon: boolean;
      authenticated: boolean;
      public_role: boolean;
      overloads: number;
    }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('public', $1, 'EXECUTE') AS public_role,
              (SELECT count(*)::int
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname = 'cms_lookup_current_user') AS overloads`,
      [signature]
    );

    expect(rows[0]?.anon).toBe(false);
    expect(rows[0]?.public_role).toBe(false);
    expect(rows[0]?.authenticated).toBe(true);
    expect(Number(rows[0]?.overloads)).toBe(1);
  });

  it('keeps an already-deployed no-argument call on the public default', async () => {
    expect(await lookupCmsUser(db)).toEqual({
      role: 'editor',
      match_source: 'email',
    });
    expect(await lookupCmsUser(db, 'public')).toEqual({
      role: 'editor',
      match_source: 'email',
    });
  });

  it('rejects invalid or non-whitelisted schemas without a public fallback', async () => {
    const invalidSchemas = [
      '',
      'Public',
      'dev_staging ',
      'staging',
      'pg_catalog',
      "public' --",
    ];

    for (const schema of invalidSchemas) {
      expect(await lookupCmsUser(db, schema)).toBeNull();
    }
    // Explicit NULL never silently becomes the `public` default.
    expect(await lookupCmsUser(db, null)).toBeNull();
  });

  it('fails closed when dev_staging is not provisioned', async () => {
    expect(await lookupCmsUser(db, 'dev_staging')).toBeNull();
  });
});

describe('cms_superadmin_role with dev_staging', () => {
  const DEV_ONLY_ID = '22222222-2222-2222-2222-222222222222';
  const PUBLIC_ONLY_ID = '33333333-3333-3333-3333-333333333333';
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(ROLES_SQL);
    await db.exec(AUTH_STUBS_SQL);
    await db.exec(PUBLIC_ALLOWLIST_SQL);
    await db.exec('CREATE SCHEMA dev_staging;');
    await db.exec(DEV_ALLOWLIST_SQL);
    await applyMigration(db);

    // An invitee that exists ONLY in the dev allowlist: the onboarding bug was
    // the middleware signing it out by reading public alone.
    await insertVerifiedUser(db, DEV_ONLY_ID, 'dev-invite@example.test');
    await insertAllowlist(
      db,
      'dev_staging',
      'dev-invite@example.test',
      'editor'
    );

    // A public-only identity that must stay unauthorized in dev.
    await insertVerifiedUser(db, PUBLIC_ONLY_ID, 'public-only@example.test');
    await insertAllowlist(db, 'public', 'public-only@example.test', 'admin');
  }, 60_000);

  afterAll(async () => db.close());

  it('mirrors the CHECK and the guard trigger into dev_staging', async () => {
    await insertAllowlist(
      db,
      'dev_staging',
      'dev-owner@example.test',
      'superadmin'
    );
    await expect(
      insertAllowlist(db, 'dev_staging', 'dev-bogus@example.test', 'owner')
    ).rejects.toMatchObject({ code: '23514' });

    const target = await db.query<{ id: number | string }>(
      `SELECT id FROM dev_staging.cms_allowed_users WHERE email = 'dev-owner@example.test'`
    );
    const lastId = Number(target.rows[0]?.id);

    await expect(
      db.query(
        `UPDATE dev_staging.cms_allowed_users SET role = 'admin' WHERE id = $1`,
        [lastId]
      )
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      db.query(`DELETE FROM dev_staging.cms_allowed_users WHERE id = $1`, [
        lastId,
      ])
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('authorizes a dev-only invited identity from dev_staging', async () => {
    await setAuthUid(db, DEV_ONLY_ID);

    expect(await lookupCmsUser(db, 'dev_staging')).toEqual({
      role: 'editor',
      match_source: 'email',
    });

    // Production stays closed: the dev invitee was never added to public.
    expect(await lookupCmsUser(db)).toBeNull();
    expect(await lookupCmsUser(db, 'public')).toBeNull();

    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM public.cms_allowed_users
        WHERE lower(email) = 'dev-invite@example.test'`
    );
    expect(rows[0]?.count).toBe(0);
  });

  it('does not authorize a public-only identity from dev_staging', async () => {
    await setAuthUid(db, PUBLIC_ONLY_ID);

    expect(await lookupCmsUser(db)).toEqual({
      role: 'admin',
      match_source: 'email',
    });
    expect(await lookupCmsUser(db, 'dev_staging')).toBeNull();
  });
});

describe('cms_superadmin_role replacing the legacy no-arg RPC', () => {
  const LEGACY_ID = '44444444-4444-4444-4444-444444444444';
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(ROLES_SQL);
    await db.exec(AUTH_STUBS_SQL);
    await db.exec(PUBLIC_ALLOWLIST_SQL);
    // The shape already deployed before this rollout: a zero-argument overload.
    await db.exec(`
      CREATE FUNCTION public.cms_lookup_current_user()
      RETURNS jsonb LANGUAGE sql
      AS $$ SELECT NULL::jsonb $$;
    `);
    await applyMigration(db);

    await insertVerifiedUser(db, LEGACY_ID, 'legacy-noarg@example.test');
    await insertAllowlist(db, 'public', 'legacy-noarg@example.test', 'editor');
    await setAuthUid(db, LEGACY_ID);
  }, 60_000);

  afterAll(async () => db.close());

  it('drops the legacy overload and keeps only the defaulted signature', async () => {
    const { rows } = await db.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'cms_lookup_current_user'`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.args).toBe('p_schema text');
  });

  it('serves an already-deployed no-argument call with the public default', async () => {
    expect(await lookupCmsUser(db)).toEqual({
      role: 'editor',
      match_source: 'email',
    });
  });
});

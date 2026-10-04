import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the real intake migration against a real Postgres (PGlite, WASM)
 * and asserts the resulting ACL, rather than reading the SQL as text.
 *
 * This is the security property the whole design rests on: `project_requests`
 * holds submitted personal data, so no client role may reach it through the
 * Data API — the public form writes through the service role only.
 */

const migrationPath = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20261004130000_add_project_requests.sql',
    import.meta.url
  )
);

let db: PGlite;

async function hasPrivilege(role: string, privilege: string): Promise<boolean> {
  const result = await db.query<{ allowed: boolean }>(
    `select has_table_privilege($1, 'public.project_requests', $2) as allowed`,
    [role, privilege]
  );
  return result.rows[0]?.allowed === true;
}

beforeAll(async () => {
  db = new PGlite();
  // PGlite has no Supabase roles; create them so the migration's role grants
  // and revokes execute exactly as they will in the project.
  await db.exec(
    'create role anon; create role authenticated; create role service_role;'
  );
  await db.exec(await readFile(migrationPath, 'utf8'));
}, 60_000);

describe('project_requests storage', () => {
  it('exists with the receipt timestamp, locale, consent and archive columns', async () => {
    const result = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'project_requests'`
    );
    const columns = result.rows.map((row) => row.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'created_at',
        'locale',
        'name',
        'email',
        'company',
        'website',
        'project_type',
        'budget',
        'timeline',
        'request',
        'consent',
        'archived',
        'archived_at',
      ])
    );
  });

  it('has row level security enabled with no policy for any client role', async () => {
    const result = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class
       where oid = 'public.project_requests'::regclass`
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    const policies = await db.query<{ count: number }>(
      `select count(*)::int as count from pg_policies
       where schemaname = 'public' and tablename = 'project_requests'`
    );
    expect(policies.rows[0]?.count).toBe(0);
  });

  it('cannot be read or written by the Data API as anon', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await hasPrivilege('anon', privilege)).toBe(false);
    }
  });

  it('cannot be read or written by the Data API as authenticated', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await hasPrivilege('authenticated', privilege)).toBe(false);
    }
  });

  it('leaves the intake and inbox path available to service_role', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await hasPrivilege('service_role', privilege)).toBe(true);
    }
  });

  it('cannot have its grant restored by adding a permissive policy', async () => {
    // A policy filters rows; only an ACL grant opens the table. Adding one
    // for anon must therefore still leave the table unreachable.
    await db.exec(
      `create policy test_public_read on public.project_requests
       for select to anon using (true)`
    );
    const result = await db.query<{ allowed: boolean }>(
      `select has_table_privilege('anon', 'public.project_requests', 'SELECT') as allowed`
    );
    expect(result.rows[0]?.allowed).toBe(false);
    await db.exec('drop policy test_public_read on public.project_requests');
  });

  it('stores the form vocabulary and refuses anything outside it', async () => {
    await db.exec(
      `insert into public.project_requests
       (locale, name, email, project_type, budget, timeline, request, consent)
       values ('en', 'Ada', 'ada@example.com', 'Web app', '€5–15k', 'ASAP', 'Hi', true)`
    );
    const stored = await db.query<{ project_type: string }>(
      `select project_type from public.project_requests`
    );
    expect(stored.rows[0]?.project_type).toBe('Web app');

    await expect(
      db.exec(
        `insert into public.project_requests
         (locale, name, email, project_type, budget, timeline, request, consent)
         values ('en', 'Mallory', 'm@example.com', 'Spaceship', '€5–15k', 'ASAP', 'Hi', true)`
      )
    ).rejects.toThrow();
  });

  it('archives with a boolean flag and no third state', async () => {
    await db.exec(
      `update public.project_requests
       set archived = true, archived_at = now() where email = 'ada@example.com'`
    );
    const active = await db.query<{ count: number }>(
      `select count(*)::int as count from public.project_requests where archived = false`
    );
    expect(active.rows[0]?.count).toBe(0);
    const archived = await db.query<{ archived_at: Date }>(
      `select archived_at from public.project_requests where archived = true`
    );
    expect(archived.rows[0]?.archived_at).toBeInstanceOf(Date);
  });
});

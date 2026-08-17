import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

/**
 * Behavior tests for the SQL login-rate-limiter policy
 * (supabase/migrations/20260818100000_login_rate_limit_split_buckets.sql),
 * executed against a real Postgres via PGlite (WASM).
 *
 * The migration's grant statements are skipped: PGlite is single-user and
 * has no anon/authenticated roles. The table DDL lives in the base
 * migration and is recreated here.
 */

const MIGRATION_PATH = new URL(
  '../../../supabase/migrations/20260818100000_login_rate_limit_split_buckets.sql',
  import.meta.url
);

const BASE_TABLE_DDL = `
  create table if not exists cms_login_attempts (
    identifier text primary key,
    attempt_count integer not null default 0,
    window_started_at timestamptz not null default now(),
    locked_until timestamptz
  );
`;

function ddlOnly(sql: string): string {
  const marker = '-- BEGIN GRANTS';
  const idx = sql.indexOf(marker);
  return idx === -1 ? sql : sql.slice(0, idx);
}

async function newDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_TABLE_DDL);
  await db.exec(ddlOnly(readFileSync(MIGRATION_PATH, 'utf8')));
  return db;
}

type RateResult = {
  allowed: boolean;
  remaining_attempts: number;
  lockout_remaining: number;
};

async function check(
  db: PGlite,
  ip: string,
  email: string
): Promise<RateResult> {
  const { rows } = await db.query<{ r: RateResult | string }>(
    'select cms_check_login_rate($1, $2) as r',
    [ip, email]
  );
  const raw = rows[0].r;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function clear(db: PGlite, ip: string, email: string): Promise<void> {
  await db.query('select cms_clear_login_rate($1, $2)', [ip, email]);
}

async function expireWindows(db: PGlite): Promise<void> {
  // Simulate elapsed time for EVERY row (locked or not): the window is a
  // property of the row, not of the lockout state.
  await db.exec(
    "update cms_login_attempts set window_started_at = now() - interval '2 minutes'"
  );
}

async function expireLockouts(db: PGlite): Promise<void> {
  await db.exec(
    "update cms_login_attempts set locked_until = now() - interval '1 minute' where locked_until is not null"
  );
}

const IP = 'ip-1';
const EMAIL = 'email-a';

describe('cms_check_login_rate (per-IP + per-email buckets)', () => {
  it('locks after 5 repeated failures on the same IP/email pair', async () => {
    const db = await newDb();
    try {
      let r = await check(db, IP, EMAIL);
      expect(r.allowed).toBe(true);
      expect(r.remaining_attempts).toBe(4);

      for (let i = 2; i <= 4; i++) {
        r = await check(db, IP, EMAIL);
        expect(r.allowed).toBe(true);
        expect(r.remaining_attempts).toBe(5 - i);
      }

      r = await check(db, IP, EMAIL);
      expect(r.allowed).toBe(false);
      expect(r.lockout_remaining).toBe(900);

      // Still locked on the next attempt
      r = await check(db, IP, EMAIL);
      expect(r.allowed).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('blocks a second email from the same IP once the IP bucket is exhausted', async () => {
    const db = await newDb();
    try {
      for (let i = 0; i < 5; i++) {
        await check(db, IP, 'email-a');
      }
      const r = await check(db, IP, 'email-b');
      expect(r.allowed).toBe(false);
      expect(r.remaining_attempts).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('blocks the same email from a new IP once the email bucket is exhausted', async () => {
    const db = await newDb();
    try {
      for (let i = 0; i < 5; i++) {
        await check(db, `ip-${i}`, EMAIL);
      }
      const r = await check(db, 'ip-99', EMAIL);
      expect(r.allowed).toBe(false);
      expect(r.remaining_attempts).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('does not double-count when both identifiers are identical', async () => {
    const db = await newDb();
    try {
      const results: RateResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(await check(db, 'same', 'same'));
      }
      // Five attempts must exhaust the single deduplicated bucket on the 5th,
      // exactly as if one bucket had been used (no double counting).
      expect(results[0].remaining_attempts).toBe(4);
      expect(results[3].remaining_attempts).toBe(1);
      expect(results[4].allowed).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('successful login clears both buckets (cms_clear_login_rate)', async () => {
    const db = await newDb();
    try {
      for (let i = 0; i < 5; i++) {
        await check(db, IP, EMAIL);
      }
      expect((await check(db, IP, EMAIL)).allowed).toBe(false);

      await clear(db, IP, EMAIL);

      const r = await check(db, IP, EMAIL);
      expect(r.allowed).toBe(true);
      expect(r.remaining_attempts).toBe(4);
    } finally {
      await db.close();
    }
  });

  it('recovers after the 1-minute window expires without a lockout', async () => {
    const db = await newDb();
    try {
      let r: RateResult = { allowed: true, remaining_attempts: 5, lockout_remaining: 0 };
      for (let i = 0; i < 4; i++) {
        r = await check(db, IP, EMAIL);
      }
      // 4th attempt: one failure left in the window
      expect(r.allowed).toBe(true);
      expect(r.remaining_attempts).toBe(1);

      await expireWindows(db);

      const fresh = await check(db, IP, EMAIL);
      expect(fresh.allowed).toBe(true);
      expect(fresh.remaining_attempts).toBe(4);
    } finally {
      await db.close();
    }
  });

  it('recovers after the 15-minute lockout expires', async () => {
    const db = await newDb();
    try {
      for (let i = 0; i < 5; i++) {
        await check(db, IP, EMAIL);
      }
      expect((await check(db, IP, EMAIL)).allowed).toBe(false);

      // In real time the lockout only ever fires inside the first minute, so
      // by the time it expires the attempt window has long since reset too.
      await expireLockouts(db);
      await expireWindows(db);

      const r = await check(db, IP, EMAIL);
      expect(r.allowed).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe('migration drift guard', () => {
  it('defines the split-bucket RPCs and grants markers', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toContain('create or replace function cms_check_login_rate(p_ip text, p_email text)');
    expect(sql).toContain('create or replace function cms_clear_login_rate(p_ip text, p_email text)');
    expect(sql).toContain('create or replace function cms_check_login_single(p_identifier text)');
    expect(sql).toContain('-- BEGIN GRANTS');
    expect(sql).toContain('-- END GRANTS');
  });
});

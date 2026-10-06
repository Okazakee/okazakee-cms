/**
 * Logged-in project-local Supabase CLI runner (read-only).
 *
 * Read path (`db query --linked --output-format json`) is used by check.
 * No write path exists: this module cannot apply migrations. Auth/link
 * conventions: the user runs `supabase login` and
 * `supabase link --project-ref <ref>` once in this repo; these commands
 * inherit that project-local session (same HOME config, same cwd). The
 * project-local 2.119 CLI is preferred via Bun
 * (`bun node_modules/supabase/dist/supabase.js …`); PATH `supabase`
 * (global 2.105) is fallback only. Query output is the `{rows}`
 * envelope (`{boundary, rows, warning}`); only aggregate counts/names
 * surface in reports, never row contents that could carry secrets.
 * Non-zero exits throw with a short stderr hint; stdout payloads that
 * are empty, non-JSON, or missing `rows` throw (never empty/success).
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCli(
  command: string,
  args: string[],
  opts?: { cwd?: string }
): Promise<CliResult> {
  const { promise, resolve } = Promise.withResolvers<CliResult>();
  const child = spawn(command, args, {
    cwd: opts?.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('error', (error) => {
    resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
  });
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  return promise;
}

/**
 * Resolve the preferred CLI launcher: project-local 2.119 via Bun first,
 * PATH `supabase` (global 2.105) as fallback. Both inherit the caller's
 * cwd/env so the user's `supabase login` + `link` session is reused;
 * no tokens or HOME overrides are set here.
 */
export function supabaseLaunch(cwd?: string): {
  command: string;
  prefix: string[];
} {
  const roots = [cwd ?? process.cwd(), process.cwd()];
  for (const root of roots) {
    const entry = path.resolve(root, 'node_modules/supabase/dist/supabase.js');
    try {
      if (existsSync(entry)) return { command: 'bun', prefix: [entry] };
    } catch {
      // fall through to PATH fallback
    }
  }
  return { command: 'supabase', prefix: [] };
}

/**
 * Parse `supabase db query --linked --output-format json` payloads.
 *
 * Actual 2.119 (and global 2.105) shape, privacy-safe probe
 * (`SELECT 1 AS probe`):
 *   {"boundary":"…","rows":[{"probe":1}],"warning":"…untrusted…"}
 * Returns the `rows` array. Empty stdout, non-JSON, or any object
 * without an array `rows` throws (never empty/success) so a missing
 * ledger or CLI contract drift fails closed instead of passing.
 */
export function parseQueryJson(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      'unexpected CLI JSON shape (expected {rows: [...]}, got empty output)'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      'unexpected CLI JSON shape (expected {rows: [...]}, got non-JSON output)'
    );
  }
  if (parsed !== null && typeof parsed === 'object' && 'rows' in parsed) {
    const rows: unknown = parsed.rows;
    if (Array.isArray(rows)) return rows;
  }
  throw new Error('unexpected CLI JSON shape (expected {rows: [...]})');
}

function cliHint(stderr: string): string {
  const s = stderr.slice(0, 400);
  if (/not linked|no.*link|project.*ref/i.test(s)) {
    return ' CLI is not linked: run `supabase link --project-ref <ref>` once, then retry.';
  }
  if (/not logged|login|token|auth/i.test(s)) {
    return ' CLI is not authenticated: run `supabase login` (or set SUPABASE_ACCESS_TOKEN), then retry.';
  }
  return '';
}

/**
 * Read-only live query via the linked project session. Uses the
 * project-local launcher (Bun, 2.119) with PATH fallback, and requests
 * `--output-format json` which yields the `{boundary, rows, warning}`
 * envelope. Non-zero exits throw with a short stderr hint (tokens are
 * never included); row contents are returned unlogged for the caller
 * to aggregate.
 */
export async function runSupabaseQueryJson<T = unknown>(
  sql: string,
  opts?: { cwd?: string }
): Promise<T[]> {
  const launch = supabaseLaunch(opts?.cwd);
  const res = await runCli(
    launch.command,
    [
      ...launch.prefix,
      'db',
      'query',
      '--linked',
      '--output-format',
      'json',
      sql,
    ],
    { cwd: opts?.cwd }
  );
  if (res.code !== 0) {
    throw new Error(
      `supabase db query failed (exit ${res.code}): ${res.stderr.slice(0, 300)}${cliHint(res.stderr)}`
    );
  }
  const rows: unknown[] = parseQueryJson(res.stdout);
  return rows as T[];
}

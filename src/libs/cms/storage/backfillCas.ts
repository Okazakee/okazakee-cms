/**
 * Client for the atomic CAS functions.
 *
 * DEV uses `supabase/review/dev_markdown_backfill_cas.sql` (deployed to
 * `dev_staging`); production uses `supabase/review/prod_markdown_backfill_cas.sql`
 * once it is promoted. The two artifacts are the same implementation with the
 * schema and function names changed, so this client is parameterised by the
 * shared environment descriptor instead of being cloned. The functions are the
 * only sanctioned way to switch a body pointer: the guard (committed body hash
 * + current pointer) lives inside the single UPDATE, so a stale read can never
 * repoint a row. This module never writes a pointer itself; it only calls the
 * CAS RPC and validates its arguments locally first, mirroring the SQL checks
 * so a bad call fails before the network.
 *
 * The functions are staged, not applied: until they exist in `dev_staging`,
 * every call fails and `probeCasReadiness()` reports `missing`. The production
 * functions have not been applied either, which is the same case.
 */
import {
  DEV_BACKFILL_ENVIRONMENT,
  type BackfillEnvironmentSpec,
} from '@/libs/cms/storage/backfillEnvironment';
import type { BodyContentKind, BodyContentLocale } from '@/libs/cms/storage/bodyContent';

/** CAS function names for the DEV environment (and the historical exports). */
export const BACKFILL_CAS_FUNCTION = DEV_BACKFILL_ENVIRONMENT.cas.forward;
export const BACKFILL_ROLLBACK_FUNCTION = DEV_BACKFILL_ENVIRONMENT.cas.rollback;

/** Sentinel entity used by the read-only readiness probe (always refused). */
export const CAS_PROBE_ENTITY = '__probe__';

export type CasOutcome =
  | 'APPLIED'
  | 'ALREADY_CURRENT'
  | 'STALE'
  | 'MISSING'
  | 'ROLLED_BACK'
  | 'INVALID_ENTITY'
  | 'INVALID_LOCALE'
  | 'INVALID_ID'
  | 'INVALID_HASH'
  | 'INVALID_PATH'
  | 'INVALID_PREVIOUS'
  | 'INVALID_INSTALLED';

export type CasResult = {
  outcome: CasOutcome;
  /** Short non-sensitive code ('body_changed', 'pointer_drift', ...) or null. */
  reason: string | null;
};

export type PointerCasArgs = {
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  /** SHA-256 the committed legacy body must still hash to. */
  expectedSha256: string;
  /** Pointer the row must still hold, NULL included. */
  expectedPrevious: string | null;
  /** Canonical destination key. */
  newPath: string;
};

export type RollbackCasArgs = {
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  /** Pointer this run installed; the row must still hold exactly this. */
  installedPath: string;
  /** Source hash the committed body must still match. */
  expectedSha256: string;
  /** Pointer to restore (usually NULL). */
  previousPath: string | null;
};

export type BackfillCasApi = {
  pointerCas(args: PointerCasArgs): Promise<CasResult>;
  pointerRollback(args: RollbackCasArgs): Promise<CasResult>;
};

/** Minimal RPC surface; `SupabaseClient` satisfies it structurally. */
export type CasRpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const KINDS: BodyContentKind[] = ['blog', 'portfolio'];
const LOCALES: BodyContentLocale[] = ['en', 'it'];

export function canonicalBodyPath(
  kind: BodyContentKind,
  postId: number,
  locale: BodyContentLocale,
  hash: string
): string {
  return `${kind}/${postId}/${locale}/${hash}.md`;
}

function isCanonicalPathFor(
  path: string | null,
  kind: BodyContentKind,
  postId: number,
  locale: BodyContentLocale
): boolean {
  if (path === null) return true;
  return new RegExp(`^${kind}/${postId}/${locale}/[0-9a-f]{64}\\.md$`).test(path);
}

/**
 * Local mirror of the SQL validation. Returns an error message, or null when
 * the call is well-formed. Using the same rules on both sides means a
 * malformed request never reaches the database.
 */
export function validatePointerCasArgs(args: PointerCasArgs): string | null {
  if (!KINDS.includes(args.kind)) return `invalid entity '${String(args.kind)}'`;
  if (!LOCALES.includes(args.locale)) return `invalid locale '${String(args.locale)}'`;
  if (!Number.isInteger(args.postId) || args.postId <= 0) {
    return `invalid post id '${String(args.postId)}'`;
  }
  if (!HASH_PATTERN.test(args.expectedSha256)) {
    return 'invalid expected sha256 (expected 64 lowercase hex characters)';
  }
  if (args.newPath !== canonicalBodyPath(args.kind, args.postId, args.locale, args.expectedSha256)) {
    return 'destination path is not canonical for this entity, id, locale and hash';
  }
  if (!isCanonicalPathFor(args.expectedPrevious, args.kind, args.postId, args.locale)) {
    return 'expected previous pointer is not canonical for this entity, id and locale';
  }
  return null;
}

/** Local mirror of the rollback SQL validation. */
export function validateRollbackCasArgs(args: RollbackCasArgs): string | null {
  if (!KINDS.includes(args.kind)) return `invalid entity '${String(args.kind)}'`;
  if (!LOCALES.includes(args.locale)) return `invalid locale '${String(args.locale)}'`;
  if (!Number.isInteger(args.postId) || args.postId <= 0) {
    return `invalid post id '${String(args.postId)}'`;
  }
  if (!HASH_PATTERN.test(args.expectedSha256)) {
    return 'invalid expected sha256 (expected 64 lowercase hex characters)';
  }
  if (!isCanonicalPathFor(args.installedPath, args.kind, args.postId, args.locale) || args.installedPath === null) {
    return 'installed path is not canonical for this entity, id and locale';
  }
  if (!isCanonicalPathFor(args.previousPath, args.kind, args.postId, args.locale)) {
    return 'previous pointer is not canonical for this entity, id and locale';
  }
  if (args.previousPath === args.installedPath) {
    return 'previous pointer equals the installed pointer';
  }
  return null;
}

function casRow(result: { data: unknown; error: { message: string } | null }, fn: string): CasResult {
  if (result.error) {
    throw new Error(`[backfill-cas] ${fn} failed: ${result.error.message}`);
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  const first = rows[0] as { outcome?: unknown; reason?: unknown } | undefined;
  if (!first || typeof first.outcome !== 'string') {
    throw new Error(`[backfill-cas] ${fn} returned no outcome row`);
  }
  return {
    outcome: first.outcome as CasOutcome,
    reason: typeof first.reason === 'string' ? first.reason : null,
  };
}

/**
 * Wraps a narrow RPC client into the CAS API for one environment. Arguments are
 * validated locally before every call; an invalid call is a thrown programming
 * error, never a silent no-op.
 */
export function createBackfillCasApi(
  client: CasRpcClient,
  spec: BackfillEnvironmentSpec = DEV_BACKFILL_ENVIRONMENT
): BackfillCasApi {
  const forward = spec.cas.forward;
  const rollback = spec.cas.rollback;
  return {
    async pointerCas(args) {
      const invalid = validatePointerCasArgs(args);
      if (invalid) throw new Error(`[backfill-cas] refusing pointer CAS: ${invalid}`);
      const result = await client.rpc(forward, {
        p_kind: args.kind,
        p_post_id: args.postId,
        p_locale: args.locale,
        p_expected_sha256: args.expectedSha256,
        p_expected_previous: args.expectedPrevious,
        p_new_path: args.newPath,
      });
      return casRow(result, forward);
    },

    async pointerRollback(args) {
      const invalid = validateRollbackCasArgs(args);
      if (invalid) throw new Error(`[backfill-cas] refusing rollback CAS: ${invalid}`);
      const result = await client.rpc(rollback, {
        p_kind: args.kind,
        p_post_id: args.postId,
        p_locale: args.locale,
        p_installed_path: args.installedPath,
        p_expected_sha256: args.expectedSha256,
        p_previous_path: args.previousPath,
      });
      return casRow(result, rollback);
    },
  };
}

export type CasReadiness =
  | { state: 'ready' }
  | { state: 'missing'; detail: string }
  | { state: 'unexpected'; detail: string };

/** Which of the two staged/live functions is being probed. */
export type CasFunctionRole = 'forward' | 'rollback';

/**
 * The sentinel call for one function. Every argument is invalid on purpose so
 * the SQL refuses at its first validation branch (`INVALID_ENTITY`) before the
 * write statement is reached, which makes the probe safe on a live database.
 */
const PROBE_ARGS: Record<CasFunctionRole, Record<string, unknown>> = {
  forward: {
    p_kind: CAS_PROBE_ENTITY,
    p_post_id: 0,
    p_locale: 'en',
    p_expected_sha256: '0'.repeat(64),
    p_expected_previous: null,
    p_new_path: '',
  },
  rollback: {
    p_kind: CAS_PROBE_ENTITY,
    p_post_id: 0,
    p_locale: 'en',
    p_installed_path: '',
    p_expected_sha256: '0'.repeat(64),
    p_previous_path: null,
  },
};

/**
 * Read-only readiness probe: calls one CAS function with an entity the SQL
 * refuses before it can write anything (`__probe__`), so the presence of the
 * function — and, through PostgREST's argument-name resolution, of its exact
 * signature — can be confirmed without any possibility of mutation. Missing,
 * refused by privilege, or answering with an unexpected outcome all report as
 * not-ready.
 */
export async function probeCasReadiness(
  client: CasRpcClient,
  spec: BackfillEnvironmentSpec = DEV_BACKFILL_ENVIRONMENT,
  role: CasFunctionRole = 'forward'
): Promise<CasReadiness> {
  const fn = role === 'forward' ? spec.cas.forward : spec.cas.rollback;
  try {
    const result = await client.rpc(fn, PROBE_ARGS[role]);
    if (result.error) {
      return { state: 'missing', detail: result.error.message };
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    const outcome = (rows[0] as { outcome?: unknown } | undefined)?.outcome;
    return outcome === 'INVALID_ENTITY'
      ? { state: 'ready' }
      : { state: 'unexpected', detail: `probe returned ${String(outcome)}` };
  } catch (error) {
    return {
      state: 'missing',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

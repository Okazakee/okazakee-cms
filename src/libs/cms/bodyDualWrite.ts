/**
 * Feature gate for Markdown body dual-write (Phase 7A).
 *
 * Dual-write is OPT-IN and only valid in the dev clone:
 *   CMS_BODY_DUAL_WRITE_ENABLED=true
 *   APP_ENV=production + NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public  -> website-content
 *   APP_ENV!=production + NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging -> website-content-dev
 *
 * Anything else stays on the legacy path, and an explicitly-enabled but
 * incompatible environment is rejected before any DB or Storage mutation, so
 * the two environments can never write each other's bucket.
 *
 * Pure decision logic (injectable) so it can be unit-tested; the process
 * environment is read only by `currentBodyDualWrite()`.
 */
import { tryResolveContentBucket } from '@/libs/cms/storage/contentBucket';

export const BODY_DUAL_WRITE_FLAG = 'CMS_BODY_DUAL_WRITE_ENABLED';

/**
 * Schema-capability flag: declares that the pointer columns EXIST in the
 * configured schema. The dev clone ships them, so it is implicit there;
 * production must declare them after the additive migration, otherwise a
 * legacy-only body edit would leave a stale pointer behind (and a later
 * Storage-first read would fail the legacy/Storage agreement check).
 *
 * Unset/false on production = the columns are not referenced at all (safe
 * before the migration).
 */
export const POINTER_COLUMNS_FLAG = 'CMS_BODY_POINTER_COLUMNS';

export type BodyDualWriteEnv = {
  /** Raw flag value — enabled only when exactly `'true'`. */
  enabled: boolean;
  appEnv: string;
  schema: string;
  /** `CMS_BODY_POINTER_COLUMNS=true`: the pointer columns exist in this schema. */
  pointerColumns?: boolean;
};

export type BodyDualWriteDecision =
  /**
   * Legacy path. `devClone` marks the dev clone; `pointerColumns` says whether
   * this write may name the pointer columns — true in the dev clone and in
   * production once the capability is declared, false before that migration.
   * When true, a legacy-only body edit clears the affected pointer so a later
   * Storage-first read can never disagree with the committed body.
   */
  | { mode: 'disabled'; devClone: boolean; pointerColumns: boolean }
  /** Dual-write path against the private dev content bucket. */
  | { mode: 'enabled'; bucket: string }
  /** Explicitly enabled in an incompatible environment: refuse before mutating. */
  | { mode: 'invalid'; error: string };

export function resolveBodyDualWrite(
  env: BodyDualWriteEnv
): BodyDualWriteDecision {
  const devClone = env.appEnv !== 'production' && env.schema === 'dev_staging';
  const productionPairing = env.appEnv === 'production' && env.schema === 'public';

  if (env.pointerColumns === true && !devClone && !productionPairing) {
    return {
      mode: 'invalid',
      error: `${POINTER_COLUMNS_FLAG} requires either the dev_staging clone or APP_ENV=production with schema public, got APP_ENV=${env.appEnv} schema=${env.schema}`,
    };
  }

  if (!env.enabled) {
    return {
      mode: 'disabled',
      devClone,
      // Declaring the capability is the only way production may name the
      // columns; the dev clone always has them.
      pointerColumns: devClone || (productionPairing && env.pointerColumns === true),
    };
  }
  const bucket = tryResolveContentBucket({ appEnv: env.appEnv, schema: env.schema });
  if (!bucket.ok) {
    return { mode: 'invalid', error: `${BODY_DUAL_WRITE_FLAG}: ${bucket.error}` };
  }
  return { mode: 'enabled', bucket: bucket.bucket };
}

export function currentBodyDualWrite(): BodyDualWriteDecision {
  // Read lazily per call, matching src/libs/cms/storage/bucket.ts, so tests (and
  // a process that changes env) resolve the gate at invocation time rather than
  // at module import. Mirrors src/config/shared.ts semantics.
  const appEnv =
    process.env.APP_ENV ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const schema = process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? 'public';
  return resolveBodyDualWrite({
    enabled: process.env[BODY_DUAL_WRITE_FLAG] === 'true',
    appEnv,
    schema,
    pointerColumns: process.env[POINTER_COLUMNS_FLAG] === 'true',
  });
}

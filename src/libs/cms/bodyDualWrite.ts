/**
 * Feature gate for Markdown body dual-write (Phase 7A).
 *
 * Dual-write is OPT-IN and only valid in the dev clone:
 *   CMS_BODY_DUAL_WRITE_ENABLED=true
 *   APP_ENV != production
 *   NEXT_PUBLIC_SUPABASE_DB_SCHEMA = dev_staging
 *
 * Anything else stays on the legacy path, and an explicitly-enabled but
 * incompatible environment is rejected before any DB or Storage mutation.
 * Production must never read or write the pointer columns, never resolve
 * `website-content`, and never touch a content bucket.
 *
 * Pure decision logic (injectable) so it can be unit-tested; the process
 * environment is read only by `currentBodyDualWrite()`.
 */
import { CONTENT_BUCKET_DEV } from '@/libs/cms/storage/contentBucket';

export const BODY_DUAL_WRITE_FLAG = 'CMS_BODY_DUAL_WRITE_ENABLED';

export type BodyDualWriteEnv = {
  /** Raw flag value — enabled only when exactly `'true'`. */
  enabled: boolean;
  appEnv: string;
  schema: string;
};

export type BodyDualWriteDecision =
  /** Legacy path. `devClone` marks the dev clone, where stale pointers are cleared. */
  | { mode: 'disabled'; devClone: boolean }
  /** Dual-write path against the private dev content bucket. */
  | { mode: 'enabled'; bucket: string }
  /** Explicitly enabled in an incompatible environment: refuse before mutating. */
  | { mode: 'invalid'; error: string };

export function resolveBodyDualWrite(
  env: BodyDualWriteEnv
): BodyDualWriteDecision {
  if (!env.enabled) {
    return {
      mode: 'disabled',
      devClone: env.appEnv !== 'production' && env.schema === 'dev_staging',
    };
  }
  if (env.appEnv === 'production') {
    return {
      mode: 'invalid',
      error: `${BODY_DUAL_WRITE_FLAG} must not be enabled in production (APP_ENV=production)`,
    };
  }
  if (env.schema !== 'dev_staging') {
    return {
      mode: 'invalid',
      error: `${BODY_DUAL_WRITE_FLAG} requires NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging, got '${env.schema}'`,
    };
  }
  return { mode: 'enabled', bucket: CONTENT_BUCKET_DEV };
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
  });
}

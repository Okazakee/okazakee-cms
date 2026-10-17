/**
 * Feature gate for Storage-first Markdown body reads (Phase 9A).
 *
 * Storage-first reads are OPT-IN and only valid in the dev clone:
 *   CMS_BODY_STORAGE_READ_ENABLED=true
 *   APP_ENV != production
 *   NEXT_PUBLIC_SUPABASE_DB_SCHEMA = dev_staging
 *
 * The flag is deliberately INDEPENDENT of `CMS_BODY_DUAL_WRITE_ENABLED`: reading
 * bodies from Storage and writing them to Storage activate separately, so a
 * deployment may dual-write without switching its readers (and vice versa).
 *
 * When disabled the legacy `body_en`/`body_it` columns stay the only source:
 * production must never reference the pointer columns, resolve `website-content`
 * or depend on a content bucket. An explicitly enabled but incompatible
 * environment is rejected before any DB or Storage call.
 *
 * Pure decision logic (injectable) so it can be unit-tested; the process
 * environment is read only by `currentBodyStorageRead()`.
 */
import { CONTENT_BUCKET_DEV } from '@/libs/cms/storage/contentBucket';

export const BODY_STORAGE_READ_FLAG = 'CMS_BODY_STORAGE_READ_ENABLED';

export type BodyStorageReadEnv = {
  /** Raw flag value — enabled only when exactly `'true'`. */
  enabled: boolean;
  appEnv: string;
  schema: string;
};

export type BodyStorageReadDecision =
  /** Legacy DB columns are the only source. */
  | { mode: 'disabled' }
  /** Storage-first reads against the private dev content bucket. */
  | { mode: 'enabled'; bucket: string }
  /** Explicitly enabled in an incompatible environment: refuse before reading. */
  | { mode: 'invalid'; error: string };

export function resolveBodyStorageRead(
  env: BodyStorageReadEnv
): BodyStorageReadDecision {
  if (!env.enabled) {
    return { mode: 'disabled' };
  }
  if (env.appEnv === 'production') {
    return {
      mode: 'invalid',
      error: `${BODY_STORAGE_READ_FLAG} must not be enabled in production (APP_ENV=production)`,
    };
  }
  if (env.schema !== 'dev_staging') {
    return {
      mode: 'invalid',
      error: `${BODY_STORAGE_READ_FLAG} requires NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging, got '${env.schema}'`,
    };
  }
  return { mode: 'enabled', bucket: CONTENT_BUCKET_DEV };
}

export function currentBodyStorageRead(): BodyStorageReadDecision {
  // Read lazily per call, matching src/libs/cms/bodyDualWrite.ts and
  // src/libs/cms/storage/bucket.ts, so tests (and a process that changes env)
  // resolve the gate at invocation time rather than at module import.
  const appEnv =
    process.env.APP_ENV ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const schema = process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? 'public';
  return resolveBodyStorageRead({
    enabled: process.env[BODY_STORAGE_READ_FLAG] === 'true',
    appEnv,
    schema,
  });
}

/**
 * Whether a body read may name the pointer columns (`body_en_path`,
 * `body_it_path`). Only the dev clone with the read flag enabled: production has
 * no pointer columns, so a query naming them there would fail (and must never
 * be attempted).
 */
export function bodyPointerColumnsReadable(
  decision: BodyStorageReadDecision
): boolean {
  return decision.mode === 'enabled';
}

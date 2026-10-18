/**
 * Feature gate for Storage-first Markdown body reads (Phase 9A).
 *
 * Storage-first reads are OPT-IN and only valid in the dev clone:
 *   CMS_BODY_STORAGE_READ_ENABLED=true
 *   APP_ENV=production + NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public  -> website-content
 *   APP_ENV!=production + NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging -> website-content-dev
 *
 * The flag is deliberately INDEPENDENT of `CMS_BODY_DUAL_WRITE_ENABLED`: reading
 * bodies from Storage and writing them to Storage activate separately, so a
 * deployment may dual-write without switching its readers (and vice versa).
 *
 * When disabled the legacy `body_en`/`body_it` columns stay the only source,
 * so production keeps its existing queries until the flag is explicitly turned
 * on. An enabled but incompatible environment is rejected before any DB or
 * Storage call, and the bucket pairing is resolved in one place
 * (`tryResolveContentBucket`) so the two environments can never cross over.
 *
 * Pure decision logic (injectable) so it can be unit-tested; the process
 * environment is read only by `currentBodyStorageRead()`.
 */
import { tryResolveContentBucket } from '@/libs/cms/storage/contentBucket';

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
  // Exactly two pairings are valid: production+public (bucket website-content)
  // and a non-production clone+dev_staging (bucket website-content-dev). Any
  // other pairing fails closed, so production can never read the dev bucket and
  // a dev clone can never read the production one.
  const bucket = tryResolveContentBucket({ appEnv: env.appEnv, schema: env.schema });
  if (!bucket.ok) {
    return { mode: 'invalid', error: `${BODY_STORAGE_READ_FLAG}: ${bucket.error}` };
  }
  return { mode: 'enabled', bucket: bucket.bucket };
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

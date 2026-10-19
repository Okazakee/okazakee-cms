/**
 * Environment gate for the Storage-only Markdown body write path.
 *
 * There is no "dual write" any more: the CMS writes a post body ONLY to the
 * private content bucket and keeps a content-addressed pointer in the row
 * (`body_<locale>_path`). The legacy `body_en`/`body_it` columns have been
 * dropped, so no opt-in remains to choose between the legacy column write and
 * the Storage write.
 *
 * What remains is the fail-closed environment pairing check: the write must
 * resolve to the content bucket that belongs to this environment
 *
 *   APP_ENV=production + NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public      -> website-content
 *   APP_ENV!=production + NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging -> website-content-dev
 *
 * and any other pairing is rejected BEFORE the first DB or Storage call, so the
 * two environments can never write each other's bucket.
 *
 * Pure decision logic (injectable) so it can be unit-tested; the process
 * environment is read only by `currentBodyWrite()`.
 */
import { tryResolveContentBucket } from '@/libs/cms/storage/contentBucket';

/**
 * Schema-capability flag: declares that the pointer columns EXIST in the
 * configured schema. It no longer gates a CMS write (every schema in the
 * cutover has the columns); `src/libs/cms/storage/prodBackfillPlan.ts` and the
 * production backfill CLI still import it to decide whether a plan may name
 * `body_*_path`.
 */
export const POINTER_COLUMNS_FLAG = 'CMS_BODY_POINTER_COLUMNS';

export type BodyWriteEnv = {
  appEnv: string;
  schema: string;
};

export type BodyWriteDecision =
  /** Content-addressed Markdown writes against this bucket. */
  | { mode: 'enabled'; bucket: string }
  /** Incompatible environment: refuse before mutating anything. */
  | { mode: 'invalid'; error: string };

export function resolveBodyWrite(env: BodyWriteEnv): BodyWriteDecision {
  const bucket = tryResolveContentBucket({
    appEnv: env.appEnv,
    schema: env.schema,
  });
  if (!bucket.ok) {
    return { mode: 'invalid', error: bucket.error };
  }
  return { mode: 'enabled', bucket: bucket.bucket };
}

export function currentBodyWrite(): BodyWriteDecision {
  // Read lazily per call, matching src/libs/cms/storage/bucket.ts, so tests (and
  // a process that changes env) resolve the gate at invocation time rather than
  // at module import.
  const appEnv =
    process.env.APP_ENV ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const schema = process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? 'public';
  return resolveBodyWrite({ appEnv, schema });
}

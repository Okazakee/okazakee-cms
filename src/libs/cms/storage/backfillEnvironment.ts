/**
 * Narrow, explicit environment descriptor for the Markdown body backfill
 * tooling (Phase 11 DEV, Phase 13 production).
 *
 * DEV and production are different SCHEMAS of the same Supabase project
 * (`mtvwynyikouqzmhqespl`), so the migration contract is identical and only a
 * handful of values differ. This module is that difference, and nothing else:
 * the pinned app environment, schema, project reference, bucket, CAS function
 * names, column projections, journal variable, acknowledgement pair and the
 * cache-invalidation policy.
 *
 * Everything that has to behave identically for both — canonical SHA-256
 * paths, immutable uploads, exact-byte verification, atomic CAS, durable
 * journal recovery, fail-fast ordering, signed invalidation and the guarded
 * rollback — lives in the shared modules (`bodyContent`, `backfillCas`,
 * `backfillJournal`, `backfillApply`) and is configured from here. Cloning
 * those implementations per environment is exactly what this file exists to
 * prevent, and it also keeps the two entry points unambiguous: a descriptor
 * value is never inferred from the other environment at runtime.
 *
 * The descriptor deliberately carries no DEV-specific default: production
 * refuses anything but its own descriptor values, so a missing or misspelled
 * variable can never target the DEV schema/bucket (and vice versa).
 */

export type BackfillEnvironmentName = 'dev' | 'production';

/**
 * Approved signed cache-invalidation destination.
 *
 * - `local-http`: the DEV loop, where the public site runs on localhost.
 * - `https-allowlist`: production, where the destination must be an explicitly
 *   configured HTTPS origin. There is NO default origin: the operator supplies
 *   the exact origins, so the tooling never invents a hostname and a typo in
 *   the allowlist fails closed instead of reaching an unexpected host.
 */
export type BackfillRevalidationPolicy =
  | { kind: 'local-http'; allowedPath: string }
  | { kind: 'https-allowlist'; allowedPath: string; originsEnv: string };

/** Every value that differs between the two environments. */
export type BackfillEnvironmentSpec = {
  name: BackfillEnvironmentName;
  /** `package.json` script prefix, for usage strings and reports. */
  commandPrefix: string;
  /** Exact `APP_ENV` this tooling may run under. */
  appEnv: string;
  /** Exact `NEXT_PUBLIC_SUPABASE_DB_SCHEMA` this tooling may operate on. */
  schema: string;
  /** The only project reference this tooling may target. */
  projectRef: string;
  /** The only destination bucket this tooling may upload to. */
  bucket: string;
  /** Staged/installed atomic CAS function names for this environment. */
  cas: { forward: string; rollback: string };
  /** Explicit column projections: bodies only, and bodies + pointers. */
  projections: { bodies: string; pointers: string };
  /** Environment variable naming the durable journal file. */
  journal: { env: string };
  /** Operator acknowledgement that arms `--apply`. */
  applyAck: { env: string; value: string };
  /** Operator acknowledgement that arms rollback `--apply`. */
  rollbackAck: { env: string; value: string };
  revalidation: BackfillRevalidationPolicy;
};

/** The two legacy body columns every environment always has. */
export const BACKFILL_BODY_COLUMNS = 'id,body_en,body_it';

/**
 * Bodies plus the committed pointers. Only a schema that has the pointer
 * columns installed may be read with this projection, which is why the
 * inventory selects `BACKFILL_BODY_COLUMNS` until the capability is declared.
 */
export const BACKFILL_POINTER_COLUMNS =
  'id,body_en,body_it,body_en_path,body_it_path';

/** Path of the public site's signed revalidation Route Handler. */
export const REVALIDATION_PATH = '/api/internal/content-revalidate';

/** DEV: `dev_staging` + `website-content-dev`, local HTTP revalidation. */
export const DEV_BACKFILL_ENVIRONMENT: BackfillEnvironmentSpec = {
  name: 'dev',
  commandPrefix: 'storage:content:dev:backfill',
  appEnv: 'development',
  schema: 'dev_staging',
  projectRef: 'mtvwynyikouqzmhqespl',
  bucket: 'website-content-dev',
  cas: {
    forward: 'dev_backfill_body_pointer_cas',
    rollback: 'dev_backfill_body_pointer_rollback',
  },
  projections: {
    bodies: BACKFILL_BODY_COLUMNS,
    pointers: BACKFILL_POINTER_COLUMNS,
  },
  journal: { env: 'BACKFILL_JOURNAL_PATH' },
  applyAck: {
    env: 'CMS_BACKFILL_APPLY_ACK',
    value: 'yes-apply-to-dev-staging',
  },
  rollbackAck: {
    env: 'CMS_BACKFILL_ROLLBACK_ACK',
    value: 'yes-rollback-dev-staging',
  },
  revalidation: { kind: 'local-http', allowedPath: REVALIDATION_PATH },
};

/**
 * Production: `public` + `website-content`, HTTPS-only revalidation.
 *
 * Both the acknowledgement variables AND their values differ from DEV's, and
 * the journal variable name differs too, so no DEV value can ever arm a
 * production run.
 */
export const PROD_BACKFILL_ENVIRONMENT: BackfillEnvironmentSpec = {
  name: 'production',
  commandPrefix: 'storage:content:prod:backfill',
  appEnv: 'production',
  schema: 'public',
  projectRef: 'mtvwynyikouqzmhqespl',
  bucket: 'website-content',
  cas: {
    forward: 'prod_backfill_body_pointer_cas',
    rollback: 'prod_backfill_body_pointer_rollback',
  },
  projections: {
    bodies: BACKFILL_BODY_COLUMNS,
    pointers: BACKFILL_POINTER_COLUMNS,
  },
  journal: { env: 'PROD_BACKFILL_JOURNAL_PATH' },
  applyAck: {
    env: 'CMS_PROD_BACKFILL_APPLY_ACK',
    value: 'yes-apply-to-production-backfill',
  },
  rollbackAck: {
    env: 'CMS_PROD_BACKFILL_ROLLBACK_ACK',
    value: 'yes-rollback-to-production-backfill',
  },
  revalidation: {
    kind: 'https-allowlist',
    allowedPath: REVALIDATION_PATH,
    originsEnv: 'CMS_PROD_REVALIDATION_ORIGINS',
  },
};

/** `https://<ref>.supabase.co` -> `<ref>`; null when the URL is not usable. */
export function projectRefFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const match = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(url.hostname);
  return match ? match[1] : null;
}

/** What the process actually observed; every field is validated before any read. */
export type BackfillObservedEnvironment = {
  appEnv: string;
  schema: string;
  supabaseUrl: string;
  hasServerSecret: boolean;
};

/**
 * Fail-closed environment gate for a descriptor.
 *
 * It runs BEFORE the first database or Storage call and refuses anything that
 * is not exactly the descriptor's environment: the app env, the schema, the
 * project reference and a server-side secret are all pinned, there is no
 * fallback, and the destination bucket is a compile-time constant of the
 * descriptor rather than a runtime value.
 */
export function assertBackfillEnvironment(
  spec: BackfillEnvironmentSpec,
  observed: BackfillObservedEnvironment
): void {
  const prefix = `[${spec.name}-backfill]`;
  if (observed.appEnv !== spec.appEnv) {
    throw new Error(
      `${prefix} refusing to run: APP_ENV must be exactly '${spec.appEnv}', got '${observed.appEnv}'`
    );
  }
  if (observed.schema !== spec.schema) {
    throw new Error(
      `${prefix} refusing to run: NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be '${spec.schema}', got '${observed.schema}'`
    );
  }
  if (!observed.supabaseUrl) {
    throw new Error(`${prefix} missing NEXT_PUBLIC_SUPABASE_URL`);
  }
  const ref = projectRefFromUrl(observed.supabaseUrl);
  if (!ref) {
    throw new Error(
      `${prefix} NEXT_PUBLIC_SUPABASE_URL '${observed.supabaseUrl}' is not a usable https://<ref>.supabase.co URL`
    );
  }
  if (ref !== spec.projectRef) {
    throw new Error(
      `${prefix} project mismatch: configured URL targets '${ref}' but the ${spec.name} tooling only operates on '${spec.projectRef}'`
    );
  }
  if (!observed.hasServerSecret) {
    throw new Error(
      `${prefix} missing SUPABASE_SECRET_KEY (server-side credentials required)`
    );
  }
}

export type RevalidationOriginsParse =
  | { ok: true; origins: string[] }
  | { ok: false; error: string };

/**
 * Parses the configured HTTPS origin allowlist (`CMS_PROD_REVALIDATION_ORIGINS`)
 * as a comma-separated list of bare origins.
 *
 * Every entry must be `https://host[:port]` with no path, query, fragment or
 * credentials, and the list may not be empty: an unreadable allowlist must
 * refuse rather than silently approve the destination.
 */
export function parseRevalidationOrigins(
  raw: string
): RevalidationOriginsParse {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    return {
      ok: false,
      error: 'the HTTPS revalidation origin allowlist is empty',
    };
  }
  const origins: string[] = [];
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return { ok: false, error: `'${entry}' is not a valid origin` };
    }
    if (url.protocol !== 'https:') {
      return { ok: false, error: `'${entry}' must use https` };
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return {
        ok: false,
        error: `'${entry}' must be a bare origin without a path`,
      };
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, error: `'${entry}' must not carry credentials` };
    }
    if (!url.hostname) {
      return { ok: false, error: `'${entry}' has no host` };
    }
    origins.push(url.origin.toLowerCase());
  }
  return { ok: true, origins };
}

/**
 * Validates the configured revalidation destination against a descriptor's
 * policy. Returns a human-readable problem, or null when the destination is
 * approved.
 *
 * The DEV policy accepts a local HTTP(S) host on the exact path (the dev loop);
 * the production policy requires HTTPS and an origin that appears verbatim in
 * the operator-supplied allowlist — DEV's local rules are never consulted for
 * production, and no hostname is ever assumed.
 */
export function validateRevalidationEndpointFor(
  spec: BackfillEnvironmentSpec,
  rawUrl: string,
  origins: string[] = []
): string | null {
  const envVar = 'WEBSITE_REVALIDATION_URL';
  if (!rawUrl) return `${envVar} is not configured`;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `${envVar} '${rawUrl}' is not a valid URL`;
  }

  if (spec.revalidation.kind === 'local-http') {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `${envVar} must be http(s), got '${url.protocol}'`;
    }
    const host = url.hostname.toLowerCase();
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]';
    if (!isLocal) {
      return `${envVar} must target a local DEV host, got '${host}'`;
    }
    if (url.pathname !== spec.revalidation.allowedPath) {
      return `${envVar} path must be '${spec.revalidation.allowedPath}', got '${url.pathname}'`;
    }
    return null;
  }

  // Production: HTTPS only, exact origin from the operator's allowlist.
  if (url.protocol !== 'https:') {
    return `${envVar} must use https in production, got '${url.protocol}'`;
  }
  if (url.username !== '' || url.password !== '') {
    return `${envVar} must not carry credentials`;
  }
  if (origins.length === 0) {
    return `${spec.revalidation.originsEnv} must list the approved HTTPS origin(s)`;
  }
  if (!origins.includes(url.origin.toLowerCase())) {
    return `${envVar} origin '${url.origin}' is not in ${spec.revalidation.originsEnv}`;
  }
  if (url.pathname !== spec.revalidation.allowedPath) {
    return `${envVar} path must be '${spec.revalidation.allowedPath}', got '${url.pathname}'`;
  }
  return null;
}

/**
 * Apply gate for a descriptor: the acknowledgement variable must carry exactly
 * the descriptor's value. Called by the CLI and again by the run helper, so a
 * direct caller cannot skip it either — and passing the OTHER environment's
 * value (e.g. DEV's `yes-apply-to-dev-staging`) is refused by construction.
 */
export function assertBackfillAcknowledged(
  spec: BackfillEnvironmentSpec,
  kind: 'apply' | 'rollback',
  ack: string | undefined
): void {
  const expected = kind === 'apply' ? spec.applyAck : spec.rollbackAck;
  if (ack !== expected.value) {
    throw new Error(
      `[${spec.name}-backfill] refusing to mutate: set ${expected.env}=${expected.value} to acknowledge a ${spec.name} ${kind}${kind === 'apply' ? ' backfill run' : ''}`
    );
  }
}

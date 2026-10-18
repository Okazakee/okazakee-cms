#!/usr/bin/env node
/**
 * Production content-bucket provisioning command (Phase 13 gate B2).
 *
 *   bun run storage:content:prod:setup
 *   CMS_PROD_STORAGE_APPLY_ACK=yes-apply-to-production \
 *     bun run storage:content:prod:setup --apply
 *
 * The private Markdown body bucket metadata is API-managed (current Supabase
 * Storage guidance), not inserted into `storage.buckets` by SQL, so production
 * provisioning is this command. It is deliberately NOT the dev command with a
 * different bucket name — production gets the opposite posture:
 *
 *   - silence is read-only: without `--apply` the command only *reports* the
 *     bucket's existence, its exact configuration and any drift. It performs
 *     zero Storage mutations in that mode.
 *   - a mutation needs BOTH an explicit `--apply` and an operator
 *     acknowledgement (`CMS_PROD_STORAGE_APPLY_ACK`) that is a different env
 *     var *and* a different value from the dev one, so a dev acknowledgement
 *     can never arm a production run.
 *   - the environment gate runs before the first Storage call and refuses
 *     anything that is not APP_ENV=production + schema=public + the exact
 *     production project reference. A missing or misspelled value can never
 *     reach the production bucket.
 *   - it may only ever CREATE the missing `website-content` bucket with the
 *     exact required configuration. It never updates, deletes or recreates a
 *     bucket, never touches `website-content-dev` (the dev sibling bucket),
 *     and has no object API at all.
 *   - an existing bucket whose configuration is wrong is reported, never
 *     silently repaired: rewriting a live production bucket's visibility or
 *     limits is a deliberate operator decision, not a side effect of
 *     inspection.
 *
 * Everything below is pure/injectable so the decision logic is unit-testable
 * against a fake Storage API (see `prodStorageSetup.test.ts`). Nothing runs on
 * import: the CLI entry is guarded by a direct-invocation check.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import { projectRefFromUrl } from '@/libs/cms/storage/backfillPlan';
import {
  CONTENT_BUCKET_DEV,
  CONTENT_BUCKET_PROD,
} from '@/libs/cms/storage/contentBucket';

/** CLI name (matches the `package.json` script, which the parent owns). */
export const PROD_STORAGE_SETUP_COMMAND = 'storage:content:prod:setup';

/**
 * The only project this command may ever provision.
 *
 * Dev and production share ONE Supabase project — the dev clone is the
 * `dev_staging` schema inside it — so production is identified by
 * APP_ENV + schema, and the URL is additionally bound to this exact
 * reference. A URL pointing anywhere else is refused before any Storage call.
 */
export const EXPECTED_PROD_PROJECT_REF = 'mtvwynyikouqzmhqespl';

/** The only bucket this command may ever provision; never the dev sibling. */
export const PROD_CONTENT_BUCKET = CONTENT_BUCKET_PROD;

/** Exact required configuration; any divergence is drift to report. */
export const PROD_CONTENT_BUCKET_CONFIG = {
  public: false,
  fileSizeLimit: 1_048_576,
  allowedMimeTypes: ['text/markdown'],
} as const;

/**
 * Production acknowledgement. Both the variable name and the value differ
 * from the dev acknowledgement (`CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging`),
 * so an operator's dev environment cannot arm a production Storage change.
 */
export const PROD_APPLY_ACK_ENV = 'CMS_PROD_STORAGE_APPLY_ACK';
export const PROD_APPLY_ACK_VALUE = 'yes-apply-to-production';

export const PROD_STORAGE_SETUP_USAGE = [
  'usage:',
  `  bun run ${PROD_STORAGE_SETUP_COMMAND}            # read-only inspection`,
  `  bun run ${PROD_STORAGE_SETUP_COMMAND} --apply     # create the bucket if missing`,
  '',
  `--apply additionally requires ${PROD_APPLY_ACK_ENV}=${PROD_APPLY_ACK_VALUE},`,
  'APP_ENV=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public and',
  `NEXT_PUBLIC_SUPABASE_URL=https://${EXPECTED_PROD_PROJECT_REF}.supabase.co.`,
  'Inspection never mutates; an existing bucket is never rewritten.',
].join('\n');

/** The bucket fields this command compares against the required configuration. */
export type StorageBucketRow = {
  id: string;
  name: string;
  public: boolean;
  /** Absent/null on the wire when the bucket has no per-bucket limit. */
  file_size_limit?: number | null;
  /** Absent/null on the wire when every MIME type is accepted. */
  allowed_mime_types?: string[] | null;
};

export type StorageError = { message: string };

export type StorageBucketOptions = {
  public: boolean;
  fileSizeLimit: number;
  allowedMimeTypes: string[];
};

/**
 * The Storage surface this command needs, narrowed to one read and one
 * create. There is no update/delete/object method in the type, and the
 * injected fakes in the tests implement the wider Storage API to prove that
 * no other call is ever reached at runtime.
 */
export type ProdStorageBucketApi = {
  listBuckets(): Promise<{
    data: StorageBucketRow[] | null;
    error: StorageError | null;
  }>;
  createBucket(
    id: string,
    options: StorageBucketOptions
  ): Promise<{ data: unknown; error: StorageError | null }>;
};

export type ProdBucketStatus =
  /** No bucket with this name exists (read-only report). */
  | 'missing'
  /** Present with exactly the required configuration — idempotent no-op. */
  | 'already-correct'
  /** Present but diverging from the required configuration — never repaired. */
  | 'drifted'
  /** Created by this run (`--apply` only). */
  | 'created';

export type ProdStorageSetupEnv = {
  appEnv: string;
  schema: string;
  supabaseUrl: string;
  hasServerSecret: boolean;
};

export type ProdStorageSetupOptions = {
  /** Explicit `--apply`; a missing flag is always read-only. */
  apply: boolean;
  /** Value of `PROD_APPLY_ACK_ENV`; ignored unless `apply` is true. */
  ack: string | undefined;
};

export type ProdStorageSetupResult = {
  command: typeof PROD_STORAGE_SETUP_COMMAND;
  mode: 'inspect' | 'apply';
  /** True when the observed state is the required one (`already-correct`/`created`). */
  ok: boolean;
  appEnv: string;
  schema: string;
  projectRef: string;
  bucket: string;
  status: ProdBucketStatus;
  mutated: boolean;
  /** 0 in every read-only run; 1 only for a create. */
  mutationsPerformed: number;
  /** Exact required-vs-live divergences; empty unless `status` is `drifted`. */
  drift: string[];
  /**
   * Content buckets the project reports that are neither the production
   * bucket nor the known dev sibling — reported for human review, never
   * touched.
   */
  unexpectedBuckets: string[];
  /** Every bucket name the project reported (read-only visibility). */
  observedBuckets: string[];
  config: StorageBucketOptions;
};

/** Bucket names that hold long-form post bodies on this project. */
const CONTENT_BUCKET_PREFIX = 'website-content';

/** The two content buckets this project is expected to own. */
const KNOWN_CONTENT_BUCKETS: readonly string[] = [
  PROD_CONTENT_BUCKET,
  CONTENT_BUCKET_DEV,
];

/**
 * Fail-closed environment gate, in the spirit of
 * `src/libs/cms/storage/backfillPlan.ts`: it runs BEFORE the first Storage
 * call, and every value must be explicit. Production is required (`else`
 * includes dev, staging and unset), the schema must be `public`, and the URL
 * must parse as `https://<ref>.supabase.co/<nothing else>` naming exactly
 * `EXPECTED_PROD_PROJECT_REF` — a missing or misspelled value can therefore
 * never target a project this command was not meant to touch.
 */
export function assertProdStorageSetupAllowed(env: ProdStorageSetupEnv): void {
  if (env.appEnv !== 'production') {
    throw new Error(
      `[prod-storage-setup] refusing to run: APP_ENV must be exactly 'production', got '${env.appEnv}'`
    );
  }
  if (env.schema !== 'public') {
    throw new Error(
      `[prod-storage-setup] refusing to run: NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be 'public', got '${env.schema}'`
    );
  }
  if (!env.supabaseUrl) {
    throw new Error('[prod-storage-setup] missing NEXT_PUBLIC_SUPABASE_URL');
  }
  const ref = projectRefFromUrl(env.supabaseUrl);
  if (!ref) {
    throw new Error(
      `[prod-storage-setup] NEXT_PUBLIC_SUPABASE_URL '${env.supabaseUrl}' is not a usable https://<ref>.supabase.co URL`
    );
  }
  if (ref !== EXPECTED_PROD_PROJECT_REF) {
    throw new Error(
      `[prod-storage-setup] project mismatch: configured URL targets '${ref}' but this command only operates on '${EXPECTED_PROD_PROJECT_REF}'`
    );
  }
  // The bucket this command may create is a compile-time constant distinct
  // from the dev sibling; `PROD_CONTENT_BUCKET` is the only id ever passed to
  // `createBucket`, and `prodStorageSetup.test.ts` pins that value.
  if (!env.hasServerSecret) {
    throw new Error(
      '[prod-storage-setup] missing SUPABASE_SECRET_KEY (server-side credentials required)'
    );
  }
}

/**
 * Apply gate: without the exact production acknowledgement there is no
 * mutation path. Called by the CLI (to map the exit code) and again by
 * `runProdStorageSetup`, so a direct caller cannot skip it either.
 */
export function assertProdApplyAcknowledged(ack: string | undefined): void {
  if (ack !== PROD_APPLY_ACK_VALUE) {
    throw new Error(
      `[prod-storage-setup] refusing to mutate: set ${PROD_APPLY_ACK_ENV}=${PROD_APPLY_ACK_VALUE} to acknowledge a production Storage change`
    );
  }
}

/**
 * The acknowledgement value the environment carries, if any. Takes a plain
 * string map rather than `process.env` so callers (and tests) can inject an
 * exact environment instead of mutating global state.
 */
export function readProdApplyAck(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env[PROD_APPLY_ACK_ENV];
}

/** Sorted, lowercased MIME list for a stable drift comparison. */
function normalizeMimeTypes(value: string[] | null | undefined): string[] {
  return (value ?? []).map((mime) => mime.trim().toLowerCase()).sort();
}

/**
 * Every divergence between a live bucket and the required configuration,
 * including unexpected extra values (an extra MIME type, a non-null size
 * limit, a public bucket). Each line names what was observed and what is
 * required, so the report is actionable without a second command.
 */
export function prodBucketDrift(bucket: StorageBucketRow): string[] {
  const drift: string[] = [];
  if (bucket.public !== PROD_CONTENT_BUCKET_CONFIG.public) {
    drift.push(`public got=${bucket.public} exp=false`);
  }
  const sizeLimit = bucket.file_size_limit ?? null;
  if (sizeLimit !== PROD_CONTENT_BUCKET_CONFIG.fileSizeLimit) {
    drift.push(
      `file_size_limit got=${sizeLimit} exp=${PROD_CONTENT_BUCKET_CONFIG.fileSizeLimit}`
    );
  }
  const gotMime = normalizeMimeTypes(bucket.allowed_mime_types);
  const expectedMime = normalizeMimeTypes([
    ...PROD_CONTENT_BUCKET_CONFIG.allowedMimeTypes,
  ]);
  if (gotMime.join(',') !== expectedMime.join(',')) {
    drift.push(
      `allowed_mime_types got=${JSON.stringify(bucket.allowed_mime_types ?? null)} exp=${JSON.stringify(
        [...PROD_CONTENT_BUCKET_CONFIG.allowedMimeTypes]
      )}`
    );
  }
  return drift;
}

/**
 * Content-family buckets the project reports besides the two known ones
 * (`website-content`, `website-content-dev`). A third name means something
 * else writes post bodies under a bucket this command does not own: it is
 * surfaced for a human to review and is never read from or written to.
 */
export function unexpectedContentBuckets(names: string[]): string[] {
  return names
    .filter(
      (name) =>
        name.startsWith(CONTENT_BUCKET_PREFIX) &&
        !KNOWN_CONTENT_BUCKETS.includes(name)
    )
    .sort();
}

/**
 * Environment-gated entry point. Validates the environment (and, when
 * applying, the acknowledgement) BEFORE the first Storage call, then reports
 * or creates.
 *
 * Read-only (`apply: false`): exactly one `listBuckets` call; no create, ever.
 * Apply: creates the bucket only when it is absent. A present bucket is never
 * updated, deleted or recreated — drift is reported instead, and the caller
 * decides deliberately.
 */
export async function runProdStorageSetup(
  env: ProdStorageSetupEnv,
  storage: ProdStorageBucketApi,
  options: ProdStorageSetupOptions
): Promise<ProdStorageSetupResult> {
  assertProdStorageSetupAllowed(env);
  if (options.apply) {
    assertProdApplyAcknowledged(options.ack);
  }

  const listed = await storage.listBuckets();
  // Fail closed: a failed or partial listing must never be read as "the
  // bucket is missing" and must never justify a create.
  if (listed.error) {
    throw new Error(
      `[prod-storage-setup] listBuckets() failed: ${listed.error.message}`
    );
  }

  const buckets = listed.data ?? [];
  const observedBuckets = buckets.map((bucket) => bucket.name).sort();
  const unexpectedBuckets = unexpectedContentBuckets(observedBuckets);
  // Rebuilt per call so a caller (or a fake) cannot mutate the required
  // configuration through the returned report.
  const config: StorageBucketOptions = {
    public: PROD_CONTENT_BUCKET_CONFIG.public,
    fileSizeLimit: PROD_CONTENT_BUCKET_CONFIG.fileSizeLimit,
    allowedMimeTypes: [...PROD_CONTENT_BUCKET_CONFIG.allowedMimeTypes],
  };
  // Everything the report knows before the bucket state is decided; the
  // explicit annotation keeps the `command` literal and the array types
  // narrow when the state branch spreads this object.
  const base: Omit<
    ProdStorageSetupResult,
    'ok' | 'status' | 'mutated' | 'mutationsPerformed' | 'drift'
  > = {
    command: PROD_STORAGE_SETUP_COMMAND,
    mode: options.apply ? ('apply' as const) : ('inspect' as const),
    appEnv: env.appEnv,
    schema: env.schema,
    projectRef: projectRefFromUrl(env.supabaseUrl) ?? '',
    bucket: PROD_CONTENT_BUCKET,
    observedBuckets,
    unexpectedBuckets,
    config,
  };

  const existing = buckets.find(
    (bucket) => bucket.name === PROD_CONTENT_BUCKET
  );

  if (!existing) {
    if (!options.apply) {
      return {
        ...base,
        ok: false,
        status: 'missing',
        mutated: false,
        mutationsPerformed: 0,
        drift: [],
      };
    }
    const created = await storage.createBucket(PROD_CONTENT_BUCKET, config);
    if (created.error) {
      throw new Error(
        `[prod-storage-setup] createBucket(${PROD_CONTENT_BUCKET}) failed: ${created.error.message}`
      );
    }
    return {
      ...base,
      ok: true,
      status: 'created',
      mutated: true,
      mutationsPerformed: 1,
      drift: [],
    };
  }

  const drift = prodBucketDrift(existing);
  return {
    ...base,
    ok: drift.length === 0,
    status: drift.length === 0 ? 'already-correct' : 'drifted',
    mutated: false,
    mutationsPerformed: 0,
    drift,
  };
}

/** Strict flag parsing: the only accepted argument is `--apply`. */
export type ProdStorageSetupArgs =
  | { mode: 'inspect' }
  | { mode: 'apply' }
  | { mode: 'help' }
  | { mode: 'invalid'; error: string };

/**
 * No default mode beyond read-only: silence inspects, and every unknown or
 * extra argument is refused rather than ignored, so a typo can never be
 * mistaken for a mutation request.
 */
export function parseProdSetupArgs(argv: string[]): ProdStorageSetupArgs {
  if (argv.length === 0) return { mode: 'inspect' };
  if (argv.length === 1 && argv[0] === '--apply') return { mode: 'apply' };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { mode: 'help' };
  }
  return {
    mode: 'invalid',
    error: `unexpected argument(s): ${argv.join(' ')}`,
  };
}

/**
 * True only when this module is the process entry point. Tests import the
 * module (argv[1] is the test runner), and package imports must never run the
 * command as a side effect.
 */
export function isDirectInvocation(argv: string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * CLI entry, in the exit-code convention documented for the other maintenance
 * commands (`docs/BACKFILL_EXECUTOR.md`): 0 settled, 1 attention required,
 * 2 invalid usage, 3 environment/project gate, 4 read/execution failure,
 * 5 refused by the apply gate.
 */
async function main(): Promise<void> {
  const args = parseProdSetupArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log(PROD_STORAGE_SETUP_USAGE);
    process.exit(0);
  }
  if (args.mode === 'invalid') {
    console.error(`[prod-storage-setup] ${args.error}`);
    console.error(PROD_STORAGE_SETUP_USAGE);
    process.exit(2);
  }

  const env: ProdStorageSetupEnv = {
    appEnv,
    schema: supabaseSchema,
    supabaseUrl,
    hasServerSecret: supabaseServerSecret !== '',
  };
  try {
    assertProdStorageSetupAllowed(env);
  } catch (error) {
    console.error(messageOf(error));
    console.error(
      `[prod-storage-setup] expected: APP_ENV=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public, project ${EXPECTED_PROD_PROJECT_REF}, bucket ${PROD_CONTENT_BUCKET}, server secret present`
    );
    process.exit(3);
  }

  if (args.mode === 'apply') {
    try {
      assertProdApplyAcknowledged(readProdApplyAck(process.env));
    } catch (error) {
      console.error(messageOf(error));
      process.exit(5);
    }
  }

  let result: ProdStorageSetupResult;
  try {
    const supabase = createClient(supabaseUrl, supabaseServerSecret, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    result = await runProdStorageSetup(
      env,
      supabase.storage as ProdStorageBucketApi,
      { apply: args.mode === 'apply', ack: readProdApplyAck(process.env) }
    );
  } catch (error) {
    console.error(`${PROD_STORAGE_SETUP_COMMAND} failed: ${messageOf(error)}`);
    process.exit(4);
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'missing') {
    console.log(
      `missing: '${PROD_CONTENT_BUCKET}' does not exist; re-run with --apply and ${PROD_APPLY_ACK_ENV}=${PROD_APPLY_ACK_VALUE} to create it with the required configuration.`
    );
  }
  if (result.status === 'drifted') {
    console.log(
      'drifted: this command never rewrites an existing production bucket — reconcile the divergence above deliberately, then re-run to confirm.'
    );
  }
  if (result.unexpectedBuckets.length > 0) {
    console.log(
      `unexpected: content buckets ${result.unexpectedBuckets.join(', ')} were reported but are not owned by this command — review them manually.`
    );
  }
  process.exit(result.ok ? 0 : 1);
}

if (isDirectInvocation(process.argv, import.meta.url)) {
  await main();
}

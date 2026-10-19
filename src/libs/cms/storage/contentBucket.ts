/**
 * Private content buckets: the Storage destination for long-form Markdown post
 * bodies (Phase 5B foundation) and the single place that maps an environment to
 * the bucket that belongs to it.
 *
 * The bucket metadata is API-managed (per current Supabase Storage guidance),
 * NOT inserted into `storage.buckets` by SQL, so provisioning lives in a
 * server-side maintenance command (`bun run storage:content:dev:setup`) built on
 * this module. Everything here is pure/injectable so the command's decision
 * logic is unit-testable without touching a real project, and every read/write
 * path resolves its bucket through `resolveContentBucket` /
 * `currentContentBucket` rather than naming one.
 *
 * This module is server-only: it is imported by the setup command, never by
 * client components.
 */

/** The only bucket this module may ever provision. */
export const CONTENT_BUCKET_DEV = 'website-content-dev';

/** Exact desired configuration; any divergence is drift to converge. */
export const CONTENT_BUCKET_DEV_CONFIG = {
  public: false,
  fileSizeLimit: 1_048_576,
  allowedMimeTypes: ['text/markdown'],
} as const;

/** The bucket Supabase owns for public dev assets — must never be touched. */
export const ASSET_BUCKET_DEV = 'website-dev';

/** Production content bucket — deliberately NOT created in this phase. */
export const CONTENT_BUCKET_PROD = 'website-content';

/**
 * Deterministic environment -> content bucket selection, fail-closed. Only the
 * two consistent production/dev pairs resolve; a mismatched or unknown pair
 * throws rather than guessing. Pure: it neither provisions nor verifies
 * anything.
 */
export function resolveContentBucket(env: {
  appEnv: string;
  schema: string;
}): string {
  if (env.appEnv === 'production' && env.schema === 'public') {
    return CONTENT_BUCKET_PROD;
  }
  if (env.appEnv !== 'production' && env.schema === 'dev_staging') {
    return CONTENT_BUCKET_DEV;
  }
  throw new Error(
    `[content-bucket] refusing to resolve a content bucket for APP_ENV=${env.appEnv} schema=${env.schema} (expected production+public or non-production+dev_staging)`
  );
}

/**
 * Result-typed variant for the feature gates: the only two valid pairings
 * resolve, everything else is reported instead of thrown, so a gate can fail
 * closed with its own flag-specific message. Production resolves ONLY the
 * production bucket and a dev clone ONLY the dev bucket — there is no pairing
 * that crosses over.
 */
export type ContentBucketResolution =
  | { ok: true; bucket: string }
  | { ok: false; error: string };

export function tryResolveContentBucket(env: {
  appEnv: string;
  schema: string;
}): ContentBucketResolution {
  try {
    return { ok: true, bucket: resolveContentBucket(env) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The content bucket of the CURRENT process, read lazily per call so tests (and
 * a process that changes env) resolve at invocation time rather than at module
 * import. Result-typed so a caller fails closed with its own message instead of
 * guessing a bucket; the env semantics match `src/config/shared.ts`: `APP_ENV`
 * falls back to `NODE_ENV` and the schema falls back to `public` (which is
 * therefore refused outside production).
 */
export function currentContentBucket(): ContentBucketResolution {
  const appEnv =
    process.env.APP_ENV ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const schema = process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? 'public';
  return tryResolveContentBucket({ appEnv, schema });
}

export type StorageBucketRow = {
  id: string;
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
};

export type StorageError = { message: string };

export type StorageBucketApi = {
  getBucket(
    id: string
  ): Promise<{ data: StorageBucketRow | null; error: StorageError | null }>;
  createBucket(
    id: string,
    options: {
      public: boolean;
      fileSizeLimit: number;
      allowedMimeTypes: string[];
    }
  ): Promise<{ data: unknown; error: StorageError | null }>;
  updateBucket(
    id: string,
    options: {
      public: boolean;
      fileSizeLimit: number;
      allowedMimeTypes: string[];
    }
  ): Promise<{ data: unknown; error: StorageError | null }>;
};

export type BucketSetupStatus = 'created' | 'already-correct' | 'updated';

export type BucketSetupResult = {
  status: BucketSetupStatus;
  bucket: string;
  changes: string[];
  config: {
    public: boolean;
    fileSizeLimit: number;
    allowedMimeTypes: string[];
  };
};

export type ContentBucketSetupEnv = {
  appEnv: string;
  schema: string;
  supabaseUrl: string;
  hasServerSecret: boolean;
};

/**
 * Fail-closed environment gate, in the spirit of
 * `src/libs/cms/storage/bucket.ts`: a missing or misspelled value must never
 * silently target production. This command is dev-only, so it refuses the
 * production environment and any schema other than `dev_staging` before the
 * first Storage call.
 */
export function assertContentBucketSetupAllowed(
  env: ContentBucketSetupEnv
): void {
  if (env.appEnv === 'production') {
    throw new Error(
      `[content-bucket] refusing to run in production (APP_ENV=${env.appEnv}); ${CONTENT_BUCKET_DEV} is dev-only`
    );
  }
  if (env.schema !== 'dev_staging') {
    throw new Error(
      `[content-bucket] refusing to run: NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be 'dev_staging', got '${env.schema}'`
    );
  }
  if (!env.supabaseUrl) {
    throw new Error('[content-bucket] missing NEXT_PUBLIC_SUPABASE_URL');
  }
  if (!env.hasServerSecret) {
    throw new Error('[content-bucket] missing SUPABASE_SECRET_KEY');
  }
}

/** Sorted, lowercased MIME list for a stable drift comparison. */
function normalizeMimeTypes(value: string[] | null): string[] {
  return (value ?? []).map((mime) => mime.trim().toLowerCase()).sort();
}

/** Divergences between a live bucket and the desired configuration. */
export function bucketDrift(bucket: StorageBucketRow): string[] {
  const drift: string[] = [];
  if (bucket.public !== CONTENT_BUCKET_DEV_CONFIG.public) {
    drift.push(`public got=${bucket.public} exp=false`);
  }
  if (bucket.file_size_limit !== CONTENT_BUCKET_DEV_CONFIG.fileSizeLimit) {
    drift.push(
      `file_size_limit got=${bucket.file_size_limit} exp=${CONTENT_BUCKET_DEV_CONFIG.fileSizeLimit}`
    );
  }
  const got = normalizeMimeTypes(bucket.allowed_mime_types);
  const expected = normalizeMimeTypes([
    ...CONTENT_BUCKET_DEV_CONFIG.allowedMimeTypes,
  ]);
  if (got.join(',') !== expected.join(',')) {
    drift.push(
      `allowed_mime_types got=${JSON.stringify(bucket.allowed_mime_types)} exp=${JSON.stringify(
        CONTENT_BUCKET_DEV_CONFIG.allowedMimeTypes
      )}`
    );
  }
  return drift;
}

/**
 * Environment-gated entry point: validates the environment BEFORE touching the
 * Storage API, so a misconfigured environment can never reach a bucket call.
 */
export async function runContentBucketSetup(
  env: ContentBucketSetupEnv,
  storage: StorageBucketApi
): Promise<BucketSetupResult> {
  assertContentBucketSetupAllowed(env);
  return setupContentBucket(storage);
}

/**
 * Idempotently provisions the private dev content bucket.
 *
 * - absent  -> create with the exact desired configuration
 * - present, matching -> no call beyond the read (`already-correct`)
 * - present, drifted  -> converge with updateBucket (`updated`)
 *
 * It never deletes or recreates a bucket and never moves objects; `getBucket`
 * returning no data is the only path that triggers a create.
 */
export async function setupContentBucket(
  storage: StorageBucketApi
): Promise<BucketSetupResult> {
  const existing = await storage.getBucket(CONTENT_BUCKET_DEV);
  if (
    existing.error &&
    !existing.data &&
    !/not found/i.test(existing.error.message)
  ) {
    throw new Error(
      `[content-bucket] getBucket(${CONTENT_BUCKET_DEV}) failed: ${existing.error.message}`
    );
  }

  const desired = {
    public: CONTENT_BUCKET_DEV_CONFIG.public,
    fileSizeLimit: CONTENT_BUCKET_DEV_CONFIG.fileSizeLimit,
    allowedMimeTypes: [...CONTENT_BUCKET_DEV_CONFIG.allowedMimeTypes],
  };

  if (!existing.data) {
    const created = await storage.createBucket(CONTENT_BUCKET_DEV, desired);
    if (created.error) {
      throw new Error(
        `[content-bucket] createBucket(${CONTENT_BUCKET_DEV}) failed: ${created.error.message}`
      );
    }
    return {
      status: 'created',
      bucket: CONTENT_BUCKET_DEV,
      changes: [],
      config: desired,
    };
  }

  const drift = bucketDrift(existing.data);
  if (drift.length === 0) {
    return {
      status: 'already-correct',
      bucket: CONTENT_BUCKET_DEV,
      changes: [],
      config: desired,
    };
  }

  const updated = await storage.updateBucket(CONTENT_BUCKET_DEV, desired);
  if (updated.error) {
    throw new Error(
      `[content-bucket] updateBucket(${CONTENT_BUCKET_DEV}) failed: ${updated.error.message}`
    );
  }
  return {
    status: 'updated',
    bucket: CONTENT_BUCKET_DEV,
    changes: drift,
    config: desired,
  };
}

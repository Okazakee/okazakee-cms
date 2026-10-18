/**
 * Phase 13 C3 — read-only production readiness probes.
 *
 * Before a production `--apply` may mutate anything, the operator's claims
 * about the deployed state must be checked against the live project. Every
 * probe here is READ-ONLY: selects, `getBucket`, and the CAS sentinel call
 * (`__probe__`, which the SQL refuses at its first validation branch, before
 * the write statement is reachable).
 *
 * What is verified, and what cannot be:
 *
 *   - `pointer-columns`: both content tables answer a projection that names
 *     `body_en_path` / `body_it_path`, and every committed pointer that comes
 *     back is canonical for its own entity/id/locale. A false
 *     `CMS_BODY_POINTER_COLUMNS` assertion fails right here. The four CHECK
 *     constraints themselves are NOT visible through PostgREST: they are
 *     verified by the reviewed artifact (`supabase/review/prod_markdown_backfill_cas.sql`,
 *     pinned by checksum) and its isolated PostgreSQL suite, and their effect is
 *     observed here through canonicality of the committed pointers.
 *   - `cas-forward` / `cas-rollback`: each atomic function exists with its exact
 *     signature and reaches its argument validation (`INVALID_ENTITY`). Until
 *     the artifact is promoted, both report `missing` and `--apply` refuses.
 *   - `cas-privileges`: the publishable (anon) path can NOT call either
 *     function. That is the reviewed GRANT block's effect (`revoke ... from
 *     public/anon/authenticated`, `grant execute ... to service_role`), and it is
 *     what keeps the administrative RPC off the public API.
 *   - `bucket-config`: `website-content` exists and is exactly private, 1 MiB,
 *     `text/markdown` — the same comparison the production setup command uses.
 *   - `storage-rls`: the publishable path enumerates no object in the private
 *     bucket, so hidden bodies are not listable.

 * A probe that cannot be performed (missing credential, transport failure,
 * unexpected error) is reported as NOT ready: an unproven claim is never
 * treated as a satisfied one.
 */
import {
  type CasRpcClient,
  probeCasReadiness,
} from '@/libs/cms/storage/backfillCas';
import { PROD_BACKFILL_ENVIRONMENT } from '@/libs/cms/storage/backfillEnvironment';
import type { PostBodyReader } from '@/libs/cms/storage/backfillPlan';
import { pointerHashFor } from '@/libs/cms/storage/backfillPlan';
import type {
  BodyContentKind,
  BodyContentLocale,
} from '@/libs/cms/storage/bodyContent';
import type { StorageBucketRow } from '@/utils/cms/prodStorageSetup';
import {
  PROD_CONTENT_BUCKET,
  prodBucketDrift,
} from '@/utils/cms/prodStorageSetup';

export type ReadinessCheckKey =
  | 'pointer-columns'
  | 'cas-forward'
  | 'cas-rollback'
  | 'cas-privileges'
  | 'bucket-config'
  | 'storage-rls';

export type ReadinessCheck = {
  key: ReadinessCheckKey;
  ok: boolean;
  detail: string;
};

export type ProdReadinessReport = {
  /** True only when every check passed. */
  ok: boolean;
  checks: ReadinessCheck[];
  /** One line per failed check, for the refusal message. */
  problems: string[];
};

/** Bucket read surface; `supabase.storage` satisfies it structurally. */
export type BucketConfigClient = {
  getBucket(id: string): Promise<{
    data: StorageBucketRow | null;
    error: { message: string } | null;
  }>;
};

/** Publishable-path Storage surface, narrowed to the read-only probe. */
export type AnonStorageClient = {
  from(bucket: string): {
    list(
      path: string
    ): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
  };
};

export type ProdReadinessDeps = {
  /** Reader projecting the pointer columns (manifest projection). */
  reader: PostBodyReader;
  /** Service-role RPC path, used for the sentinel probes. */
  casClient: CasRpcClient;
  /** Publishable-key RPC path, used to prove the anon call is refused. */
  anonCasClient: CasRpcClient;
  /** Service-role bucket metadata path. */
  buckets: BucketConfigClient;
  /** Publishable-key object path, used to prove the bucket is not enumerable. */
  anonStorage: AnonStorageClient;
};

/**
 * Confirms both content tables expose the pointer columns and that every
 * committed pointer is canonical for its own row and locale.
 */
async function checkPointerColumns(
  reader: PostBodyReader
): Promise<ReadinessCheck> {
  const key: ReadinessCheckKey = 'pointer-columns';
  let checked = 0;
  let observedRows = 0;
  try {
    const [blog, portfolio] = await Promise.all([
      reader.listPostBodies('blog'),
      reader.listPostBodies('portfolio'),
    ]);
    observedRows = blog.length + portfolio.length;
    for (const [kind, rows] of [
      ['blog', blog],
      ['portfolio', portfolio],
    ] as const) {
      for (const row of rows) {
        for (const locale of ['en', 'it'] as BodyContentLocale[]) {
          const path = locale === 'en' ? row.body_en_path : row.body_it_path;
          if (path === null) continue;
          checked += 1;
          if (
            pointerHashFor(kind as BodyContentKind, row.id, locale, path) ===
            null
          ) {
            return {
              key,
              ok: false,
              detail: `${kind} ${row.id} ${locale}: pointer '${path}' is not a canonical ${kind}/${row.id}/${locale}/<sha256>.md key`,
            };
          }
        }
      }
    }
  } catch (error) {
    return {
      key,
      ok: false,
      detail: `could not read the pointer columns: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    key,
    ok: true,
    detail: `4 pointer columns read from ${observedRows} rows; ${checked} committed pointer(s), all canonical`,
  };
}

/** The CAS sentinel probes, for both functions, through the service-role path. */
async function checkCasSignatures(
  client: CasRpcClient
): Promise<ReadinessCheck[]> {
  const [forward, rollback] = await Promise.all([
    probeCasReadiness(client, PROD_BACKFILL_ENVIRONMENT, 'forward'),
    probeCasReadiness(client, PROD_BACKFILL_ENVIRONMENT, 'rollback'),
  ]);
  const describe = (role: 'forward' | 'rollback', result: typeof forward) => {
    const fn =
      role === 'forward'
        ? PROD_BACKFILL_ENVIRONMENT.cas.forward
        : PROD_BACKFILL_ENVIRONMENT.cas.rollback;
    if (result.state === 'ready') {
      return {
        ok: true,
        detail: `${fn} answered its refusal probe (INVALID_ENTITY)`,
      };
    }
    return {
      ok: false,
      detail: `${fn} is not usable (${result.state}): ${result.detail}`,
    };
  };
  const forwardCheck = describe('forward', forward);
  const rollbackCheck = describe('rollback', rollback);
  return [
    { key: 'cas-forward', ...forwardCheck },
    { key: 'cas-rollback', ...rollbackCheck },
  ];
}

/**
 * Proves the publishable (anon) path cannot call either CAS function: an
 * accepted call would mean the reviewed GRANT block is not in effect and the
 * pointer switch is exposed to the public API.
 */
async function checkCasPrivileges(
  anonClient: CasRpcClient
): Promise<ReadinessCheck> {
  const key: ReadinessCheckKey = 'cas-privileges';
  for (const role of ['forward', 'rollback'] as const) {
    const fn =
      role === 'forward'
        ? PROD_BACKFILL_ENVIRONMENT.cas.forward
        : PROD_BACKFILL_ENVIRONMENT.cas.rollback;
    let callable = false;
    let detail = '';
    try {
      const probe = await anonClient.rpc(fn, { p_kind: '__probe__' });
      callable = !probe.error;
      detail = probe.error ? probe.error.message : 'the call was accepted';
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      callable = false;
    }
    if (callable) {
      return {
        key,
        ok: false,
        detail: `${fn} is callable through the publishable path (${detail}); the reviewed EXECUTE grants are not in effect`,
      };
    }
  }
  return {
    key,
    ok: true,
    detail: 'both CAS functions are refused on the publishable path',
  };
}

/** The private bucket exists with exactly the required configuration. */
async function checkBucketConfig(
  buckets: BucketConfigClient
): Promise<ReadinessCheck> {
  const key: ReadinessCheckKey = 'bucket-config';
  const observed = await buckets.getBucket(PROD_CONTENT_BUCKET);
  if (observed.error && !observed.data) {
    return {
      key,
      ok: false,
      detail: `getBucket(${PROD_CONTENT_BUCKET}) failed: ${observed.error.message}`,
    };
  }
  if (!observed.data) {
    return {
      key,
      ok: false,
      detail: `${PROD_CONTENT_BUCKET} does not exist`,
    };
  }
  const drift = prodBucketDrift(observed.data);
  return drift.length === 0
    ? {
        key,
        ok: true,
        detail: `${PROD_CONTENT_BUCKET} is private, 1 MiB, text/markdown`,
      }
    : {
        key,
        ok: false,
        detail: `${PROD_CONTENT_BUCKET} configuration drifted: ${drift.join('; ')}`,
      };
}

/**
 * The publishable path must not be able to enumerate the private bucket.
 *
 * `[]` is the expected answer (RLS filters every row), so the check does not
 * depend on which objects exist. An explicit permission error is also proof of
 * isolation; any other error is reported, because an unperformed probe is not a
 * satisfied one.
 */
async function checkStorageIsolation(
  anonStorage: AnonStorageClient
): Promise<ReadinessCheck> {
  const key: ReadinessCheckKey = 'storage-rls';
  let result: { data: unknown[] | null; error: { message: string } | null };
  try {
    result = await anonStorage.from(PROD_CONTENT_BUCKET).list('');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /permission|denied|401|403|42501/i.test(message)
      ? {
          key,
          ok: true,
          detail: `the publishable path was refused: ${message}`,
        }
      : {
          key,
          ok: false,
          detail: `the bucket could not be probed: ${message}`,
        };
  }
  if (result.error) {
    return /permission|denied|401|403|42501/i.test(result.error.message)
      ? {
          key,
          ok: true,
          detail: `the publishable path was refused: ${result.error.message}`,
        }
      : {
          key,
          ok: false,
          detail: `the bucket could not be probed: ${result.error.message}`,
        };
  }
  const objects = result.data ?? [];
  return objects.length === 0
    ? {
        key,
        ok: true,
        detail:
          'the publishable path enumerates no object in the private bucket',
      }
    : {
        key,
        ok: false,
        detail: `the publishable path enumerated ${objects.length} object(s); the private bucket is not isolated`,
      };
}

/**
 * Runs every readiness probe and reports them independently: the caller may
 * print all of them even when one fails, and `ok` is true only when none did.
 */
export async function collectProdBackfillReadiness(
  deps: ProdReadinessDeps
): Promise<ProdReadinessReport> {
  const checks: ReadinessCheck[] = [];
  checks.push(await checkPointerColumns(deps.reader));
  checks.push(...(await checkCasSignatures(deps.casClient)));
  checks.push(await checkCasPrivileges(deps.anonCasClient));
  checks.push(await checkBucketConfig(deps.buckets));
  checks.push(await checkStorageIsolation(deps.anonStorage));
  const problems = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.key}: ${check.detail}`);
  return { ok: problems.length === 0, checks, problems };
}

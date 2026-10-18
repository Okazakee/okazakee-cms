import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POINTER_COLUMNS_FLAG } from '@/libs/cms/bodyDualWrite';
import { manifestDigest } from '@/libs/cms/storage/backfillApply';
import {
  CAS_PROBE_ENTITY,
  type CasRpcClient,
} from '@/libs/cms/storage/backfillCas';
import {
  type BackfillObservedEnvironment,
  PROD_BACKFILL_ENVIRONMENT,
} from '@/libs/cms/storage/backfillEnvironment';
import type {
  JournalFsApi,
  JournalIntent,
  JournalManifest,
  JournalOutcome,
  JournalRecord,
} from '@/libs/cms/storage/backfillJournal';
import {
  buildBackfillPlan,
  type PostBodyReader,
  type PostBodyRow,
} from '@/libs/cms/storage/backfillPlan';
import {
  type BodyContentStorageApi,
  bodyContentPath,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import { PROD_FORBIDDEN_ROOTS_ENV } from '@/libs/cms/storage/prodBackfillGates';
import type {
  AnonStorageClient,
  BucketConfigClient,
} from '@/libs/cms/storage/prodBackfillReadiness';
import {
  forbiddenRootsFromEnv,
  PROD_BACKFILL_EXEC_USAGE,
  type ProdBackfillExecDeps,
  runProdBackfillExec,
} from '@/utils/cms/prodBackfillExec';
import {
  type ProdBackfillRollbackDeps,
  runProdBackfillRollback,
} from '@/utils/cms/prodBackfillRollback';
import {
  PROD_CONTENT_BUCKET,
  type StorageBucketRow,
} from '@/utils/cms/prodStorageSetup';

/**
 * Production backfill CLI gate/exit-code suite.
 *
 * Everything is isolated: the in-process runners receive injected fakes (an
 * in-memory journal filesystem, a recording CAS/bucket/storage surface), so no
 * network, database or real Storage is ever touched. The spawned cases only
 * exercise states that are refused BEFORE any network call — a gate that failed
 * to fire would try to reach a project with `placeholder` credentials and
 * therefore return a different exit code.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const PROD_OBSERVED: BackfillObservedEnvironment = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: 'https://mtvwynyikouqzmhqespl.supabase.co',
  hasServerSecret: true,
};

const REPO_ROOTS = ['/srv/app'];
const TEMP_JOURNAL = '/var/lib/cms-backfill/prod/run.jsonl';
const REPO_JOURNAL = '/srv/app/data/journal.jsonl';
const PROJECT_REF = 'mtvwynyikouqzmhqespl';
const ORIGIN = 'https://cms.example.com';
const REVALIDATION_URL = `${ORIGIN}/api/internal/content-revalidate`;
const FIXED_NOW = new Date('2026-10-18T10:00:00.000Z');
const HEX64 = 'a'.repeat(64);

const BODY_EN = '# blog one EN\n\nünïcodé ✓\n';
const BODY_IT = '# blog one IT à\n\ncorpo\n';
const BODY_PORTFOLIO = '# portfolio two\n';
const BODY_CHANGED = '# completely different content\n';

type Rows = { blog?: PostBodyRow[]; portfolio?: PostBodyRow[] };

function row(
  id: number,
  en: string | null,
  it: string | null,
  enPath: string | null = null,
  itPath: string | null = null
): PostBodyRow {
  return {
    id,
    body_en: en,
    body_it: it,
    body_en_path: enPath,
    body_it_path: itPath,
  };
}

/** Two posts, each with one EN body and no committed pointer. */
function freshRows(): Rows {
  return {
    blog: [row(1, BODY_EN, null)],
    portfolio: [row(2, BODY_PORTFOLIO, null)],
  };
}

/** One post with both locales populated and no committed pointer. */
function singlePostRows(): Rows {
  return { blog: [row(1, BODY_EN, BODY_IT)], portfolio: [] };
}

function digestFor(rows: Rows): string {
  return manifestDigest(buildBackfillPlan(rows));
}

function prodEnv(journalPath: string): Record<string, string | undefined> {
  return {
    PROD_BACKFILL_JOURNAL_PATH: journalPath,
    CMS_PROD_BACKFILL_APPLY_ACK: 'yes-apply-to-production-backfill',
    CMS_PROD_REVALIDATION_ORIGINS: ORIGIN,
    WEBSITE_REVALIDATION_URL: REVALIDATION_URL,
    WEBSITE_REVALIDATION_SECRET: 's3cret',
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory fakes                                                             */
/* -------------------------------------------------------------------------- */

type MemFs = {
  fs: JournalFsApi;
  files: Map<string, { content: string; mode: number }>;
  calls: {
    mkdir: number;
    open: number;
    write: number;
    readFile: number;
    stat: number;
  };
  seed(path: string, content: string, mode?: number): void;
};

function memoryFs(): MemFs {
  const files = new Map<string, { content: string; mode: number }>();
  const calls = { mkdir: 0, open: 0, write: 0, readFile: 0, stat: 0 };
  const fs: JournalFsApi = {
    async mkdir() {
      calls.mkdir += 1;
    },
    async open(path, _flags, mode) {
      calls.open += 1;
      return {
        async write(data: Buffer) {
          calls.write += 1;
          const previous = files.get(path)?.content ?? '';
          files.set(path, {
            content: previous + data.toString('utf8'),
            mode: mode ?? 0o600,
          });
          return { bytesWritten: data.length };
        },
        async sync() {
          return undefined;
        },
        async close() {
          return undefined;
        },
      };
    },
    async readFile(path) {
      calls.readFile += 1;
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return file.content;
    },
    async stat(path) {
      calls.stat += 1;
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mode: file.mode };
    },
  };
  return {
    fs,
    files,
    calls,
    seed(path, content, mode = 0o600) {
      files.set(path, { content, mode });
    },
  };
}

type RpcCall = { fn: string; args: Record<string, unknown> };

function isProbe(call: RpcCall): boolean {
  return call.args.p_kind === CAS_PROBE_ENTITY;
}

/**
 * Service-role CAS RPC fake: the sentinel probes answer `INVALID_ENTITY` (like
 * the SQL), the forward call answers APPLIED, the rollback call answers
 * ROLLED_BACK, and every non-probe call moves the recorded pointer so the
 * re-reads the executor performs observe a real switch.
 */
function serviceCas(pointers: Map<string, string | null>): {
  client: CasRpcClient;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const spec = PROD_BACKFILL_ENVIRONMENT;
  const client: CasRpcClient = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (args.p_kind === CAS_PROBE_ENTITY) {
        return {
          data: [{ outcome: 'INVALID_ENTITY', reason: null }],
          error: null,
        };
      }
      const pointerKey = `${String(args.p_kind)}:${String(args.p_post_id)}:${String(args.p_locale)}`;
      if (fn === spec.cas.forward) {
        pointers.set(pointerKey, String(args.p_new_path));
        return { data: [{ outcome: 'APPLIED', reason: null }], error: null };
      }
      if (fn === spec.cas.rollback) {
        const previous = args.p_previous_path;
        pointers.set(
          pointerKey,
          previous === null || previous === undefined ? null : String(previous)
        );
        return {
          data: [{ outcome: 'ROLLED_BACK', reason: null }],
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  };
  return { client, calls };
}

function anonCas(callable: boolean): CasRpcClient {
  return {
    async rpc() {
      if (callable) {
        return {
          data: [{ outcome: 'INVALID_ENTITY', reason: null }],
          error: null,
        };
      }
      return {
        data: null,
        error: { message: 'permission denied for function' },
      };
    },
  };
}

function fakeStorage(): {
  api: BodyContentStorageApi;
  calls: { uploads: string[]; downloads: string[]; removes: string[] };
  objects: Map<string, Buffer>;
} {
  const objects = new Map<string, Buffer>();
  const calls = {
    uploads: [] as string[],
    downloads: [] as string[],
    removes: [] as string[],
  };
  const api: BodyContentStorageApi = {
    async upload(path, body) {
      calls.uploads.push(path);
      objects.set(path, Buffer.from(body));
      return { data: { path }, error: null };
    },
    async download(path) {
      calls.downloads.push(path);
      const found = objects.get(path);
      return found
        ? { data: found, error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
    async remove(paths) {
      calls.removes.push(...paths);
      return { data: null, error: null };
    },
  };
  return { api, calls, objects };
}

const CORRECT_BUCKET: StorageBucketRow = {
  id: PROD_CONTENT_BUCKET,
  name: PROD_CONTENT_BUCKET,
  public: false,
  file_size_limit: 1_048_576,
  allowed_mime_types: ['text/markdown'],
};

function bucketsClient(bucket: StorageBucketRow): BucketConfigClient {
  return {
    async getBucket() {
      return { data: bucket, error: null };
    },
  };
}

function anonStorageClient(): AnonStorageClient {
  return {
    from() {
      return {
        async list() {
          return { data: [], error: null };
        },
      };
    },
  };
}

function readerFor(rows: Rows): PostBodyReader {
  return {
    async listPostBodies(kind) {
      return rows[kind] ?? [];
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Exec harness                                                                */
/* -------------------------------------------------------------------------- */

type ExecOptions = {
  argv: string[];
  observed?: BackfillObservedEnvironment;
  env?: Record<string, string | undefined>;
  rows?: Rows;
  journalPath?: string;
  repositoryRoots?: string[];
  committed?: Map<string, string | null>;
  pointers?: Map<string, string | null>;
  anonCallable?: boolean;
  bucket?: StorageBucketRow;
  seed?: Array<{ path: string; content: string }>;
};

function execHarness(options: ExecOptions) {
  const journalPath = options.journalPath ?? TEMP_JOURNAL;
  const env: Record<string, string | undefined> = prodEnv(journalPath);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const mem = memoryFs();
  for (const entry of options.seed ?? []) mem.seed(entry.path, entry.content);
  const pointers = options.pointers ?? new Map<string, string | null>();
  const committed = options.committed ?? new Map<string, string | null>();
  const service = serviceCas(pointers);
  const storage = fakeStorage();
  const invalidations: Array<{ entity: string; ids: number[] }> = [];
  let openReaderCalls = 0;

  const deps: ProdBackfillExecDeps = {
    argv: options.argv,
    observed: options.observed ?? PROD_OBSERVED,
    env,
    fs: mem.fs,
    repositoryRoots: options.repositoryRoots ?? REPO_ROOTS,
    openReader(_mode, _schema) {
      openReaderCalls += 1;
      return readerFor(options.rows ?? {});
    },
    casClient: service.client,
    anonCasClient: anonCas(options.anonCallable ?? false),
    buckets: bucketsClient(options.bucket ?? CORRECT_BUCKET),
    anonStorage: anonStorageClient(),
    storage: storage.api,
    async readCommittedBody(kind, postId, locale) {
      return committed.get(`${kind}:${postId}:${locale}`) ?? null;
    },
    async readCommittedPointer(kind, postId, locale) {
      return pointers.get(`${kind}:${postId}:${locale}`) ?? null;
    },
    async invalidate(args) {
      invalidations.push({ entity: args.entity, ids: args.ids });
      return 'sent';
    },
    now: () => FIXED_NOW,
    newRunId: () => 'run-1',
  };

  return {
    deps,
    mem,
    service,
    storage,
    invalidations,
    pointers,
    committed,
    openReaderCalls: () => openReaderCalls,
  };
}

/* -------------------------------------------------------------------------- */
/* Rollback harness                                                            */
/* -------------------------------------------------------------------------- */

type RollbackOptions = {
  argv: string[];
  observed?: BackfillObservedEnvironment;
  env?: Record<string, string | undefined>;
  rows?: Rows;
  journalPath?: string;
  repositoryRoots?: string[];
  committed?: Map<string, string | null>;
  pointers?: Map<string, string | null>;
  seed?: Array<{ path: string; content: string }>;
};

function rollbackHarness(options: RollbackOptions) {
  const journalPath = options.journalPath ?? TEMP_JOURNAL;
  const env: Record<string, string | undefined> = prodEnv(journalPath);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const mem = memoryFs();
  for (const entry of options.seed ?? []) mem.seed(entry.path, entry.content);
  const pointers = options.pointers ?? new Map<string, string | null>();
  const committed = options.committed ?? new Map<string, string | null>();
  const service = serviceCas(pointers);
  const invalidations: Array<{ entity: string; ids: number[] }> = [];

  const deps: ProdBackfillRollbackDeps = {
    argv: options.argv,
    observed: options.observed ?? PROD_OBSERVED,
    env,
    fs: mem.fs,
    repositoryRoots: options.repositoryRoots ?? REPO_ROOTS,
    openReader(_mode, _schema) {
      return readerFor(options.rows ?? {});
    },
    casClient: service.client,
    anonCasClient: anonCas(false),
    buckets: bucketsClient(CORRECT_BUCKET),
    anonStorage: anonStorageClient(),
    async readCommittedBody(kind, postId, locale) {
      return committed.get(`${kind}:${postId}:${locale}`) ?? null;
    },
    async readCommittedPointer(kind, postId, locale) {
      return pointers.get(`${kind}:${postId}:${locale}`) ?? null;
    },
    async invalidate(args) {
      invalidations.push({ entity: args.entity, ids: args.ids });
      return 'sent';
    },
    now: () => FIXED_NOW,
  };

  return { deps, mem, service, invalidations, pointers, committed };
}

/* -------------------------------------------------------------------------- */
/* Healthy journal fixtures                                                    */
/* -------------------------------------------------------------------------- */

const HASH_EN = sha256Hex(Buffer.from(BODY_EN, 'utf8'));
const HASH_IT = sha256Hex(Buffer.from(BODY_IT, 'utf8'));
const PATH_EN = bodyContentPath('blog', 1, 'en', HASH_EN);
const PATH_IT = bodyContentPath('blog', 1, 'it', HASH_IT);

function healthyRollbackJournal(): string {
  const manifest: JournalManifest = {
    type: 'manifest',
    runId: 'run-1',
    manifestDigest: 'digest-1',
    entries: [
      {
        kind: 'blog',
        postId: 1,
        locale: 'en',
        sourceSha256: HASH_EN,
        sizeBytes: Buffer.byteLength(BODY_EN, 'utf8'),
        expectedPath: PATH_EN,
        previousPath: null,
      },
      {
        kind: 'blog',
        postId: 1,
        locale: 'it',
        sourceSha256: HASH_IT,
        sizeBytes: Buffer.byteLength(BODY_IT, 'utf8'),
        expectedPath: PATH_IT,
        previousPath: null,
      },
    ],
    at: FIXED_NOW.toISOString(),
  };
  const intent = (
    locale: 'en' | 'it',
    hash: string,
    path: string
  ): JournalIntent => ({
    type: 'intent',
    runId: 'run-1',
    manifestDigest: 'digest-1',
    kind: 'blog',
    postId: 1,
    locale,
    attempt: 1,
    previousPath: null,
    intendedPath: path,
    sourceSha256: hash,
    at: FIXED_NOW.toISOString(),
  });
  const outcome = (
    locale: 'en' | 'it',
    hash: string,
    path: string
  ): JournalOutcome => ({
    type: 'outcome',
    runId: 'run-1',
    manifestDigest: 'digest-1',
    kind: 'blog',
    postId: 1,
    locale,
    attempt: 1,
    previousPath: null,
    intendedPath: path,
    sourceSha256: hash,
    outcome: 'UPLOADED_AND_POINTED',
    upload: 'uploaded',
    cas: 'APPLIED',
    casReason: null,
    pointerVerified: true,
    pointerSwitched: true,
    objectCreatedByRun: true,
    revalidation: 'sent',
    detail: null,
    at: FIXED_NOW.toISOString(),
  });
  const records: JournalRecord[] = [
    manifest,
    intent('en', HASH_EN, PATH_EN),
    intent('it', HASH_IT, PATH_IT),
    outcome('en', HASH_EN, PATH_EN),
    outcome('it', HASH_IT, PATH_IT),
  ];
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function rollbackLiveState(): {
  pointers: Map<string, string | null>;
  committed: Map<string, string | null>;
} {
  return {
    pointers: new Map<string, string | null>([
      ['blog:1:en', PATH_EN],
      ['blog:1:it', PATH_IT],
    ]),
    committed: new Map<string, string | null>([
      ['blog:1:en', BODY_EN],
      ['blog:1:it', BODY_IT],
    ]),
  };
}

/** The `type` discriminator of every JSON line the journal file holds. */
function journalRecordTypes(text: string): string[] {
  const types: string[] = [];
  for (const line of text.trim().split('\n')) {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
      throw new Error('journal line is not a record');
    }
    types.push(String(parsed.type));
  }
  return types;
}
/* -------------------------------------------------------------------------- */
/* Part A.1 — runProdBackfillExec                                              */
/* -------------------------------------------------------------------------- */

describe('runProdBackfillExec: usage (exit 2)', () => {
  it('refuses an unknown flag with exit 2 and the usage text', async () => {
    const h = execHarness({ argv: ['--bogus'] });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain(PROD_BACKFILL_EXEC_USAGE);
  });

  it('refuses --apply without a run selection with exit 2', async () => {
    const h = execHarness({
      argv: [
        '--apply',
        `--confirm-digest=${HEX64}`,
        `--expect-project-ref=${PROJECT_REF}`,
      ],
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('run selection');
  });
});

describe('runProdBackfillExec: environment gate (exit 3)', () => {
  const cases: Array<[string, Partial<BackfillObservedEnvironment>]> = [
    ['wrong APP_ENV', { appEnv: 'development' }],
    ['wrong schema', { schema: 'dev_staging' }],
    [
      'wrong project URL',
      { supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co' },
    ],
    ['missing server secret', { hasServerSecret: false }],
  ];

  for (const [name, patch] of cases) {
    it(`refuses ${name} before the reader factory is called`, async () => {
      const h = execHarness({
        argv: ['--preflight'],
        observed: { ...PROD_OBSERVED, ...patch },
      });
      const outcome = await runProdBackfillExec(h.deps);
      expect(outcome.exitCode).toBe(3);
      expect(outcome.report).toBeNull();
      expect(h.openReaderCalls()).toBe(0);
      expect(h.service.calls).toHaveLength(0);
      expect(h.storage.calls.uploads).toHaveLength(0);
    });
  }
});

describe('runProdBackfillExec: apply gates (exit 5)', () => {
  const applyArgv = (ref = PROJECT_REF) => [
    '--apply',
    '--new-run',
    `--confirm-digest=${HEX64}`,
    `--expect-project-ref=${ref}`,
  ];

  function gatesEnv(
    overrides: Record<string, string | undefined>
  ): Record<string, string | undefined> {
    return { ...prodEnv(TEMP_JOURNAL), ...overrides };
  }

  it('refuses a missing production acknowledgement before any reader call', async () => {
    const h = execHarness({
      argv: applyArgv(),
      env: gatesEnv({ CMS_PROD_BACKFILL_APPLY_ACK: undefined }),
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('CMS_PROD_BACKFILL_APPLY_ACK');
    expect(h.openReaderCalls()).toBe(0);
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses a --expect-project-ref mismatch', async () => {
    const h = execHarness({ argv: applyArgv('someotherprojectrefxx') });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('--expect-project-ref');
    expect(h.openReaderCalls()).toBe(0);
  });

  it('refuses the DEV apply acknowledgement value', async () => {
    const h = execHarness({
      argv: applyArgv(),
      env: gatesEnv({
        CMS_PROD_BACKFILL_APPLY_ACK: 'yes-apply-to-dev-staging',
      }),
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('CMS_PROD_BACKFILL_APPLY_ACK');
    expect(h.openReaderCalls()).toBe(0);
  });

  it('refuses a journal inside the repository root', async () => {
    const h = execHarness({
      argv: applyArgv(),
      env: gatesEnv({ PROD_BACKFILL_JOURNAL_PATH: REPO_JOURNAL }),
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('outside the repository');
    expect(h.openReaderCalls()).toBe(0);
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses a missing revalidation origin allowlist', async () => {
    const h = execHarness({
      argv: applyArgv(),
      env: gatesEnv({ CMS_PROD_REVALIDATION_ORIGINS: undefined }),
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('CMS_PROD_REVALIDATION_ORIGINS');
    expect(h.openReaderCalls()).toBe(0);
  });

  it('refuses an unapproved revalidation origin', async () => {
    const h = execHarness({
      argv: applyArgv(),
      env: gatesEnv({
        CMS_PROD_REVALIDATION_ORIGINS: 'https://elsewhere.example.com',
      }),
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('is not in CMS_PROD_REVALIDATION_ORIGINS');
    expect(h.openReaderCalls()).toBe(0);
  });

  it('refuses a missing revalidation signing secret', async () => {
    const h = execHarness({
      argv: applyArgv(),
      env: gatesEnv({ WEBSITE_REVALIDATION_SECRET: undefined }),
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('WEBSITE_REVALIDATION_SECRET');
    expect(h.openReaderCalls()).toBe(0);
  });
});

describe('runProdBackfillExec: --preflight (read-only)', () => {
  it('reports a clean preflight with exit 0 and mutates nothing', async () => {
    const h = execHarness({
      argv: ['--preflight'],
      rows: freshRows(),
      journalPath: TEMP_JOURNAL,
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    const report = outcome.report;
    expect(report).not.toBeNull();
    expect(report?.mode).toBe('preflight');
    expect(report?.mutationsPerformed).toBe(0);
    expect(report?.applyArmed).toBe(false);
    expect(report?.ok).toBe(true);

    // No mutation of any kind: no upload/remove, no CAS pointer call (only the
    // two sentinel readiness probes), and the journal was never created.
    expect(h.storage.calls.uploads).toHaveLength(0);
    expect(h.storage.calls.removes).toHaveLength(0);
    const mutations = h.service.calls.filter((call) => !isProbe(call));
    expect(mutations).toHaveLength(0);
    expect(h.service.calls.filter(isProbe).length).toBeGreaterThan(0);
    expect(h.mem.calls.open).toBe(0);
    expect(h.mem.files.has(TEMP_JOURNAL)).toBe(false);
  });

  it('reports exit 1 (null error) when the manifest has a blocker', async () => {
    const blocked: Rows = {
      blog: [row(1, '', null, bodyContentPath('blog', 1, 'en', HEX64))],
      portfolio: [],
    };
    const h = execHarness({ argv: ['--preflight'], rows: blocked });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBeNull();
    expect(outcome.report?.ok).toBe(false);
    expect(h.storage.calls.uploads).toHaveLength(0);
  });

  it('reports exit 1 (null error) when a readiness probe fails', async () => {
    const h = execHarness({
      argv: ['--preflight'],
      rows: freshRows(),
      anonCallable: true,
    });
    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBeNull();
    expect(outcome.report?.ok).toBe(false);
    expect(h.storage.calls.uploads).toHaveLength(0);
  });
});

describe('runProdBackfillExec: --apply', () => {
  it('runs the shared executor and records the manifest before the first intent', async () => {
    const rows = singlePostRows();
    const committed = new Map<string, string | null>([
      ['blog:1:en', BODY_EN],
      ['blog:1:it', BODY_IT],
    ]);
    const h = execHarness({
      argv: [
        '--apply',
        '--new-run',
        `--confirm-digest=${digestFor(rows)}`,
        `--expect-project-ref=${PROJECT_REF}`,
      ],
      rows,
      committed,
    });

    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    expect(outcome.report?.mode).toBe('apply');

    // At least one pointer CAS call and one immutable upload happened.
    expect(
      h.service.calls.filter((call) => !isProbe(call)).length
    ).toBeGreaterThan(0);
    expect(h.storage.calls.uploads.length).toBeGreaterThan(0);

    // Exactly one signed invalidation, for the single post.
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [1] }]);

    // The journal records the immutable manifest BEFORE the first intent.
    const text = h.mem.files.get(TEMP_JOURNAL)?.content ?? '';
    const types = journalRecordTypes(text);
    expect(types[0]).toBe('manifest');
    expect(types.indexOf('manifest')).toBeLessThan(types.indexOf('intent'));
  });

  it('exits 1 on the first failure and attempts nothing further', async () => {
    const rows = freshRows();
    const committed = new Map<string, string | null>([
      // The first-planned entry no longer matches the manifest it was planned
      // from; fail-fast must stop there.
      ['blog:1:en', BODY_CHANGED],
      ['portfolio:2:en', BODY_PORTFOLIO],
    ]);
    const h = execHarness({
      argv: [
        '--apply',
        '--new-run',
        `--confirm-digest=${digestFor(rows)}`,
        `--expect-project-ref=${PROJECT_REF}`,
      ],
      rows,
      committed,
    });

    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(1);
    const report = outcome.report as {
      entries: Array<{ outcome: string }>;
      remaining: Array<{ postId: number }>;
      stopped: unknown;
    };
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].outcome).toBe('CAS_STALE');
    expect(report.remaining).toHaveLength(1);
    expect(report.stopped).not.toBeNull();
    // The failure happened before upload and before any invalidation.
    expect(h.storage.calls.uploads).toHaveLength(0);
    expect(h.invalidations).toHaveLength(0);
  });
});

describe('runProdBackfillExec: digest gates (exit 5, no mutations)', () => {
  it('refuses --apply --new-run when --confirm-digest is not the production manifest digest', async () => {
    const rows = freshRows();
    const wrongDigest = 'f'.repeat(64);
    expect(wrongDigest).not.toBe(digestFor(rows));
    const h = execHarness({
      argv: [
        '--apply',
        '--new-run',
        `--confirm-digest=${wrongDigest}`,
        `--expect-project-ref=${PROJECT_REF}`,
      ],
      rows,
    });

    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('current production manifest digest');
    expect(outcome.error).toContain(digestFor(rows));
    // Nothing mutated: no upload, no real CAS call, no invalidation, and no
    // immutable manifest was recorded.
    expect(h.storage.calls.uploads).toHaveLength(0);
    expect(h.service.calls.filter((call) => !isProbe(call))).toHaveLength(0);
    expect(h.invalidations).toHaveLength(0);
    expect(h.mem.files.has(TEMP_JOURNAL)).toBe(false);
  });

  it('refuses --apply --resume when --confirm-digest is the fresh plan digest, not the recorded one', async () => {
    const rows = freshRows();
    const recorded: JournalManifest = {
      type: 'manifest',
      runId: 'run-1',
      manifestDigest: 'b'.repeat(64),
      entries: [
        {
          kind: 'blog',
          postId: 1,
          locale: 'en',
          sourceSha256: HASH_EN,
          sizeBytes: Buffer.byteLength(BODY_EN, 'utf8'),
          expectedPath: PATH_EN,
          previousPath: null,
        },
      ],
      at: FIXED_NOW.toISOString(),
    };
    const seed = `${JSON.stringify(recorded)}\n`;
    const h = execHarness({
      argv: [
        '--apply',
        '--resume',
        `--confirm-digest=${digestFor(rows)}`,
        `--expect-project-ref=${PROJECT_REF}`,
      ],
      rows,
      seed: [{ path: TEMP_JOURNAL, content: seed }],
    });

    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('recorded execution manifest');
    expect(outcome.error).toContain('b'.repeat(64));
    expect(h.storage.calls.uploads).toHaveLength(0);
    expect(h.service.calls.filter((call) => !isProbe(call))).toHaveLength(0);
    expect(h.invalidations).toHaveLength(0);
    // The journal is unchanged: nothing was appended.
    expect(h.mem.files.get(TEMP_JOURNAL)?.content).toBe(seed);
  });
});

describe('runProdBackfillExec: the capability flag is only an assertion', () => {
  it('still refuses --apply when the readiness probes fail despite the flag', async () => {
    const rows = freshRows();
    const drifted: StorageBucketRow = { ...CORRECT_BUCKET, public: true };
    const h = execHarness({
      argv: [
        '--apply',
        '--new-run',
        `--confirm-digest=${digestFor(rows)}`,
        `--expect-project-ref=${PROJECT_REF}`,
      ],
      env: { [POINTER_COLUMNS_FLAG]: 'true' },
      rows,
      bucket: drifted,
    });

    const outcome = await runProdBackfillExec(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('production is not ready');
    expect(outcome.error).toContain('bucket-config');
    const report = outcome.report as {
      mutationsPerformed: number;
      readiness: { ok: boolean };
    } | null;
    expect(report?.mutationsPerformed).toBe(0);
    expect(report?.readiness.ok).toBe(false);
    // The declaration was present and did not substitute for the probes.
    expect(h.deps.env[POINTER_COLUMNS_FLAG]).toBe('true');
    expect(h.storage.calls.uploads).toHaveLength(0);
    expect(h.service.calls.filter((call) => !isProbe(call))).toHaveLength(0);
    expect(h.invalidations).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Part A.2 — runProdBackfillRollback                                          */
/* -------------------------------------------------------------------------- */

describe('runProdBackfillRollback: read-only plan', () => {
  it('reports READY candidates with exit 0 and mutates nothing', async () => {
    const live = rollbackLiveState();
    const h = rollbackHarness({
      argv: [],
      seed: [{ path: TEMP_JOURNAL, content: healthyRollbackJournal() }],
      pointers: live.pointers,
      committed: live.committed,
    });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    const report = outcome.report as {
      mode: string;
      mutationsPerformed: number;
      summary: { ready: number };
    } | null;
    expect(report?.mode).toBe('plan');
    expect(report?.mutationsPerformed).toBe(0);
    expect(report?.summary.ready).toBe(2);
    expect(h.service.calls).toHaveLength(0);
    expect(h.invalidations).toHaveLength(0);
  });
});

describe('runProdBackfillRollback: refusal paths', () => {
  it('refuses the wrong environment with exit 3', async () => {
    const h = rollbackHarness({
      argv: [],
      observed: { ...PROD_OBSERVED, appEnv: 'development' },
    });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.report).toBeNull();
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses a missing journal variable with exit 5', async () => {
    const env = prodEnv(TEMP_JOURNAL);
    env.PROD_BACKFILL_JOURNAL_PATH = undefined;
    const h = rollbackHarness({ argv: [], env });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('PROD_BACKFILL_JOURNAL_PATH');
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses --apply without the production rollback acknowledgement', async () => {
    const h = rollbackHarness({
      argv: ['--apply', `--expect-project-ref=${PROJECT_REF}`],
    });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('CMS_PROD_BACKFILL_ROLLBACK_ACK');
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses --apply with the DEV rollback acknowledgement value', async () => {
    const h = rollbackHarness({
      argv: ['--apply', `--expect-project-ref=${PROJECT_REF}`],
      env: { CMS_PROD_BACKFILL_ROLLBACK_ACK: 'yes-rollback-dev-staging' },
    });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('CMS_PROD_BACKFILL_ROLLBACK_ACK');
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses --apply with a project reference mismatch', async () => {
    const h = rollbackHarness({
      argv: ['--apply', '--expect-project-ref=someotherprojectrefxx'],
      env: {
        CMS_PROD_BACKFILL_ROLLBACK_ACK: 'yes-rollback-to-production-backfill',
      },
    });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('--expect-project-ref');
    expect(h.service.calls).toHaveLength(0);
  });

  it('refuses a journal inside the repository root', async () => {
    const h = rollbackHarness({
      argv: [],
      journalPath: REPO_JOURNAL,
    });
    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain('outside the repository');
    expect(h.service.calls).toHaveLength(0);
  });
});

describe('runProdBackfillRollback: --apply', () => {
  it('restores both locales and invalidates the post exactly once', async () => {
    const live = rollbackLiveState();
    const h = rollbackHarness({
      argv: ['--apply', `--expect-project-ref=${PROJECT_REF}`],
      env: {
        CMS_PROD_BACKFILL_ROLLBACK_ACK: 'yes-rollback-to-production-backfill',
      },
      rows: {
        blog: [row(1, BODY_EN, BODY_IT, PATH_EN, PATH_IT)],
        portfolio: [],
      },
      seed: [{ path: TEMP_JOURNAL, content: healthyRollbackJournal() }],
      pointers: live.pointers,
      committed: live.committed,
    });

    const outcome = await runProdBackfillRollback(h.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();

    // Two atomic rollback CAS calls (one per locale), then ONE invalidation.
    expect(h.service.calls.filter((call) => !isProbe(call))).toHaveLength(2);
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [1] }]);
    expect(h.pointers.get('blog:1:en')).toBeNull();
    expect(h.pointers.get('blog:1:it')).toBeNull();

    // The rollback and its signed invalidation are durably recorded.
    const text = h.mem.files.get(TEMP_JOURNAL)?.content ?? '';
    const types = journalRecordTypes(text);
    expect(types.filter((type) => type === 'rollback')).toHaveLength(2);
    expect(types.filter((type) => type === 'revalidation')).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Part A.3 — forbiddenRootsFromEnv                                            */
/* -------------------------------------------------------------------------- */

describe('forbiddenRootsFromEnv', () => {
  it('parses colon-separated roots, trimming and dropping empties', () => {
    expect(
      forbiddenRootsFromEnv({
        [PROD_FORBIDDEN_ROOTS_ENV]: '/a:/b : :/c/ :/srv/site',
      })
    ).toEqual(['/a', '/b', '/c/', '/srv/site']);
  });

  it('returns an empty list when unset or blank', () => {
    expect(forbiddenRootsFromEnv({})).toEqual([]);
    expect(forbiddenRootsFromEnv({ [PROD_FORBIDDEN_ROOTS_ENV]: '' })).toEqual(
      []
    );
    expect(
      forbiddenRootsFromEnv({ [PROD_FORBIDDEN_ROOTS_ENV]: ' : : ' })
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Part B — spawned CLI smoke tests                                            */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let spawnTmp = '';

beforeAll(async () => {
  spawnTmp = await mkdtemp(join(tmpdir(), 'cms-prod-backfill-cli-'));
});

afterAll(async () => {
  if (spawnTmp) await rm(spawnTmp, { recursive: true, force: true });
});

function spawnEnv(
  overrides: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_DB_SCHEMA: 'public',
    NEXT_PUBLIC_SUPABASE_URL: 'https://mtvwynyikouqzmhqespl.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'placeholder',
    SUPABASE_SECRET_KEY: 'placeholder',
    CMS_PROD_BACKFILL_FORBIDDEN_ROOTS: spawnTmp,
    ...overrides,
  };
  const result: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function runCli(args: string[], overrides: Record<string, string | undefined>) {
  return spawnSync('bun', args, {
    cwd: REPO_ROOT,
    env: spawnEnv(overrides),
    timeout: 30_000,
    encoding: 'utf8',
  });
}

const SPAWN_TIMEOUT = 40_000;

describe('spawned CLI: refuses before any network access', () => {
  it(
    'plan with APP_ENV=development exits 3',
    () => {
      const result = runCli(['run', 'storage:content:prod:backfill:plan'], {
        APP_ENV: 'development',
      });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('refusing');
    },
    SPAWN_TIMEOUT
  );

  it(
    'exec --preflight with APP_ENV=development exits 3',
    () => {
      const result = runCli(
        ['src/utils/cms/prodBackfillExec.ts', '--preflight'],
        { APP_ENV: 'development' }
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("APP_ENV must be exactly 'production'");
    },
    SPAWN_TIMEOUT
  );

  it(
    'exec --preflight with schema dev_staging exits 3',
    () => {
      const result = runCli(
        ['src/utils/cms/prodBackfillExec.ts', '--preflight'],
        { APP_ENV: 'production', NEXT_PUBLIC_SUPABASE_DB_SCHEMA: 'dev_staging' }
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("must be 'public'");
    },
    SPAWN_TIMEOUT
  );

  it(
    'exec --preflight with a wrong project ref exits 3 on the mismatch',
    () => {
      const result = runCli(
        ['src/utils/cms/prodBackfillExec.ts', '--preflight'],
        {
          APP_ENV: 'production',
          NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        }
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('project mismatch');
    },
    SPAWN_TIMEOUT
  );

  it(
    'exec --apply with the production tuple but no ack exits 5',
    () => {
      const result = runCli(
        [
          'src/utils/cms/prodBackfillExec.ts',
          '--apply',
          '--new-run',
          `--confirm-digest=${HEX64}`,
          `--expect-project-ref=${PROJECT_REF}`,
        ],
        { APP_ENV: 'production' }
      );
      expect(result.status).toBe(5);
      expect(result.stderr).toContain('CMS_PROD_BACKFILL_APPLY_ACK');
    },
    SPAWN_TIMEOUT
  );

  it(
    'exec --apply without a run selection exits 2',
    () => {
      const result = runCli(['src/utils/cms/prodBackfillExec.ts', '--apply'], {
        APP_ENV: 'production',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage:');
    },
    SPAWN_TIMEOUT
  );

  it(
    'rollback (read-only default) without a journal variable exits 5',
    () => {
      const result = runCli(['src/utils/cms/prodBackfillRollback.ts'], {
        APP_ENV: 'production',
      });
      expect(result.status).toBe(5);
      expect(result.stderr).toContain('PROD_BACKFILL_JOURNAL_PATH');
    },
    SPAWN_TIMEOUT
  );

  it(
    'rollback with an unknown flag exits 2',
    () => {
      const result = runCli(
        ['src/utils/cms/prodBackfillRollback.ts', '--bogus'],
        { APP_ENV: 'production' }
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown argument '--bogus'");
    },
    SPAWN_TIMEOUT
  );
});

import { describe, expect, it } from 'vitest';
import type { CasRpcClient } from '@/libs/cms/storage/backfillCas';
import { PROD_BACKFILL_ENVIRONMENT } from '@/libs/cms/storage/backfillEnvironment';
import type {
  PostBodyReader,
  PostBodyRow,
} from '@/libs/cms/storage/backfillPlan';
import {
  type AnonStorageClient,
  type BucketConfigClient,
  collectProdBackfillReadiness,
  type ProdReadinessDeps,
  type ProdReadinessReport,
  type ReadinessCheck,
  type ReadinessCheckKey,
} from '@/libs/cms/storage/prodBackfillReadiness';
import {
  PROD_CONTENT_BUCKET,
  type StorageBucketRow,
} from '@/utils/cms/prodStorageSetup';

/**
 * Readiness-probe tests. Every dependency is injected, so the whole report is
 * produced without a network, a database or Storage, and every claim is checked
 * against returned report fields plus what the fakes recorded. The fixture rows
 * are synthetic; no real content is used.
 */

const HASH_EN = 'a'.repeat(64);
const HASH_IT = 'b'.repeat(64);

const POINTER_FN = PROD_BACKFILL_ENVIRONMENT.cas.forward;
const ROLLBACK_FN = PROD_BACKFILL_ENVIRONMENT.cas.rollback;

const GREEN_BUCKET: StorageBucketRow = {
  id: PROD_CONTENT_BUCKET,
  name: PROD_CONTENT_BUCKET,
  public: false,
  file_size_limit: 1_048_576,
  allowed_mime_types: ['text/markdown'],
};

const CHECK_KEYS: ReadinessCheckKey[] = [
  'pointer-columns',
  'cas-forward',
  'cas-rollback',
  'cas-privileges',
  'bucket-config',
  'storage-rls',
];

type RpcReply = { data: unknown; error: { message: string } | null };
type RpcHandler = (fn: string, args: Record<string, unknown>) => RpcReply;

type RecordingCasClient = {
  client: CasRpcClient;
  calls: string[];
  args: Record<string, unknown>[];
};

function fakeCasClient(handler: RpcHandler): RecordingCasClient {
  const calls: string[] = [];
  const args: Record<string, unknown>[] = [];
  return {
    calls,
    args,
    client: {
      async rpc(fn, rpcArgs) {
        calls.push(fn);
        args.push(rpcArgs);
        return handler(fn, rpcArgs);
      },
    },
  };
}

/** Service-role sentinel answer: the SQL refuses at its first branch. */
const serviceGreen: RpcHandler = () => ({
  data: [{ outcome: 'INVALID_ENTITY', reason: null }],
  error: null,
});

/** Publishable path: the reviewed GRANT block makes the call fail. */
const anonRefused: RpcHandler = (fn) => ({
  data: null,
  error: { message: `permission denied for function ${fn} (42501)` },
});

type RowSpec = {
  id: number;
  body_en?: string | null;
  body_it?: string | null;
  body_en_path?: string | null;
  body_it_path?: string | null;
};

function row(spec: RowSpec): PostBodyRow {
  return {
    id: spec.id,
    body_en: spec.body_en ?? null,
    body_it: spec.body_it ?? null,
    body_en_path: spec.body_en_path ?? null,
    body_it_path: spec.body_it_path ?? null,
  };
}

function pointer(
  kind: 'blog' | 'portfolio',
  id: number,
  locale: 'en' | 'it',
  hash: string
): string {
  return `${kind}/${id}/${locale}/${hash}.md`;
}

function fakeReader(
  fixture: {
    blog?: PostBodyRow[];
    portfolio?: PostBodyRow[];
    failWith?: string;
  } = {}
): PostBodyReader {
  return {
    async listPostBodies(kind) {
      if (fixture.failWith) throw new Error(fixture.failWith);
      return (kind === 'blog' ? fixture.blog : fixture.portfolio) ?? [];
    },
  };
}

function greenReader(): PostBodyReader {
  return fakeReader({
    blog: [
      row({
        id: 1,
        body_en: '# blog 1 EN',
        body_en_path: pointer('blog', 1, 'en', HASH_EN),
      }),
      row({ id: 2 }),
    ],
    portfolio: [
      row({
        id: 7,
        body_it: '# portfolio 7 IT',
        body_it_path: pointer('portfolio', 7, 'it', HASH_IT),
      }),
    ],
  });
}

function fakeBuckets(
  data: StorageBucketRow | null,
  error: { message: string } | null = null
): { client: BucketConfigClient; ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    client: {
      async getBucket(id) {
        ids.push(id);
        return { data, error };
      },
    },
  };
}

type StorageReply = {
  data: unknown[] | null;
  error: { message: string } | null;
};

function fakeAnonStorage(reply: StorageReply | { throws: string }): {
  client: AnonStorageClient;
  buckets: string[];
  paths: string[];
} {
  const buckets: string[] = [];
  const paths: string[] = [];
  return {
    buckets,
    paths,
    client: {
      from(bucket) {
        buckets.push(bucket);
        return {
          async list(path) {
            paths.push(path);
            if ('throws' in reply) throw new Error(reply.throws);
            return reply;
          },
        };
      },
    },
  };
}

/** All-green dependency set; each test overrides exactly what it exercises. */
async function run(
  overrides: Partial<ProdReadinessDeps> = {}
): Promise<ProdReadinessReport> {
  return collectProdBackfillReadiness({
    reader: greenReader(),
    casClient: fakeCasClient(serviceGreen).client,
    anonCasClient: fakeCasClient(anonRefused).client,
    buckets: fakeBuckets(GREEN_BUCKET).client,
    anonStorage: fakeAnonStorage({ data: [], error: null }).client,
    ...overrides,
  });
}

function check(
  report: ProdReadinessReport,
  key: ReadinessCheckKey
): ReadinessCheck {
  const found = report.checks.find((entry) => entry.key === key);
  if (!found) throw new Error(`readiness report is missing check '${key}'`);
  return found;
}

describe('collectProdBackfillReadiness', () => {
  it('reports ok with all six checks in order and no problems', async () => {
    const service = fakeCasClient(serviceGreen);
    const anon = fakeCasClient(anonRefused);
    const buckets = fakeBuckets(GREEN_BUCKET);
    const anonStorage = fakeAnonStorage({ data: [], error: null });

    const report = await collectProdBackfillReadiness({
      reader: greenReader(),
      casClient: service.client,
      anonCasClient: anon.client,
      buckets: buckets.client,
      anonStorage: anonStorage.client,
    });

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.checks.map((entry) => entry.key)).toEqual(CHECK_KEYS);
    expect(report.checks.every((entry) => entry.ok)).toBe(true);
    expect(check(report, 'pointer-columns').detail).toBe(
      '4 pointer columns read from 3 rows; 2 committed pointer(s), all canonical'
    );
    expect(check(report, 'cas-forward').detail).toContain(POINTER_FN);
    expect(check(report, 'cas-rollback').detail).toContain(ROLLBACK_FN);
    expect(check(report, 'cas-privileges').detail).toBe(
      'both CAS functions are refused on the publishable path'
    );
    expect(check(report, 'bucket-config').detail).toContain(
      `${PROD_CONTENT_BUCKET} is private, 1 MiB, text/markdown`
    );
    expect(check(report, 'storage-rls').detail).toBe(
      'the publishable path enumerates no object in the private bucket'
    );

    // The sentinel call is made for both functions, through the given client.
    expect(service.calls).toEqual([POINTER_FN, ROLLBACK_FN]);
    expect(service.args.map((args) => args.p_kind)).toEqual([
      '__probe__',
      '__probe__',
    ]);
    expect(anon.calls).toEqual([POINTER_FN, ROLLBACK_FN]);
    expect(buckets.ids).toEqual([PROD_CONTENT_BUCKET]);
    expect(anonStorage.buckets).toEqual([PROD_CONTENT_BUCKET]);
    expect(anonStorage.paths).toEqual(['']);
  });

  describe('pointer-columns', () => {
    it('fails when the pointer projection cannot be read', async () => {
      const message = 'column posts.body_en_path does not exist';
      const report = await run({ reader: fakeReader({ failWith: message }) });

      const entry = check(report, 'pointer-columns');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `could not read the pointer columns: ${message}`
      );
      expect(report.ok).toBe(false);
      expect(report.problems).toEqual([`pointer-columns: ${entry.detail}`]);
      expect(report.checks.filter((candidate) => !candidate.ok)).toHaveLength(
        1
      );
      expect(check(report, 'cas-forward').ok).toBe(true);
    });

    it('fails on a non-canonical committed pointer and names the path', async () => {
      const bad = 'blog/1/en/notahash.md';
      const report = await run({
        reader: fakeReader({
          blog: [row({ id: 1, body_en: '# blog 1 EN', body_en_path: bad })],
        }),
      });

      const entry = check(report, 'pointer-columns');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `blog 1 en: pointer '${bad}' is not a canonical blog/1/en/<sha256>.md key`
      );
      expect(report.ok).toBe(false);
      expect(report.problems).toEqual([`pointer-columns: ${entry.detail}`]);
      expect(check(report, 'bucket-config').ok).toBe(true);
    });

    it('fails on a pointer belonging to another id', async () => {
      const foreign = pointer('blog', 2, 'en', HASH_EN);
      const report = await run({
        reader: fakeReader({
          blog: [row({ id: 1, body_en: '# blog 1 EN', body_en_path: foreign })],
        }),
      });

      const entry = check(report, 'pointer-columns');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `blog 1 en: pointer '${foreign}' is not a canonical blog/1/en/<sha256>.md key`
      );
      expect(report.problems).toHaveLength(1);
    });

    it('fails on a pointer belonging to another locale', async () => {
      const foreign = pointer('portfolio', 7, 'en', HASH_IT);
      const report = await run({
        reader: fakeReader({
          portfolio: [
            row({ id: 7, body_it: '# portfolio 7 IT', body_it_path: foreign }),
          ],
        }),
      });

      const entry = check(report, 'pointer-columns');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `portfolio 7 it: pointer '${foreign}' is not a canonical portfolio/7/it/<sha256>.md key`
      );
      expect(report.problems).toHaveLength(1);
    });
  });

  describe('cas signatures', () => {
    it('fails cas-forward on a Postgrest error naming the function', async () => {
      const message =
        'Could not find the function public.prod_backfill_body_pointer_cas(p_kind) in the schema cache';
      const service = fakeCasClient((fn) =>
        fn === POINTER_FN
          ? { data: null, error: { message } }
          : { data: [{ outcome: 'INVALID_ENTITY', reason: null }], error: null }
      );

      const report = await run({ casClient: service.client });

      const forward = check(report, 'cas-forward');
      expect(forward.ok).toBe(false);
      expect(forward.detail).toBe(
        `${POINTER_FN} is not usable (missing): ${message}`
      );
      expect(check(report, 'cas-rollback').ok).toBe(true);
      expect(report.problems).toEqual([`cas-forward: ${forward.detail}`]);
    });

    it('fails cas-forward on an unexpected outcome', async () => {
      const service = fakeCasClient((fn) =>
        fn === POINTER_FN
          ? { data: [{ outcome: 'APPLIED', reason: null }], error: null }
          : { data: [{ outcome: 'INVALID_ENTITY', reason: null }], error: null }
      );

      const report = await run({ casClient: service.client });

      const forward = check(report, 'cas-forward');
      expect(forward.ok).toBe(false);
      expect(forward.detail).toBe(
        `${POINTER_FN} is not usable (unexpected): probe returned APPLIED`
      );
      expect(check(report, 'cas-rollback').ok).toBe(true);
      expect(report.problems).toEqual([`cas-forward: ${forward.detail}`]);
      expect(report.ok).toBe(false);
    });

    it('fails only cas-rollback when that probe fails', async () => {
      const message = 'network unreachable while calling rollback';
      const service = fakeCasClient((fn) => {
        if (fn === ROLLBACK_FN) throw new Error(message);
        return {
          data: [{ outcome: 'INVALID_ENTITY', reason: null }],
          error: null,
        };
      });

      const report = await run({ casClient: service.client });

      expect(check(report, 'cas-forward').ok).toBe(true);
      const rollback = check(report, 'cas-rollback');
      expect(rollback.ok).toBe(false);
      expect(rollback.detail).toBe(
        `${ROLLBACK_FN} is not usable (missing): ${message}`
      );
      expect(report.problems).toEqual([`cas-rollback: ${rollback.detail}`]);
    });
  });

  describe('cas privileges', () => {
    it('fails when the publishable path can call a CAS function', async () => {
      const anon = fakeCasClient(() => ({
        data: [{ outcome: 'INVALID_ENTITY', reason: null }],
        error: null,
      }));

      const report = await run({ anonCasClient: anon.client });

      const entry = check(report, 'cas-privileges');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `${POINTER_FN} is callable through the publishable path (the call was accepted); the reviewed EXECUTE grants are not in effect`
      );
      // The probe stops at the first callable function.
      expect(anon.calls).toEqual([POINTER_FN]);
      expect(report.ok).toBe(false);
      expect(report.problems).toHaveLength(1);
    });

    it('passes when the publishable path throws for both functions', async () => {
      const anon = fakeCasClient((fn) => {
        throw new Error(`permission denied for function ${fn} (42501)`);
      });

      const report = await run({ anonCasClient: anon.client });

      const entry = check(report, 'cas-privileges');
      expect(entry.ok).toBe(true);
      expect(entry.detail).toBe(
        'both CAS functions are refused on the publishable path'
      );
      expect(anon.calls).toEqual([POINTER_FN, ROLLBACK_FN]);
      expect(report.ok).toBe(true);
      expect(report.problems).toEqual([]);
    });

    it('passes when both roles are refused, by error and by exception', async () => {
      const anon = fakeCasClient((fn) => {
        if (fn === ROLLBACK_FN) {
          throw new Error(`permission denied for function ${fn} (42501)`);
        }
        return {
          data: null,
          error: { message: `permission denied for function ${fn} (42501)` },
        };
      });

      const report = await run({ anonCasClient: anon.client });

      expect(check(report, 'cas-privileges').ok).toBe(true);
      expect(anon.calls).toEqual([POINTER_FN, ROLLBACK_FN]);
      expect(report.problems).toEqual([]);
    });
  });

  describe('bucket config', () => {
    it('fails when getBucket returns no data and no error', async () => {
      const report = await run({ buckets: fakeBuckets(null).client });

      const entry = check(report, 'bucket-config');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(`${PROD_CONTENT_BUCKET} does not exist`);
      expect(report.problems).toEqual([`bucket-config: ${entry.detail}`]);
    });

    it('fails when getBucket reports a not-found error', async () => {
      const buckets = fakeBuckets(null, { message: 'Bucket not found' });

      const report = await run({ buckets: buckets.client });

      const entry = check(report, 'bucket-config');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `getBucket(${PROD_CONTENT_BUCKET}) failed: Bucket not found`
      );
      expect(buckets.ids).toEqual([PROD_CONTENT_BUCKET]);
      expect(report.problems).toEqual([`bucket-config: ${entry.detail}`]);
    });

    const driftCases: {
      name: string;
      bucket: StorageBucketRow;
      drift: string;
    }[] = [
      {
        name: 'public bucket',
        bucket: { ...GREEN_BUCKET, public: true },
        drift: 'public got=true exp=false',
      },
      {
        name: 'size limit',
        bucket: { ...GREEN_BUCKET, file_size_limit: 2_097_152 },
        drift: 'file_size_limit got=2097152 exp=1048576',
      },
      {
        name: 'mime list',
        bucket: { ...GREEN_BUCKET, allowed_mime_types: ['text/plain'] },
        drift: 'allowed_mime_types got=["text/plain"] exp=["text/markdown"]',
      },
    ];

    it.each(driftCases)('fails on $name drift', async ({ bucket, drift }) => {
      const report = await run({ buckets: fakeBuckets(bucket).client });

      const entry = check(report, 'bucket-config');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        `${PROD_CONTENT_BUCKET} configuration drifted: ${drift}`
      );
      expect(report.problems).toEqual([`bucket-config: ${entry.detail}`]);
    });

    it('passes on the exact required configuration', async () => {
      const report = await run();

      const entry = check(report, 'bucket-config');
      expect(entry.ok).toBe(true);
      expect(entry.detail).toBe(
        `${PROD_CONTENT_BUCKET} is private, 1 MiB, text/markdown`
      );
      expect(report.ok).toBe(true);
    });
  });

  describe('storage isolation', () => {
    it('passes when the publishable path lists no object', async () => {
      const anonStorage = fakeAnonStorage({ data: [], error: null });

      const report = await run({ anonStorage: anonStorage.client });

      const entry = check(report, 'storage-rls');
      expect(entry.ok).toBe(true);
      expect(entry.detail).toBe(
        'the publishable path enumerates no object in the private bucket'
      );
      expect(anonStorage.buckets).toEqual([PROD_CONTENT_BUCKET]);
      expect(anonStorage.paths).toEqual(['']);
      expect(report.ok).toBe(true);
    });

    it('fails and names the count when an object is listed', async () => {
      const report = await run({
        anonStorage: fakeAnonStorage({
          data: [{ name: 'blog/1/en/leaked.md' }],
          error: null,
        }).client,
      });

      const entry = check(report, 'storage-rls');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        'the publishable path enumerated 1 object(s); the private bucket is not isolated'
      );
      expect(report.problems).toEqual([`storage-rls: ${entry.detail}`]);
    });

    const refusalMessages = [
      'permission denied for table objects',
      'new row violates row-level security policy (401)',
      'HTTP 403 Forbidden',
      'insufficient privilege (42501)',
    ];

    it.each(refusalMessages)(
      'treats "%s" as proof of isolation',
      async (message) => {
        const report = await run({
          anonStorage: fakeAnonStorage({
            data: null,
            error: { message },
          }).client,
        });

        const entry = check(report, 'storage-rls');
        expect(entry.ok).toBe(true);
        expect(entry.detail).toBe(
          `the publishable path was refused: ${message}`
        );
        expect(report.ok).toBe(true);
      }
    );

    it('fails on an error that does not prove isolation', async () => {
      const report = await run({
        anonStorage: fakeAnonStorage({
          data: null,
          error: { message: 'network unreachable' },
        }).client,
      });

      const entry = check(report, 'storage-rls');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        'the bucket could not be probed: network unreachable'
      );
      expect(report.problems).toEqual([`storage-rls: ${entry.detail}`]);
    });

    it('treats a thrown permission error as proof of isolation', async () => {
      const report = await run({
        anonStorage: fakeAnonStorage({
          throws: 'permission denied for function list_objects (42501)',
        }).client,
      });

      const entry = check(report, 'storage-rls');
      expect(entry.ok).toBe(true);
      expect(entry.detail).toBe(
        'the publishable path was refused: permission denied for function list_objects (42501)'
      );
      expect(report.ok).toBe(true);
    });

    it('fails when the probe throws a non-permission error', async () => {
      const report = await run({
        anonStorage: fakeAnonStorage({ throws: 'socket hang up' }).client,
      });

      const entry = check(report, 'storage-rls');
      expect(entry.ok).toBe(false);
      expect(entry.detail).toBe(
        'the bucket could not be probed: socket hang up'
      );
      expect(report.ok).toBe(false);
    });
  });

  it('reports one problem line per failed check and keeps the passing ones', async () => {
    const report = await run({
      reader: fakeReader({
        failWith: 'column posts.body_en_path does not exist',
      }),
      casClient: fakeCasClient((fn) =>
        fn === POINTER_FN
          ? { data: [{ outcome: 'APPLIED', reason: null }], error: null }
          : { data: [{ outcome: 'INVALID_ENTITY', reason: null }], error: null }
      ).client,
      anonCasClient: fakeCasClient(() => ({
        data: [{ outcome: 'INVALID_ENTITY', reason: null }],
        error: null,
      })).client,
      buckets: fakeBuckets(null).client,
      anonStorage: fakeAnonStorage({
        data: [{ name: 'leaked.md' }],
        error: null,
      }).client,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(6);
    expect(report.problems.map((line) => line.split(':')[0])).toEqual([
      'pointer-columns',
      'cas-forward',
      'cas-privileges',
      'bucket-config',
      'storage-rls',
    ]);
    for (const entry of report.checks) {
      if (entry.ok) {
        expect(report.problems).not.toContain(`${entry.key}: ${entry.detail}`);
        continue;
      }
      expect(report.problems).toContain(`${entry.key}: ${entry.detail}`);
    }
    const passing = report.checks.filter((entry) => entry.ok);
    expect(passing.map((entry) => entry.key)).toEqual(['cas-rollback']);
  });
});

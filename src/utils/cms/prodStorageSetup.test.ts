import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPLY_ACK_ENV,
  APPLY_ACK_VALUE,
} from '@/libs/cms/storage/backfillApply';
import { EXPECTED_DEV_PROJECT_REF } from '@/libs/cms/storage/backfillPlan';
import {
  CONTENT_BUCKET_DEV,
  CONTENT_BUCKET_PROD,
} from '@/libs/cms/storage/contentBucket';
import {
  assertProdApplyAcknowledged,
  assertProdStorageSetupAllowed,
  EXPECTED_PROD_PROJECT_REF,
  isDirectInvocation,
  PROD_APPLY_ACK_ENV,
  PROD_APPLY_ACK_VALUE,
  PROD_CONTENT_BUCKET,
  PROD_CONTENT_BUCKET_CONFIG,
  PROD_STORAGE_SETUP_COMMAND,
  type ProdStorageBucketApi,
  type ProdStorageSetupEnv,
  parseProdSetupArgs,
  prodBucketDrift,
  readProdApplyAck,
  runProdStorageSetup,
  type StorageBucketOptions,
  type StorageBucketRow,
  type StorageError,
  unexpectedContentBuckets,
} from '@/utils/cms/prodStorageSetup';

/**
 * Unit tests for the production content-bucket provisioning command against an
 * injected fake Storage API — no network, no project, no mutation of anything
 * real. Proves: read-only by default, dual-gated apply, project-bound and
 * fail-closed environment gate, exact-configuration create, idempotency, drift
 * reporting without repair, and that `website-content-dev` and objects are
 * never reachable.
 */

type FakeCalls = {
  list: number;
  create: number;
  update: number;
  remove: number;
  idsSeen: string[];
  createdOptions: StorageBucketOptions | null;
};

/** The wider real-world Storage surface, so "never called" is provable. */
type FakeApi = ProdStorageBucketApi & {
  updateBucket(
    id: string,
    options: StorageBucketOptions
  ): Promise<{ data: unknown; error: StorageError | null }>;
  removeBucket(
    id: string
  ): Promise<{ data: unknown; error: StorageError | null }>;
};

function fakeStorage(
  initial: StorageBucketRow[],
  failures: { listError?: string; createError?: string } = {}
): {
  api: ProdStorageBucketApi;
  calls: FakeCalls;
  buckets: () => StorageBucketRow[];
} {
  const calls: FakeCalls = {
    list: 0,
    create: 0,
    update: 0,
    remove: 0,
    idsSeen: [],
    createdOptions: null,
  };
  let state = initial.map((bucket) => ({ ...bucket }));

  const api: FakeApi = {
    async listBuckets() {
      calls.list += 1;
      if (failures.listError) {
        return { data: null, error: { message: failures.listError } };
      }
      return { data: state, error: null };
    },
    async createBucket(id, options) {
      calls.create += 1;
      calls.idsSeen.push(id);
      calls.createdOptions = options;
      if (failures.createError) {
        return { data: null, error: { message: failures.createError } };
      }
      state = [
        ...state,
        {
          id,
          name: id,
          public: options.public,
          file_size_limit: options.fileSizeLimit,
          allowed_mime_types: options.allowedMimeTypes,
        },
      ];
      return { data: { name: id }, error: null };
    },
    async updateBucket(id, options) {
      calls.update += 1;
      calls.idsSeen.push(id);
      state = state.map((bucket) =>
        bucket.name === id
          ? {
              ...bucket,
              public: options.public,
              file_size_limit: options.fileSizeLimit,
              allowed_mime_types: options.allowedMimeTypes,
            }
          : bucket
      );
      return { data: { name: id }, error: null };
    },
    async removeBucket(id) {
      calls.remove += 1;
      calls.idsSeen.push(id);
      state = state.filter((bucket) => bucket.name !== id);
      return { data: { name: id }, error: null };
    },
  };

  return { api, calls, buckets: () => state };
}

function totalMutations(calls: FakeCalls): number {
  return calls.create + calls.update + calls.remove;
}

function correctBucket(): StorageBucketRow {
  return {
    id: PROD_CONTENT_BUCKET,
    name: PROD_CONTENT_BUCKET,
    public: false,
    file_size_limit: 1_048_576,
    allowed_mime_types: ['text/markdown'],
  };
}

function devBucket(): StorageBucketRow {
  return {
    id: CONTENT_BUCKET_DEV,
    name: CONTENT_BUCKET_DEV,
    public: false,
    file_size_limit: 1_048_576,
    allowed_mime_types: ['text/markdown'],
  };
}

const PROD_ENV: ProdStorageSetupEnv = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: `https://${EXPECTED_PROD_PROJECT_REF}.supabase.co`,
  hasServerSecret: true,
};

const INSPECT = { apply: false, ack: undefined };
const APPLY = { apply: true, ack: PROD_APPLY_ACK_VALUE };

describe('prod storage setup — inspection', () => {
  it('reports a missing bucket without creating it', async () => {
    const { api, calls } = fakeStorage([devBucket()]);

    const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);

    expect(result.status).toBe('missing');
    expect(result.ok).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls.list).toBe(1);
    expect(totalMutations(calls)).toBe(0);
  });

  it('reports an exactly matching bucket as already-correct', async () => {
    const { api, calls } = fakeStorage([correctBucket()]);

    const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);

    expect(result.status).toBe('already-correct');
    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
    expect(calls.list).toBe(1);
    expect(totalMutations(calls)).toBe(0);
  });

  it('treats differently shaped but equivalent values as no drift', async () => {
    const { api, calls } = fakeStorage([
      {
        ...correctBucket(),
        // Uppercase/whitespace in the MIME list is not drift.
        allowed_mime_types: [' TEXT/Markdown '],
      },
    ]);

    const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);

    expect(result.status).toBe('already-correct');
    expect(totalMutations(calls)).toBe(0);
  });

  it('reports every drifted field and never repairs it', async () => {
    const { api, calls, buckets } = fakeStorage([
      {
        ...correctBucket(),
        public: true,
        file_size_limit: 10_485_760,
        allowed_mime_types: ['text/markdown', 'image/png'],
      },
    ]);

    const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);

    expect(result.status).toBe('drifted');
    expect(result.ok).toBe(false);
    expect(result.drift.join(' | ')).toContain('public');
    expect(result.drift.join(' | ')).toContain('file_size_limit');
    expect(result.drift.join(' | ')).toContain('allowed_mime_types');
    expect(totalMutations(calls)).toBe(0);
    expect(buckets()[0].public).toBe(true);
  });

  it('reports an absent size limit and an absent MIME list as drift', async () => {
    const { api, calls } = fakeStorage([
      {
        id: PROD_CONTENT_BUCKET,
        name: PROD_CONTENT_BUCKET,
        public: false,
        file_size_limit: null,
        allowed_mime_types: null,
      },
    ]);

    const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);

    expect(result.status).toBe('drifted');
    expect(result.drift.join(' | ')).toContain('file_size_limit got=null');
    expect(result.drift.join(' | ')).toContain('allowed_mime_types got=null');
    expect(totalMutations(calls)).toBe(0);
  });

  it('performs no Storage mutation in read-only mode in any state', async () => {
    for (const initial of [
      [],
      [correctBucket()],
      [{ ...correctBucket(), public: true }],
    ]) {
      const { api, calls } = fakeStorage(initial);
      const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);
      expect(result.mutationsPerformed).toBe(0);
      expect(result.mutated).toBe(false);
      expect(totalMutations(calls)).toBe(0);
      expect(calls.list).toBe(1);
    }
  });

  it('reports unexpected content buckets without touching them', async () => {
    const stray: StorageBucketRow = {
      id: 'website-content-copy',
      name: 'website-content-copy',
      public: true,
      file_size_limit: null,
      allowed_mime_types: null,
    };
    const { api, calls, buckets } = fakeStorage([correctBucket(), stray]);

    const result = await runProdStorageSetup(PROD_ENV, api, INSPECT);

    expect(result.status).toBe('already-correct');
    expect(result.unexpectedBuckets).toEqual(['website-content-copy']);
    expect(result.observedBuckets).toEqual([
      'website-content',
      'website-content-copy',
    ]);
    expect(totalMutations(calls)).toBe(0);
    expect(buckets()).toContainEqual(stray);
  });

  it('does not flag the known dev sibling or unrelated buckets', () => {
    expect(
      unexpectedContentBuckets([
        'website-content',
        'website-content-dev',
        'website',
        'website-dev',
      ])
    ).toEqual([]);
    expect(unexpectedContentBuckets(['website-content-2'])).toEqual([
      'website-content-2',
    ]);
  });

  it('fails closed when the listing fails instead of assuming absence', async () => {
    const { api, calls } = fakeStorage([], { listError: 'permission denied' });

    await expect(runProdStorageSetup(PROD_ENV, api, APPLY)).rejects.toThrow(
      /listBuckets\(\) failed: permission denied/
    );
    expect(calls.create).toBe(0);
  });

  it('never addresses the dev bucket and leaves it untouched', async () => {
    const { api, calls, buckets } = fakeStorage([devBucket()]);

    const inspected = await runProdStorageSetup(PROD_ENV, api, INSPECT);
    expect(inspected.status).toBe('missing');
    expect(calls.idsSeen).toEqual([]);
    expect(totalMutations(calls)).toBe(0);

    const applied = await runProdStorageSetup(PROD_ENV, api, APPLY);
    expect(applied.status).toBe('created');
    expect(calls.idsSeen).toEqual([PROD_CONTENT_BUCKET]);
    expect(calls.idsSeen).not.toContain(CONTENT_BUCKET_DEV);
    expect(
      buckets().find((bucket) => bucket.name === CONTENT_BUCKET_DEV)
    ).toEqual(devBucket());
  });
});

describe('prod storage setup — apply', () => {
  it('creates a missing bucket with the exact required configuration', async () => {
    const { api, calls, buckets } = fakeStorage([devBucket()]);

    const result = await runProdStorageSetup(PROD_ENV, api, APPLY);

    expect(result.mode).toBe('apply');
    expect(result.status).toBe('created');
    expect(result.ok).toBe(true);
    expect(result.mutated).toBe(true);
    expect(result.mutationsPerformed).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.create).toBe(1);
    expect(calls.update).toBe(0);
    expect(calls.remove).toBe(0);
    expect(calls.createdOptions).toEqual({
      public: false,
      fileSizeLimit: 1_048_576,
      allowedMimeTypes: ['text/markdown'],
    });
    expect(calls.idsSeen).toEqual([PROD_CONTENT_BUCKET]);
    expect(buckets()).toHaveLength(2);
  });

  it('is idempotent when the bucket already matches exactly', async () => {
    const { api, calls } = fakeStorage([correctBucket()]);

    const result = await runProdStorageSetup(PROD_ENV, api, APPLY);

    expect(result.status).toBe('already-correct');
    expect(result.ok).toBe(true);
    expect(result.mutationsPerformed).toBe(0);
    expect(totalMutations(calls)).toBe(0);
  });

  it('reports a drifted bucket instead of rewriting it', async () => {
    const { api, calls, buckets } = fakeStorage([
      { ...correctBucket(), public: true, file_size_limit: 1 },
    ]);

    const result = await runProdStorageSetup(PROD_ENV, api, APPLY);

    expect(result.status).toBe('drifted');
    expect(result.ok).toBe(false);
    expect(result.mutationsPerformed).toBe(0);
    expect(totalMutations(calls)).toBe(0);
    expect(buckets()[0].public).toBe(true);
    expect(buckets()[0].file_size_limit).toBe(1);
  });

  it('refuses without the acknowledgement before any Storage call', async () => {
    for (const ack of [undefined, '', 'yes', APPLY_ACK_VALUE]) {
      const { api, calls } = fakeStorage([]);
      await expect(
        runProdStorageSetup(PROD_ENV, api, { apply: true, ack })
      ).rejects.toThrow(new RegExp(PROD_APPLY_ACK_ENV));
      expect(calls.list).toBe(0);
      expect(totalMutations(calls)).toBe(0);
    }
  });

  it('refuses the dev acknowledgement env var and value', () => {
    // The dev acknowledgement is a different variable holding a different
    // value, so neither can arm a production mutation.
    expect(APPLY_ACK_ENV).not.toBe(PROD_APPLY_ACK_ENV);
    expect(APPLY_ACK_VALUE).not.toBe(PROD_APPLY_ACK_VALUE);
    expect(readProdApplyAck({ [APPLY_ACK_ENV]: APPLY_ACK_VALUE })).toBe(
      undefined
    );
    expect(() => assertProdApplyAcknowledged(APPLY_ACK_VALUE)).toThrow(
      /refusing to mutate/
    );
    expect(() => assertProdApplyAcknowledged(undefined)).toThrow(
      /refusing to mutate/
    );
    expect(() =>
      assertProdApplyAcknowledged(PROD_APPLY_ACK_VALUE)
    ).not.toThrow();
  });

  it('surfaces a create failure instead of reporting success', async () => {
    const { api } = fakeStorage([], { createError: 'already exists' });

    await expect(runProdStorageSetup(PROD_ENV, api, APPLY)).rejects.toThrow(
      /createBucket\(website-content\) failed: already exists/
    );
  });

  it('is a no-op on import-style repeated apply once the bucket exists', async () => {
    const { api, calls } = fakeStorage([]);

    const first = await runProdStorageSetup(PROD_ENV, api, APPLY);
    const second = await runProdStorageSetup(PROD_ENV, api, APPLY);

    expect(first.status).toBe('created');
    expect(second.status).toBe('already-correct');
    expect(calls.create).toBe(1);
  });
});

describe('prod storage setup — environment gate', () => {
  it('accepts the production contract', () => {
    expect(() => assertProdStorageSetupAllowed(PROD_ENV)).not.toThrow();
  });

  it('refuses a non-production or unset environment before any Storage call', async () => {
    for (const appEnv of ['development', 'staging', 'preview', '']) {
      const { api, calls } = fakeStorage([]);
      await expect(
        runProdStorageSetup({ ...PROD_ENV, appEnv }, api, INSPECT)
      ).rejects.toThrow(/APP_ENV must be exactly 'production'/);
      expect(calls.list).toBe(0);
    }
  });

  it('refuses the dev_staging schema', async () => {
    const { api, calls } = fakeStorage([]);

    await expect(
      runProdStorageSetup({ ...PROD_ENV, schema: 'dev_staging' }, api, INSPECT)
    ).rejects.toThrow(/DB_SCHEMA must be 'public'/);
    expect(calls.list).toBe(0);
  });

  it('refuses a missing project URL', async () => {
    const { api, calls } = fakeStorage([]);

    await expect(
      runProdStorageSetup({ ...PROD_ENV, supabaseUrl: '' }, api, INSPECT)
    ).rejects.toThrow(/missing NEXT_PUBLIC_SUPABASE_URL/);
    expect(calls.list).toBe(0);
  });

  it('refuses a malformed or non-https project URL', async () => {
    for (const url of [
      'garbage',
      `http://${EXPECTED_PROD_PROJECT_REF}.supabase.co`,
      'https://example.com',
    ]) {
      const { api, calls } = fakeStorage([]);
      await expect(
        runProdStorageSetup({ ...PROD_ENV, supabaseUrl: url }, api, INSPECT)
      ).rejects.toThrow(/is not a usable https/);
      expect(calls.list).toBe(0);
    }
  });

  it('refuses a different project reference', async () => {
    const { api, calls } = fakeStorage([]);

    await expect(
      runProdStorageSetup(
        {
          ...PROD_ENV,
          supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
        },
        api,
        APPLY
      )
    ).rejects.toThrow(/project mismatch/);
    expect(calls.list).toBe(0);
    expect(totalMutations(calls)).toBe(0);
  });

  it('refuses a missing server secret', async () => {
    const { api, calls } = fakeStorage([]);

    await expect(
      runProdStorageSetup({ ...PROD_ENV, hasServerSecret: false }, api, APPLY)
    ).rejects.toThrow(/missing SUPABASE_SECRET_KEY/);
    expect(calls.list).toBe(0);
  });

  it('checks the environment before the acknowledgement', async () => {
    const { api } = fakeStorage([]);

    await expect(
      runProdStorageSetup({ ...PROD_ENV, appEnv: 'development' }, api, {
        apply: true,
        ack: undefined,
      })
    ).rejects.toThrow(/APP_ENV must be exactly 'production'/);
  });
});

describe('prod storage setup — CLI contract', () => {
  it('parses only the accepted argument forms', () => {
    expect(parseProdSetupArgs([])).toEqual({ mode: 'inspect' });
    expect(parseProdSetupArgs(['--apply'])).toEqual({ mode: 'apply' });
    expect(parseProdSetupArgs(['--help'])).toEqual({ mode: 'help' });
    expect(parseProdSetupArgs(['-h'])).toEqual({ mode: 'help' });
    expect(parseProdSetupArgs(['--apply', '--force']).mode).toBe('invalid');
    expect(parseProdSetupArgs(['--apply', '--yes']).mode).toBe('invalid');
    expect(parseProdSetupArgs(['--force']).mode).toBe('invalid');
    expect(parseProdSetupArgs(['apply']).mode).toBe('invalid');
  });

  it('detects direct invocation so importing the module runs nothing', () => {
    const moduleUrl = import.meta.url;
    expect(
      isDirectInvocation(
        [process.execPath, fileURLToPath(moduleUrl)],
        moduleUrl
      )
    ).toBe(true);
    expect(
      isDirectInvocation(
        [
          process.execPath,
          fileURLToPath(pathToFileURL(resolve('src/other.ts'))),
        ],
        moduleUrl
      )
    ).toBe(false);
    expect(isDirectInvocation([], moduleUrl)).toBe(false);
    expect(isDirectInvocation([process.execPath, 'x.ts'], 'not-a-url')).toBe(
      false
    );
    // The test runner is the entry point, never this module.
    expect(isDirectInvocation(process.argv, moduleUrl)).toBe(false);
  });

  it('reads the acknowledgement from its own variable only', () => {
    expect(
      readProdApplyAck({ [PROD_APPLY_ACK_ENV]: PROD_APPLY_ACK_VALUE })
    ).toBe(PROD_APPLY_ACK_VALUE);
    expect(readProdApplyAck({})).toBe(undefined);
    expect(readProdApplyAck({ [APPLY_ACK_ENV]: PROD_APPLY_ACK_VALUE })).toBe(
      undefined
    );
  });

  it('pins the bucket, the project and the required configuration', () => {
    expect(PROD_STORAGE_SETUP_COMMAND).toBe('storage:content:prod:setup');
    expect(PROD_CONTENT_BUCKET).toBe('website-content');
    expect(PROD_CONTENT_BUCKET).toBe(CONTENT_BUCKET_PROD);
    expect(PROD_CONTENT_BUCKET).not.toBe(CONTENT_BUCKET_DEV);
    expect(PROD_CONTENT_BUCKET_CONFIG).toEqual({
      public: false,
      fileSizeLimit: 1_048_576,
      allowedMimeTypes: ['text/markdown'],
    });
    expect(PROD_APPLY_ACK_ENV).toBe('CMS_PROD_STORAGE_APPLY_ACK');
    expect(PROD_APPLY_ACK_VALUE).toBe('yes-apply-to-production');
    expect(EXPECTED_PROD_PROJECT_REF).toBe('mtvwynyikouqzmhqespl');
    // Dev is the `dev_staging` schema inside the same project, so the dev
    // planner's reference must stay identical to the production one.
    expect(EXPECTED_PROD_PROJECT_REF).toBe(EXPECTED_DEV_PROJECT_REF);
  });

  it('reports drift for a bucket that is public and has extra limits', () => {
    expect(
      prodBucketDrift({
        id: PROD_CONTENT_BUCKET,
        name: PROD_CONTENT_BUCKET,
        public: true,
        file_size_limit: null,
        allowed_mime_types: ['text/markdown', 'image/png'],
      })
    ).toHaveLength(3);
  });
});

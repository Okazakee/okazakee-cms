import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertContentBucketSetupAllowed,
  CONTENT_BUCKET_DEV,
  CONTENT_BUCKET_PROD,
  type ContentBucketSetupEnv,
  currentContentBucket,
  resolveContentBucket,
  runContentBucketSetup,
  type StorageBucketApi,
  type StorageBucketRow,
  setupContentBucket,
} from '@/libs/cms/storage/contentBucket';

/**
 * Unit tests for the dev content-bucket provisioning logic against a fake
 * Storage admin API — no network, no project. Proves idempotency, exact
 * configuration convergence, and the fail-closed environment gate.
 */

type FakeCalls = {
  get: number;
  create: number;
  update: number;
  idsSeen: string[];
  createdOptions: unknown;
  updatedOptions: unknown;
};

function fakeStorage(initial: StorageBucketRow | null): {
  api: StorageBucketApi;
  calls: FakeCalls;
  current: () => StorageBucketRow | null;
} {
  const calls: FakeCalls = {
    get: 0,
    create: 0,
    update: 0,
    idsSeen: [],
    createdOptions: null,
    updatedOptions: null,
  };
  let state = initial;
  const api: StorageBucketApi = {
    async getBucket(id) {
      calls.get += 1;
      calls.idsSeen.push(id);
      if (!state) return { data: null, error: { message: 'Bucket not found' } };
      return { data: state, error: null };
    },
    async createBucket(id, options) {
      calls.create += 1;
      calls.idsSeen.push(id);
      calls.createdOptions = options;
      if (state) return { data: null, error: { message: 'already exists' } };
      state = {
        id,
        name: id,
        public: options.public,
        file_size_limit: options.fileSizeLimit,
        allowed_mime_types: options.allowedMimeTypes,
      };
      return { data: state, error: null };
    },
    async updateBucket(id, options) {
      calls.update += 1;
      calls.idsSeen.push(id);
      calls.updatedOptions = options;
      state = {
        id,
        name: id,
        public: options.public,
        file_size_limit: options.fileSizeLimit,
        allowed_mime_types: options.allowedMimeTypes,
      };
      return { data: state, error: null };
    },
  };
  return { api, calls, current: () => state };
}

function correctBucket(): StorageBucketRow {
  return {
    id: CONTENT_BUCKET_DEV,
    name: CONTENT_BUCKET_DEV,
    public: false,
    file_size_limit: 1_048_576,
    allowed_mime_types: ['text/markdown'],
  };
}

const devEnv: ContentBucketSetupEnv = {
  appEnv: 'development',
  schema: 'dev_staging',
  supabaseUrl: 'https://x.supabase.co',
  hasServerSecret: true,
};

describe('content bucket setup', () => {
  it('creates the bucket once when absent, with the exact configuration', async () => {
    const { api, calls } = fakeStorage(null);
    const result = await setupContentBucket(api);
    expect(result.status).toBe('created');
    expect(calls.create).toBe(1);
    expect(calls.update).toBe(0);
    expect(calls.createdOptions).toEqual({
      public: false,
      fileSizeLimit: 1_048_576,
      allowedMimeTypes: ['text/markdown'],
    });
    expect(calls.idsSeen.every((id) => id === CONTENT_BUCKET_DEV)).toBe(true);
  });

  it('is a no-op when the configuration already matches', async () => {
    const { api, calls } = fakeStorage(correctBucket());
    const result = await setupContentBucket(api);
    expect(result.status).toBe('already-correct');
    expect(calls.create).toBe(0);
    expect(calls.update).toBe(0);
  });

  it('converges a public bucket to private (no recreate)', async () => {
    const { api, calls } = fakeStorage({ ...correctBucket(), public: true });
    const result = await setupContentBucket(api);
    expect(result.status).toBe('updated');
    expect(calls.create).toBe(0);
    expect(calls.update).toBe(1);
    expect(result.changes.join(' ')).toContain('public');
    expect(calls.updatedOptions).toMatchObject({ public: false });
  });

  it('converges a wrong size limit', async () => {
    const { api, calls } = fakeStorage({
      ...correctBucket(),
      file_size_limit: 10_485_760,
    });
    const result = await setupContentBucket(api);
    expect(result.status).toBe('updated');
    expect(calls.update).toBe(1);
    expect(result.changes.join(' ')).toContain('file_size_limit');
  });

  it('converges a wrong MIME set, including extra types', async () => {
    const { api, calls } = fakeStorage({
      ...correctBucket(),
      allowed_mime_types: ['text/markdown', 'image/png'],
    });
    const result = await setupContentBucket(api);
    expect(result.status).toBe('updated');
    expect(calls.update).toBe(1);
    expect(result.changes.join(' ')).toContain('allowed_mime_types');
    expect(calls.updatedOptions).toMatchObject({
      allowedMimeTypes: ['text/markdown'],
    });
  });

  it('surfaces a non-not-found read error instead of creating', async () => {
    const api: StorageBucketApi = {
      getBucket: async () => ({
        data: null,
        error: { message: 'permission denied' },
      }),
      createBucket: async () => {
        throw new Error('must not be called');
      },
      updateBucket: async () => {
        throw new Error('must not be called');
      },
    };
    await expect(setupContentBucket(api)).rejects.toThrow(/permission denied/);
  });

  it('only ever addresses the dev content bucket', async () => {
    const { api, calls } = fakeStorage({ ...correctBucket(), public: true });
    await setupContentBucket(api);
    expect(new Set(calls.idsSeen)).toEqual(new Set([CONTENT_BUCKET_DEV]));
    expect(calls.idsSeen).not.toContain('website');
    expect(calls.idsSeen).not.toContain('website-dev');
    expect(calls.idsSeen).not.toContain('website-content');
  });
});

describe('content bucket environment gate', () => {
  it('accepts the dev database contract', () => {
    expect(() => assertContentBucketSetupAllowed(devEnv)).not.toThrow();
  });

  it('refuses production before any Storage call', async () => {
    const { api, calls } = fakeStorage(null);
    await expect(
      runContentBucketSetup({ ...devEnv, appEnv: 'production' }, api)
    ).rejects.toThrow(/refusing to run in production/);
    expect(calls.get + calls.create + calls.update).toBe(0);
  });

  it('refuses the public schema in a non-production environment', async () => {
    const { api, calls } = fakeStorage(null);
    await expect(
      runContentBucketSetup({ ...devEnv, schema: 'public' }, api)
    ).rejects.toThrow(/must be 'dev_staging'/);
    expect(calls.get + calls.create + calls.update).toBe(0);
  });

  it('refuses a missing schema, url or secret rather than defaulting', async () => {
    await expect(
      runContentBucketSetup({ ...devEnv, schema: '' }, fakeStorage(null).api)
    ).rejects.toThrow(/must be 'dev_staging'/);
    await expect(
      runContentBucketSetup(
        { ...devEnv, supabaseUrl: '' },
        fakeStorage(null).api
      )
    ).rejects.toThrow(/missing NEXT_PUBLIC_SUPABASE_URL/);
    await expect(
      runContentBucketSetup(
        { ...devEnv, hasServerSecret: false },
        fakeStorage(null).api
      )
    ).rejects.toThrow(/missing SUPABASE_SECRET_KEY/);
  });
});

describe('content bucket resolution', () => {
  it('maps the two consistent environment pairs', () => {
    expect(
      resolveContentBucket({ appEnv: 'production', schema: 'public' })
    ).toBe(CONTENT_BUCKET_PROD);
    expect(
      resolveContentBucket({ appEnv: 'development', schema: 'dev_staging' })
    ).toBe(CONTENT_BUCKET_DEV);
    expect(
      resolveContentBucket({ appEnv: 'staging', schema: 'dev_staging' })
    ).toBe(CONTENT_BUCKET_DEV);
  });

  it('fails closed on mismatched or unknown pairs', () => {
    for (const env of [
      { appEnv: 'development', schema: 'public' },
      { appEnv: 'production', schema: 'dev_staging' },
      { appEnv: 'staging', schema: 'public' },
      { appEnv: 'development', schema: 'qa_staging' },
      { appEnv: '', schema: '' },
    ]) {
      expect(() => resolveContentBucket(env)).toThrow(
        /refusing to resolve a content bucket/
      );
    }
  });
});

describe('currentContentBucket', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.APP_ENV;
  });

  it('resolves the dev bucket for the dev clone', () => {
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    expect(currentContentBucket()).toEqual({
      ok: true,
      bucket: CONTENT_BUCKET_DEV,
    });
  });

  it('derives production semantics from NODE_ENV when APP_ENV is unset', () => {
    delete process.env.APP_ENV;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    expect(currentContentBucket()).toEqual({
      ok: true,
      bucket: CONTENT_BUCKET_PROD,
    });
  });

  it('fails closed when the schema is missing outside production', () => {
    vi.stubEnv('APP_ENV', 'development');
    delete process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA;
    // The default schema is `public`, which a non-production process must not
    // read or write content against.
    expect(currentContentBucket().ok).toBe(false);
  });
});

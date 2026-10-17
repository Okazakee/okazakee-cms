import { describe, expect, it } from 'vitest';
import {
  bodyPointerUpdates,
  modifiedLocales,
  storePostBodies,
  type StorePostBodiesResult,
} from '@/libs/cms/storage/postBodyObjects';
import type {
  BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';

/**
 * Orchestration tests: only the languages a save touches are stored, the exact
 * bytes are preserved, and a committed matching pointer is reused without a
 * Storage call.
 */

function fakeStorage(seed?: Record<string, string>) {
  const objects: Record<string, Buffer> = {};
  for (const [path, body] of Object.entries(seed ?? {})) {
    objects[path] = Buffer.from(body, 'utf8');
  }
  const calls = { upload: [] as string[], download: [] as string[] };
  let uploadError: unknown = null;
  const api: BodyContentStorageApi = {
    async upload(path, body) {
      calls.upload.push(path);
      if (uploadError) return { data: null, error: uploadError };
      objects[path] = Buffer.from(body);
      return { data: { path }, error: null };
    },
    async download(path) {
      calls.download.push(path);
      const stored = objects[path];
      return stored
        ? { data: Buffer.from(stored), error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
    async remove(paths) {
      for (const path of paths) delete objects[path];
      return { data: null, error: null };
    },
  };
  return {
    api,
    calls,
    objects,
    setUploadError: (error: unknown) => {
      uploadError = error;
    },
  };
}

const EN = '# hello\n';
const IT = '# ciao 世界\n';

describe('storePostBodies', () => {
  it('stores EN and IT at canonical content-addressed paths', async () => {
    const store = fakeStorage();
    const result = await storePostBodies(store.api, 'blog', 7, [
      { locale: 'en', body: EN },
      { locale: 'it', body: IT },
    ]);

    expect(result.stored.en?.path).toMatch(/^blog\/7\/en\/[0-9a-f]{64}\.md$/);
    expect(result.stored.it?.path).toMatch(/^blog\/7\/it\/[0-9a-f]{64}\.md$/);
    expect(result.stored.en?.status).toBe('uploaded');
    expect(store.calls.upload).toEqual([
      result.stored.en?.path,
      result.stored.it?.path,
    ]);
    // Exact bytes, no normalization.
    expect(store.objects[result.stored.en?.path ?? '']?.toString('utf8')).toBe(EN);
    expect(store.objects[result.stored.it?.path ?? '']?.toString('utf8')).toBe(IT);
  });

  it('skips languages that are not part of the save', async () => {
    const store = fakeStorage();
    const result = await storePostBodies(store.api, 'blog', 7, [
      { locale: 'en', body: EN },
      { locale: 'it', body: undefined },
    ]);
    expect(result.stored.en).toBeDefined();
    expect(result.stored.it).toBeUndefined();
    expect(result.cleared).toEqual([]);
    expect(store.calls.upload).toHaveLength(1);
  });

  it('clears a language supplied as null or empty string', async () => {
    const store = fakeStorage();
    const result = await storePostBodies(store.api, 'blog', 7, [
      { locale: 'en', body: null },
      { locale: 'it', body: '' },
    ]);
    expect(result.cleared).toEqual(['en', 'it']);
    expect(result.stored.en).toBeUndefined();
    expect(store.calls.upload).toHaveLength(0);
  });

  it('reuses a committed matching body + pointer without a Storage call', async () => {
    const store = fakeStorage();
    const first = await storePostBodies(store.api, 'blog', 7, [
      { locale: 'en', body: EN },
    ]);
    const path = first.stored.en?.path ?? '';
    const uploadsAfterFirst = store.calls.upload.length;

    const second = await storePostBodies(
      store.api,
      'blog',
      7,
      [{ locale: 'en', body: EN }],
      { en: { body: EN, path } }
    );
    expect(second.stored.en).toEqual({
      path,
      hash: first.stored.en?.hash,
      size: first.stored.en?.size,
      status: 'existing',
    });
    expect(store.calls.upload).toHaveLength(uploadsAfterFirst);
  });

  it('initialises a NULL pointer when the body is supplied', async () => {
    const store = fakeStorage();
    const result = await storePostBodies(
      store.api,
      'blog',
      7,
      [{ locale: 'en', body: EN }],
      { en: { body: EN, path: null } }
    );
    expect(result.stored.en?.status).toBe('uploaded');
    expect(store.calls.upload).toHaveLength(1);
  });

  it('propagates an upload failure', async () => {
    const store = fakeStorage();
    store.setUploadError({ message: 'quota exceeded' });
    await expect(
      storePostBodies(store.api, 'blog', 7, [{ locale: 'en', body: EN }])
    ).rejects.toThrow(/quota exceeded/);
  });

  it('builds pointer updates only for touched languages', () => {
    const enPath = `blog/7/en/${'a'.repeat(64)}.md`;
    const result: StorePostBodiesResult = {
      kind: 'blog',
      postId: 7,
      stored: { en: { path: enPath, hash: 'a'.repeat(64), size: 3, status: 'uploaded' } },
      cleared: ['it'],
    };
    expect(bodyPointerUpdates(result)).toEqual({
      body_en_path: enPath,
      body_it_path: null,
    });

    const untouched: StorePostBodiesResult = {
      kind: 'blog',
      postId: 7,
      stored: {},
      cleared: [],
    };
    expect(bodyPointerUpdates(untouched)).toEqual({});
  });

  it('derives modified locales from a partial payload', () => {
    expect(modifiedLocales({}).map((r) => r.locale)).toEqual([]);
    expect(modifiedLocales({ body_en: 'x' }).map((r) => r.locale)).toEqual(['en']);
    expect(modifiedLocales({ body_it: 'y' }).map((r) => r.locale)).toEqual(['it']);
    expect(
      modifiedLocales({ body_en: 'x', body_it: null }).map((r) => r.locale)
    ).toEqual(['en', 'it']);
  });
});

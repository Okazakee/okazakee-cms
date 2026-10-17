import { describe, expect, it } from 'vitest';
import {
  type ReadPostBodyRequest,
  readPostBodies,
} from '@/libs/cms/storage/postBodyObjects';
import {
  type BodyContentStorageApi,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';

/**
 * Phase 9A read orchestration. Uses an injected fake Storage (the module's
 * documented boundary) so the integrity contract is exercised directly:
 * legacy fallback, Storage-first reads, and hard failures — never a silent
 * empty body or a silent DB fallback.
 */

type Kind = 'blog' | 'portfolio';

function key(
  markdown: string,
  kind: Kind = 'blog',
  postId = 7,
  locale: 'en' | 'it' = 'en'
): string {
  return `${kind}/${postId}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

function makeStorage(seed: Record<string, string> = {}, failure?: string) {
  const downloads: string[] = [];
  const api: BodyContentStorageApi = {
    upload: async () => ({ data: null, error: null }),
    remove: async () => ({ data: null, error: null }),
    download: async (path: string) => {
      downloads.push(path);
      if (failure) {
        return { data: null, error: { message: failure } };
      }
      const stored = seed[path];
      if (stored === undefined) {
        return { data: null, error: { message: 'Object not found' } };
      }
      return { data: Buffer.from(stored, 'utf8'), error: null };
    },
  };
  return { api, downloads };
}

function request(
  legacy: string | null,
  path: string | null
): ReadPostBodyRequest {
  return { legacy, path };
}

describe('readPostBodies: legacy fallback', () => {
  it('returns the legacy body for a NULL pointer without touching Storage', async () => {
    const storage = makeStorage();

    const result = await readPostBodies(storage.api, 'blog', 7, {
      en: request('# from db', null),
    });

    expect(result.bodies.en).toBe('# from db');
    expect(result.sources.en).toBe('legacy');
    expect(storage.downloads).toEqual([]);
  });

  it('returns null for a language with neither body nor pointer', async () => {
    const storage = makeStorage();

    const result = await readPostBodies(storage.api, 'blog', 7, {
      en: request(null, null),
      it: request(null, null),
    });

    expect(result.bodies).toEqual({ en: null, it: null });
    expect(storage.downloads).toEqual([]);
  });

  it('treats an absent locale entry as untouched', async () => {
    const storage = makeStorage();

    const result = await readPostBodies(storage.api, 'blog', 7, {
      en: request('# only en', null),
    });

    expect(result.bodies.it).toBeNull();
    expect(result.sources.it).toBeUndefined();
  });

  it('mixes one Storage-backed language with one legacy language', async () => {
    const stored = '# stored it';
    const storage = makeStorage({ [key(stored, 'blog', 7, 'it')]: stored });

    const result = await readPostBodies(storage.api, 'blog', 7, {
      en: request('# legacy en', null),
      it: request(stored, key(stored, 'blog', 7, 'it')),
    });

    expect(result.bodies).toEqual({ en: '# legacy en', it: stored });
    expect(result.sources).toEqual({ en: 'legacy', it: 'storage' });
    expect(storage.downloads).toHaveLength(1);
  });
});

describe('readPostBodies: Storage-first', () => {
  it('serves both languages from Storage when both are referenced', async () => {
    const en = '# en from storage';
    const it = '# it from storage';
    const storage = makeStorage({
      [key(en, 'blog', 7, 'en')]: en,
      [key(it, 'blog', 7, 'it')]: it,
    });

    const result = await readPostBodies(storage.api, 'blog', 7, {
      en: request(en, key(en, 'blog', 7, 'en')),
      it: request(it, key(it, 'blog', 7, 'it')),
    });

    expect(result.bodies).toEqual({ en, it });
    expect(result.sources).toEqual({ en: 'storage', it: 'storage' });
  });

  it('preserves exact Unicode and newlines byte-for-byte', async () => {
    const markdown = '# Tïtolo 🎉\r\n\r\nSecondo paragrafo — “virgolette”\n\n- àèìòù\n';
    const storage = makeStorage({
      [key(markdown, 'portfolio', 11, 'it')]: markdown,
    });

    const result = await readPostBodies(storage.api, 'portfolio', 11, {
      it: request(markdown, key(markdown, 'portfolio', 11, 'it')),
    });

    expect(result.bodies.it).toBe(markdown);
    expect(result.bodies.it?.length).toBe(markdown.length);
  });

  it('accepts a referenced object with no legacy body to compare', async () => {
    const markdown = '# storage only';
    const storage = makeStorage({ [key(markdown)]: markdown });

    const result = await readPostBodies(storage.api, 'blog', 7, {
      en: request(null, key(markdown)),
    });

    expect(result.bodies.en).toBe(markdown);
    expect(result.sources.en).toBe('storage');
  });
});

describe('readPostBodies: integrity failures', () => {
  it('fails when a pointer is referenced but Storage reads are disabled', async () => {
    await expect(
      readPostBodies(null, 'blog', 7, {
        en: request('# legacy', key('# legacy')),
      })
    ).rejects.toThrow('Storage reads are disabled');
  });

  it('fails on a missing object instead of returning an empty body', async () => {
    const storage = makeStorage();

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request('# legacy', key('# legacy')),
      })
    ).rejects.toThrow('Object not found');
  });

  it('fails on a download error', async () => {
    const storage = makeStorage({}, 'network exploded');

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request('# legacy', key('# legacy')),
      })
    ).rejects.toThrow('network exploded');
  });

  it('fails when the stored bytes do not hash to the object key', async () => {
    const expected = '# the promised content';
    const tampered = '# something else entirely';
    const storage = makeStorage({ [key(expected)]: tampered });

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request(expected, key(expected)),
      })
    ).rejects.toThrow('integrity failure');
  });

  it('fails when the pointer names another entity', async () => {
    const markdown = '# cross entity';
    const storage = makeStorage({
      [key(markdown, 'portfolio', 7, 'en')]: markdown,
    });

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request(markdown, key(markdown, 'portfolio', 7, 'en')),
      })
    ).rejects.toThrow('does not belong to');
  });

  it('fails when the pointer names another post id', async () => {
    const markdown = '# cross post';
    const storage = makeStorage({ [key(markdown, 'blog', 8, 'en')]: markdown });

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request(markdown, key(markdown, 'blog', 8, 'en')),
      })
    ).rejects.toThrow('does not belong to');
  });

  it('fails when the pointer names another locale', async () => {
    const markdown = '# cross locale';
    const storage = makeStorage({
      [key(markdown, 'blog', 7, 'it')]: markdown,
    });

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request(markdown, key(markdown, 'blog', 7, 'it')),
      })
    ).rejects.toThrow('does not belong to');
  });

  it('fails on a non-canonical key', async () => {
    const storage = makeStorage();

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request('# legacy', 'blog/7/en/not-a-hash.md'),
      })
    ).rejects.toThrow('canonical');
  });

  it('fails when Storage and the legacy column disagree', async () => {
    const stored = '# storage version';
    const legacy = '# database version';
    const storage = makeStorage({ [key(stored)]: stored });

    await expect(
      readPostBodies(storage.api, 'blog', 7, {
        en: request(legacy, key(stored)),
      })
    ).rejects.toThrow('disagreement');
  });
});

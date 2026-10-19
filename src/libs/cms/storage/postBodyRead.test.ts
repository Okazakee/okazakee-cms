import { describe, expect, it } from 'vitest';
import {
  type BodyContentStorageApi,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  POST_BODY_POINTER_COLUMNS,
  type PostBodyPointers,
  readPostBodies,
} from '@/libs/cms/storage/postBodyRead';

/**
 * Storage-only body reader. Uses an injected fake Storage (the module's
 * documented boundary), so the whole integrity contract is exercised without
 * network access or a database: there is no legacy column, no fallback and no
 * agreement check left to exercise.
 */

type Kind = 'blog' | 'portfolio';
type Locale = 'en' | 'it';

function path(
  markdown: string,
  kind: Kind = 'blog',
  postId = 7,
  locale: Locale = 'en'
): string {
  return `${kind}/${postId}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

function pointers(overrides: Partial<PostBodyPointers> = {}): PostBodyPointers {
  return { en: null, it: null, ...overrides };
}

/** Records every download; `payload` mirrors a Supabase Blob by default. */
function makeStorage(
  seed: Record<string, string> = {},
  options: { failure?: string; asBlob?: boolean } = {}
): { api: BodyContentStorageApi; downloads: string[] } {
  const downloads: string[] = [];
  const api: BodyContentStorageApi = {
    upload: async () => ({ data: null, error: null }),
    remove: async () => ({ data: null, error: null }),
    download: async (key: string) => {
      downloads.push(key);
      if (options.failure) {
        return { data: null, error: { message: options.failure } };
      }
      const stored = seed[key];
      if (stored === undefined) {
        return { data: null, error: { message: 'Object not found' } };
      }
      const bytes = Buffer.from(stored, 'utf8');
      if (options.asBlob === false) return { data: bytes, error: null };
      const part = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      return { data: new Blob([part], { type: 'text/markdown' }), error: null };
    },
  };
  return { api, downloads };
}

describe('readPostBodies: Storage-only resolution', () => {
  it('serves both languages from Storage when both are referenced', async () => {
    const en = '# en from storage';
    const it = '# it from storage';
    const storage = makeStorage({
      [path(en)]: en,
      [path(it, 'blog', 7, 'it')]: it,
    });

    const bodies = await readPostBodies(
      storage.api,
      'blog',
      7,
      pointers({
        en: path(en),
        it: path(it, 'blog', 7, 'it'),
      })
    );

    expect(bodies).toEqual({ en, it });
    expect(storage.downloads).toEqual([path(en), path(it, 'blog', 7, 'it')]);
  });

  it('preserves exact Unicode and newlines byte-for-byte', async () => {
    const markdown = '# Tïtolo 🎉\r\n\r\nSecondo — “virgolette”\n\n- àèìòù\n';
    const itPath = path(markdown, 'portfolio', 11, 'it');
    const storage = makeStorage({ [itPath]: markdown });

    const bodies = await readPostBodies(
      storage.api,
      'portfolio',
      11,
      pointers({
        it: itPath,
      })
    );

    expect(bodies.it).toBe(markdown);
    expect(bodies.it.length).toBe(markdown.length);
  });

  it('resolves each language independently', async () => {
    const en = '# only en';
    const storage = makeStorage({ [path(en)]: en });

    const bodies = await readPostBodies(
      storage.api,
      'blog',
      7,
      pointers({
        en: path(en),
      })
    );

    expect(bodies).toEqual({ en, it: '' });
    expect(storage.downloads).toEqual([path(en)]);
  });

  it('resolves an IT-only post without an EN download', async () => {
    const it = '# solo italiano';
    const itPath = path(it, 'blog', 7, 'it');
    const storage = makeStorage({ [itPath]: it });

    const bodies = await readPostBodies(
      storage.api,
      'blog',
      7,
      pointers({
        it: itPath,
      })
    );

    expect(bodies).toEqual({ en: '', it });
    expect(storage.downloads).toEqual([itPath]);
  });

  it('returns empty bodies for a row with no committed pointer', async () => {
    const storage = makeStorage();

    const bodies = await readPostBodies(storage.api, 'blog', 7, pointers());

    // A row whose body was never committed has no object and no PostgreSQL
    // copy to fall back to, so "no body" is the answer — not an error.
    expect(bodies).toEqual({ en: '', it: '' });
    expect(storage.downloads).toEqual([]);
  });

  it('accepts a raw byte payload as well as the Blob Storage returns', async () => {
    const markdown = '# raw bytes';
    const storage = makeStorage(
      { [path(markdown)]: markdown },
      { asBlob: false }
    );

    const bodies = await readPostBodies(
      storage.api,
      'blog',
      7,
      pointers({
        en: path(markdown),
      })
    );

    expect(bodies.en).toBe(markdown);
  });
});

describe('readPostBodies: integrity failures', () => {
  it('fails on a missing object instead of returning an empty body', async () => {
    const markdown = '# referenced but absent';
    const storage = makeStorage();

    await expect(
      readPostBodies(storage.api, 'blog', 7, pointers({ en: path(markdown) }))
    ).rejects.toThrow('Object not found');
  });

  it('fails on a download error', async () => {
    const markdown = '# boom';
    const storage = makeStorage({}, { failure: 'network exploded' });

    await expect(
      readPostBodies(storage.api, 'blog', 7, pointers({ en: path(markdown) }))
    ).rejects.toThrow('network exploded');
  });

  it('fails when the stored bytes do not hash to the object key', async () => {
    const promised = '# the promised content';
    const storage = makeStorage({
      [path(promised)]: '# something else entirely',
    });

    await expect(
      readPostBodies(storage.api, 'blog', 7, pointers({ en: path(promised) }))
    ).rejects.toThrow('integrity failure');
  });

  it('fails when the pointer names another entity', async () => {
    const markdown = '# cross entity';
    const storage = makeStorage({
      [path(markdown, 'portfolio', 7, 'en')]: markdown,
    });

    await expect(
      readPostBodies(
        storage.api,
        'blog',
        7,
        pointers({ en: path(markdown, 'portfolio', 7, 'en') })
      )
    ).rejects.toThrow('does not belong to');
  });

  it('fails when the pointer names another post id', async () => {
    const markdown = '# cross post';
    const storage = makeStorage({
      [path(markdown, 'blog', 8, 'en')]: markdown,
    });

    await expect(
      readPostBodies(
        storage.api,
        'blog',
        7,
        pointers({ en: path(markdown, 'blog', 8, 'en') })
      )
    ).rejects.toThrow('does not belong to');
  });

  it('fails when the pointer names another locale', async () => {
    const markdown = '# cross locale';
    const storage = makeStorage({
      [path(markdown, 'blog', 7, 'it')]: markdown,
    });

    await expect(
      readPostBodies(
        storage.api,
        'blog',
        7,
        pointers({ en: path(markdown, 'blog', 7, 'it') })
      )
    ).rejects.toThrow('does not belong to');
  });

  it('fails on a non-canonical key', async () => {
    const storage = makeStorage();

    await expect(
      readPostBodies(
        storage.api,
        'blog',
        7,
        pointers({ en: 'blog/7/en/not-a-hash.md' })
      )
    ).rejects.toThrow('canonical');
  });

  it('fails on an empty pointer rather than reading it as "no body"', async () => {
    const storage = makeStorage();

    await expect(
      readPostBodies(storage.api, 'blog', 7, pointers({ en: '' }))
    ).rejects.toThrow('does not belong to');
  });
});

describe('read-path projection', () => {
  it('names only the canonical pointer columns', () => {
    const columns = POST_BODY_POINTER_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual(['body_en_path', 'body_it_path']);
    // The retired columns must never be named: the final query has to keep
    // working once they are dropped.
    expect(columns).not.toContain('body_en');
    expect(columns).not.toContain('body_it');
    expect(columns).not.toContain('*');
  });
});

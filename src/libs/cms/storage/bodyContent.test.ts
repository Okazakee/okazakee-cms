import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BODY_CONTENT_CACHE_CONTROL,
  BODY_CONTENT_TYPE,
  MAX_BODY_CONTENT_BYTES,
  bodyContentPath,
  downloadBodyContent,
  isAlreadyExistsError,
  prepareBodyContent,
  removeBodyContentBestEffort,
  sha256Hex,
  uploadBodyContent,
  type BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';

/**
 * Unit tests for the Markdown body Storage abstraction. No network: the Storage
 * surface is a fake, and hashing is cross-checked against node:crypto.
 */

type UploadCall = {
  path: string;
  body: Buffer;
  options: { contentType: string; upsert: boolean; cacheControl: string };
};

function fakeObjectStorage(seed?: Record<string, Buffer | string>) {
  const objects = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(seed ?? {})) {
    objects.set(key, typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
  }
  const calls = {
    upload: [] as UploadCall[],
    download: [] as string[],
    remove: [] as string[][],
  };
  let uploadError: unknown = null;
  let downloadError: unknown = null;
  let removeError: unknown = null;

  const api: BodyContentStorageApi = {
    async upload(path, body, options) {
      calls.upload.push({ path, body: Buffer.from(body), options });
      if (uploadError) return { data: null, error: uploadError };
      if (objects.has(path)) {
        return {
          data: null,
          error: {
            statusCode: '409',
            error: 'Duplicate',
            message: 'The resource already exists',
          },
        };
      }
      objects.set(path, Buffer.from(body));
      return { data: { path }, error: null };
    },
    async download(path) {
      calls.download.push(path);
      if (downloadError) return { data: null, error: downloadError };
      const stored = objects.get(path);
      if (!stored) {
        return { data: null, error: { message: 'Object not found', statusCode: '404' } };
      }
      return { data: new Blob([new Uint8Array(stored)]), error: null };
    },
    async remove(paths) {
      calls.remove.push(paths);
      if (removeError) return { data: null, error: removeError };
      for (const path of paths) objects.delete(path);
      return { data: paths.map((path) => ({ name: path })), error: null };
    },
  };

  return {
    api,
    calls,
    objects,
    storedBytes: (path: string) => objects.get(path),
    setUploadError: (error: unknown) => {
      uploadError = error;
    },
    setDownloadError: (error: unknown) => {
      downloadError = error;
    },
    setRemoveError: (error: unknown) => {
      removeError = error;
    },
  };
}

describe('body content hashing', () => {
  it('is deterministic and produces 64 lowercase hex characters', () => {
    const a = sha256Hex(Buffer.from('# hello', 'utf8'));
    const b = sha256Hex(Buffer.from('# hello', 'utf8'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 vector and node:crypto', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(sha256Hex(Buffer.from('', 'utf8'))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    for (const sample of ['abc', 'héllo', '世界', '# t\n\n- a\n']) {
      expect(sha256Hex(Buffer.from(sample, 'utf8'))).toBe(
        createHash('sha256').update(sample, 'utf8').digest('hex')
      );
    }
  });

  it('hashes the UTF-8 bytes of multibyte content', () => {
    const text = 'héllo → 世界 🚀';
    expect(sha256Hex(Buffer.from(text, 'utf8'))).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    );
    // Byte identity, not code-point identity.
    expect(sha256Hex(Buffer.from(text, 'utf8'))).not.toBe(
      sha256Hex(Buffer.from(text, 'utf16le'))
    );
  });

  it('treats a trailing newline as a distinct object', () => {
    const base = prepareBodyContent('blog', 7, 'en', '# hello');
    const withNewline = prepareBodyContent('blog', 7, 'en', '# hello\n');
    expect(withNewline.hash).not.toBe(base.hash);
    expect(withNewline.path).not.toBe(base.path);
  });

  it('treats CRLF and LF as distinct objects', () => {
    const lf = prepareBodyContent('blog', 7, 'en', '# a\n# b');
    const crlf = prepareBodyContent('blog', 7, 'en', '# a\r\n# b');
    expect(crlf.hash).not.toBe(lf.hash);
  });

  it('never trims or normalizes the input', () => {
    const trimmed = prepareBodyContent('blog', 7, 'en', '# hello');
    const padded = prepareBodyContent('blog', 7, 'en', '  # hello  ');
    const upper = prepareBodyContent('blog', 7, 'en', '# HELLO');
    const composed = prepareBodyContent('blog', 7, 'en', 'é'); // precomposed
    const decomposed = prepareBodyContent('blog', 7, 'en', 'e\u0301'); // decomposed
    expect(padded.hash).not.toBe(trimmed.hash);
    expect(upper.hash).not.toBe(trimmed.hash);
    expect(decomposed.hash).not.toBe(composed.hash);
    expect(padded.size).toBe(Buffer.byteLength('  # hello  ', 'utf8'));
  });
});

describe('body content paths', () => {
  it('builds the four canonical forms', () => {
    const hash = 'a'.repeat(64);
    expect(bodyContentPath('blog', 7, 'en', hash)).toBe(`blog/7/en/${hash}.md`);
    expect(bodyContentPath('blog', 7, 'it', hash)).toBe(`blog/7/it/${hash}.md`);
    expect(bodyContentPath('portfolio', 11, 'en', hash)).toBe(
      `portfolio/11/en/${hash}.md`
    );
    expect(bodyContentPath('portfolio', 11, 'it', hash)).toBe(
      `portfolio/11/it/${hash}.md`
    );
  });

  it('rejects invalid kind, locale, id and hash', () => {
    const hash = 'a'.repeat(64);
    expect(() => bodyContentPath('posts', 1, 'en', hash)).toThrow(/invalid kind/);
    expect(() => bodyContentPath('blog', 1, 'fr', hash)).toThrow(/invalid locale/);
    expect(() => bodyContentPath('blog', 0, 'en', hash)).toThrow(/invalid postId/);
    expect(() => bodyContentPath('blog', -3, 'en', hash)).toThrow(/invalid postId/);
    expect(() => bodyContentPath('blog', 1.5, 'en', hash)).toThrow(/invalid postId/);
    expect(() => bodyContentPath('blog', 1, 'en', 'A'.repeat(64))).toThrow(
      /invalid hash/
    );
    expect(() => bodyContentPath('blog', 1, 'en', 'a'.repeat(63))).toThrow(
      /invalid hash/
    );
  });

  it('produces a path that satisfies the Phase 5A pointer shape', () => {
    const prepared = prepareBodyContent('portfolio', 11, 'it', '# body');
    expect(prepared.path).toMatch(/^portfolio\/11\/it\/[0-9a-f]{64}\.md$/);
    expect(prepared.path.startsWith('/')).toBe(false);
  });
});

describe('body content size contract', () => {
  it('accepts exactly the bucket limit and rejects one byte more', async () => {
    const atLimit = prepareBodyContent('blog', 1, 'en', 'a'.repeat(MAX_BODY_CONTENT_BYTES));
    expect(atLimit.size).toBe(MAX_BODY_CONTENT_BYTES);
    await expect(uploadBodyContent(fakeObjectStorage().api, atLimit)).resolves.toMatchObject({
      status: 'uploaded',
    });

    const store = fakeObjectStorage();
    expect(() =>
      prepareBodyContent('blog', 1, 'en', 'a'.repeat(MAX_BODY_CONTENT_BYTES + 1))
    ).toThrow(/over the 1048576 byte limit/);
    // Rejected before any Storage call.
    expect(store.calls.upload).toHaveLength(0);
  }, 30_000);

  it('counts UTF-8 bytes, not JavaScript characters', () => {
    // 400k characters, but 1.2 MB of UTF-8 — must be rejected.
    const multibyte = '€'.repeat(400_000);
    expect(multibyte.length).toBeLessThan(MAX_BODY_CONTENT_BYTES);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(
      MAX_BODY_CONTENT_BYTES
    );
    expect(() => prepareBodyContent('blog', 1, 'en', multibyte)).toThrow(
      /over the 1048576 byte limit/
    );
  }, 30_000);
});

describe('body content upload', () => {
  it('uploads immutably with the exact path, content type and cache lifetime', async () => {
    const store = fakeObjectStorage();
    const prepared = prepareBodyContent('blog', 7, 'en', '# hello\n');
    const result = await uploadBodyContent(store.api, prepared);

    expect(result).toEqual({
      status: 'uploaded',
      path: prepared.path,
      hash: prepared.hash,
      size: prepared.size,
    });
    expect(store.calls.upload).toHaveLength(1);
    const call = store.calls.upload[0];
    expect(call?.path).toBe(prepared.path);
    expect(call?.options).toEqual({
      contentType: BODY_CONTENT_TYPE,
      upsert: false,
      cacheControl: BODY_CONTENT_CACHE_CONTROL,
    });
    expect(call?.body.equals(prepared.bytes)).toBe(true);
    expect(store.storedBytes(prepared.path)?.equals(prepared.bytes)).toBe(true);
  });

  it('propagates an ordinary Storage error', async () => {
    const store = fakeObjectStorage();
    store.setUploadError({ statusCode: '400', message: 'Invalid request' });
    await expect(
      uploadBodyContent(store.api, prepareBodyContent('blog', 7, 'en', '# x'))
    ).rejects.toThrow(/upload .* failed: Invalid request/);
  });

  it('propagates a 409 that is not an existing-resource conflict', async () => {
    const store = fakeObjectStorage();
    store.setUploadError({ statusCode: '409', message: 'unrelated conflict' });
    await expect(
      uploadBodyContent(store.api, prepareBodyContent('blog', 7, 'en', '# x'))
    ).rejects.toThrow(/unrelated conflict/);
  });

  it('treats an identical existing object as success after byte verification', async () => {
    const prepared = prepareBodyContent('blog', 7, 'en', '# hello');
    const store = fakeObjectStorage({ [prepared.path]: prepared.bytes });
    const result = await uploadBodyContent(store.api, prepared);

    expect(result.status).toBe('existing');
    expect(store.calls.download).toEqual([prepared.path]);
    expect(store.calls.upload).toHaveLength(1);
  });

  it('fails with an integrity error when the stored bytes differ', async () => {
    const prepared = prepareBodyContent('blog', 7, 'en', '# hello');
    const tampered = Buffer.from('# tampered', 'utf8');
    const store = fakeObjectStorage({ [prepared.path]: tampered });
    const before = Buffer.from(store.storedBytes(prepared.path) ?? Buffer.alloc(0));

    await expect(uploadBodyContent(store.api, prepared)).rejects.toThrow(
      /integrity failure/
    );
    // The existing object is never overwritten.
    expect(store.storedBytes(prepared.path)?.equals(before)).toBe(true);
    expect(store.storedBytes(prepared.path)?.equals(tampered)).toBe(true);
  });

  it('verifies an existing object reported through the modern error shape', async () => {
    const prepared = prepareBodyContent('blog', 8, 'it', '# modern');
    const store = fakeObjectStorage({ [prepared.path]: prepared.bytes });
    store.setUploadError({ code: 'ResourceAlreadyExists' });
    await expect(uploadBodyContent(store.api, prepared)).resolves.toMatchObject({
      status: 'existing',
    });
  });

  it('verifies an existing object reported through the legacy error shape', async () => {
    const prepared = prepareBodyContent('blog', 9, 'it', '# legacy');
    const store = fakeObjectStorage({ [prepared.path]: prepared.bytes });
    store.setUploadError({
      statusCode: '409',
      error: 'Duplicate',
      message: 'The resource already exists',
    });
    await expect(uploadBodyContent(store.api, prepared)).resolves.toMatchObject({
      status: 'existing',
    });
  });

  it('surfaces a failed verification download', async () => {
    const prepared = prepareBodyContent('blog', 7, 'en', '# hello');
    const store = fakeObjectStorage({ [prepared.path]: prepared.bytes });
    store.setUploadError({ code: 'ResourceAlreadyExists' });
    store.setDownloadError({ message: 'boom' });
    await expect(uploadBodyContent(store.api, prepared)).rejects.toThrow(
      /download .* failed: boom/
    );
  });

  it('does not treat unrelated error shapes as existing', () => {
    expect(isAlreadyExistsError({ statusCode: '409', message: 'nope' })).toBe(false);
    expect(isAlreadyExistsError({ statusCode: '400', code: 'BadRequest' })).toBe(false);
    expect(isAlreadyExistsError('boom')).toBe(false);
    expect(isAlreadyExistsError(null)).toBe(false);
    expect(isAlreadyExistsError({ code: 'ResourceAlreadyExists' })).toBe(true);
    expect(isAlreadyExistsError({ error: 'already_exists' })).toBe(true);
    expect(isAlreadyExistsError({ code: 'Conflict' })).toBe(true);
    expect(
      isAlreadyExistsError({ statusCode: 409, message: 'resource already exists' })
    ).toBe(true);
  });
});

describe('body content download', () => {
  it('round-trips exact UTF-8, Unicode and newlines', async () => {
    for (const text of [
      '# hello\n',
      'a\r\nb\n',
      'héllo → 世界 🚀',
      '   leading and trailing   ',
      '',
    ]) {
      const prepared = prepareBodyContent('blog', 7, 'en', text);
      const store = fakeObjectStorage({ [prepared.path]: prepared.bytes });
      await expect(downloadBodyContent(store.api, prepared.path)).resolves.toBe(text);
    }
  });

  it('propagates a Storage download error', async () => {
    const store = fakeObjectStorage();
    await expect(downloadBodyContent(store.api, 'blog/1/en/x.md')).rejects.toThrow(
      /download .* failed: Object not found/
    );
  });
});

describe('body content removal', () => {
  it('removes exactly the given path', async () => {
    const keep = `blog/1/en/${'a'.repeat(64)}.md`;
    const drop = `blog/1/en/${'b'.repeat(64)}.md`;
    const store = fakeObjectStorage({ [keep]: '# keep', [drop]: '# drop' });

    await expect(removeBodyContentBestEffort(store.api, drop)).resolves.toBe(true);
    expect(store.calls.remove).toEqual([[drop]]);
    expect(store.storedBytes(drop)).toBeUndefined();
    expect(store.storedBytes(keep)).toBeDefined();
  });

  it('never throws on cleanup failure', async () => {
    const store = fakeObjectStorage({ 'blog/1/en/x.md': '# x' });
    store.setRemoveError({ message: 'permission denied' });
    await expect(
      removeBodyContentBestEffort(store.api, 'blog/1/en/x.md')
    ).resolves.toBe(false);
  });
});

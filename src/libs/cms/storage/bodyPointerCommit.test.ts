import { describe, expect, it } from 'vitest';
import {
  type BodyContentStorageApi,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  clientBodyPointerRejection,
  commitGuardedRow,
  modifiedLocales,
  POINTER_CONFLICT_MESSAGE,
  pointerCommitFields,
  pointerGuards,
  replacedBodyMarkdown,
  stagePostBodies,
  stripRetiredBodyColumns,
} from '@/libs/cms/storage/bodyPointerCommit';
import { createFakeSupabase } from '@/testing/unit/supabaseFake';

/**
 * Write-path unit tests over the module's documented boundary (an injected
 * bucket-scoped Storage API and an injected DB client). No network, no bucket.
 */

const EN = '# hello\n';
const IT = '# ciao 世界\n';

function pathFor(markdown: string, locale: 'en' | 'it' = 'en', postId = 7) {
  return `blog/${postId}/${locale}/${sha256Hex(Buffer.from(markdown, 'utf8'))}.md`;
}

function fakeStorage(seed: Record<string, string> = {}) {
  const objects: Record<string, Buffer> = {};
  for (const [objectPath, body] of Object.entries(seed)) {
    objects[objectPath] = Buffer.from(body, 'utf8');
  }
  const calls = { upload: [] as string[], download: [] as string[] };
  let tamper: Buffer | null = null;
  const api: BodyContentStorageApi = {
    async upload(objectPath, body) {
      calls.upload.push(objectPath);
      objects[objectPath] = tamper ?? Buffer.from(body);
      return { data: { path: objectPath }, error: null };
    },
    async download(objectPath) {
      calls.download.push(objectPath);
      const stored = objects[objectPath];
      return stored
        ? { data: Buffer.from(stored), error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
    async remove(paths) {
      for (const objectPath of paths) delete objects[objectPath];
      return { data: null, error: null };
    },
  };
  return {
    api,
    calls,
    objects,
    /** Make the NEXT upload store different bytes than it was given. */
    tamperWith: (bytes: Buffer) => {
      tamper = bytes;
    },
  };
}

describe('stagePostBodies', () => {
  it('uploads the exact bytes to the canonical key and verifies the stored object', async () => {
    const store = fakeStorage();

    const result = await stagePostBodies(store.api, 'blog', 7, [
      { locale: 'en', body: EN },
      { locale: 'it', body: IT },
    ]);

    expect(result.pointers).toEqual({ en: pathFor(EN), it: pathFor(IT, 'it') });
    expect(result.reused).toEqual([]);
    // Immutable write + read-back proof of the bytes the key promises.
    expect(store.calls.upload).toEqual([pathFor(EN), pathFor(IT, 'it')]);
    expect(store.calls.download).toEqual([pathFor(EN), pathFor(IT, 'it')]);
    expect((store.objects[pathFor(IT, 'it')] as Buffer).toString('utf8')).toBe(
      IT
    );
  });

  it('rejects an object whose stored bytes do not hash to the key', async () => {
    const store = fakeStorage();
    store.tamperWith(Buffer.from('# different', 'utf8'));

    await expect(
      stagePostBodies(store.api, 'blog', 7, [{ locale: 'en', body: EN }])
    ).rejects.toThrow(/integrity failure/);
  });

  it('uploads nothing when the committed pointer already names those bytes', async () => {
    const store = fakeStorage();
    const prior = { en: pathFor(EN), it: null };

    const result = await stagePostBodies(
      store.api,
      'blog',
      7,
      [{ locale: 'en', body: EN }],
      prior
    );

    expect(result.pointers.en).toBe(pathFor(EN));
    expect(result.reused).toEqual(['en']);
    expect(store.calls).toEqual({ upload: [], download: [] });
  });

  it('clears on null/empty and leaves untouched locales out of the commit', async () => {
    const store = fakeStorage();

    const result = await stagePostBodies(store.api, 'blog', 7, [
      { locale: 'en', body: null },
      { locale: 'it', body: '' },
      { locale: 'en', body: undefined },
    ]);

    expect(result.pointers).toEqual({ en: null, it: null });
    expect(store.calls).toEqual({ upload: [], download: [] });
    expect(modifiedLocales({})).toEqual([]);
  });

  it('propagates an upload failure without producing a pointer', async () => {
    const failing: BodyContentStorageApi = {
      upload: async () => ({
        data: null,
        error: { message: 'quota exceeded' },
      }),
      download: async () => ({ data: null, error: null }),
      remove: async () => ({ data: null, error: null }),
    };

    await expect(
      stagePostBodies(failing, 'blog', 7, [{ locale: 'en', body: EN }])
    ).rejects.toThrow(/quota exceeded/);
  });
});

describe('pointer fields and guards', () => {
  it('writes only the pointer columns of the touched locales', () => {
    expect(pointerCommitFields({ en: pathFor(EN) })).toEqual({
      body_en_path: pathFor(EN),
    });
    expect(pointerCommitFields({ it: null })).toEqual({ body_it_path: null });
    expect(pointerCommitFields({})).toEqual({});
  });

  it('guards only the touched locales, against the observed value (NULL included)', () => {
    const prior = { en: pathFor(EN), it: pathFor(IT, 'it') };

    expect(pointerGuards({ en: pathFor('# new') }, prior)).toEqual([
      { column: 'body_en_path', expected: pathFor(EN) },
    ]);
    expect(pointerGuards({ it: null }, prior)).toEqual([
      { column: 'body_it_path', expected: pathFor(IT, 'it') },
    ]);
    // A locale that had no pointer observed NULL, so the guard is `is null`.
    expect(pointerGuards({ en: pathFor(EN) }, {})).toEqual([
      { column: 'body_en_path', expected: null },
    ]);
  });

  it('keeps the conflict message free of malformed copy', () => {
    expect(POINTER_CONFLICT_MESSAGE).toMatch(/^Conflicting concurrent edit/);
  });
});

describe('commitGuardedRow', () => {
  const seed = () => ({
    blog_posts: [
      {
        id: 7,
        image: '',
        body_en_path: null as string | null,
        body_it_path: null as string | null,
      },
    ],
  });

  it('commits when the observed pointer still holds', async () => {
    const fake = createFakeSupabase({ tables: seed() });

    const outcome = await commitGuardedRow(
      fake.client,
      'blog_posts',
      7,
      { body_en_path: pathFor(EN), hidden: false },
      [{ column: 'body_en_path', expected: null }]
    );

    expect(outcome.status).toBe('committed');
    const row = fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(pathFor(EN));
    expect(row?.hidden).toBe(false);
  });

  it('reports a conflict, without writing, when the pointer moved', async () => {
    const fake = createFakeSupabase({
      tables: {
        blog_posts: [
          {
            id: 7,
            body_en_path: pathFor('# someone else'),
            body_it_path: null,
          },
        ],
      },
    });

    const outcome = await commitGuardedRow(
      fake.client,
      'blog_posts',
      7,
      { body_en_path: pathFor(EN), hidden: false },
      [{ column: 'body_en_path', expected: null }]
    );

    expect(outcome.status).toBe('conflict');
    const row = fake.state.tables.blog_posts[0];
    expect(row?.body_en_path).toBe(pathFor('# someone else'));
    expect(row?.hidden).toBeUndefined();
  });

  it('reports a conflict when the row is gone', async () => {
    const fake = createFakeSupabase({ tables: { blog_posts: [] } });

    const outcome = await commitGuardedRow(
      fake.client,
      'blog_posts',
      7,
      { body_en_path: pathFor(EN) },
      [{ column: 'body_en_path', expected: null }]
    );

    expect(outcome.status).toBe('conflict');
  });

  it('surfaces a database error instead of a silent success', async () => {
    const fake = createFakeSupabase({
      tables: seed(),
      failNext: {
        table: 'blog_posts',
        mode: 'update',
        message: 'db down',
      },
    });

    const outcome = await commitGuardedRow(
      fake.client,
      'blog_posts',
      7,
      { body_en_path: pathFor(EN) },
      []
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toMatchObject({ message: 'db down' });
    }
  });
});

describe('row payload hygiene', () => {
  it('never carries the retired Markdown columns', () => {
    expect(
      stripRetiredBodyColumns({
        title_en: 't',
        body_en: '# real',
        body_it: '# vero',
      })
    ).toEqual({ title_en: 't' });
  });

  it('rejects client-supplied pointers (own properties only)', () => {
    expect(clientBodyPointerRejection({ body_en_path: pathFor(EN) })).toContain(
      'server-generated'
    );
    expect(clientBodyPointerRejection({ title_en: 't' })).toBeNull();
    const inherited = Object.create({ body_it_path: pathFor(IT, 'it') });
    expect(clientBodyPointerRejection(inherited)).toBeNull();
  });
});

describe('replacedBodyMarkdown', () => {
  it('reads only the objects whose pointer actually moves', async () => {
    const moved = pathFor('# old en');
    const store = fakeStorage({ [moved]: '# old en' });

    const previous = await replacedBodyMarkdown(
      store.api,
      [
        { locale: 'en', body: '# new en' },
        { locale: 'it', body: undefined },
      ],
      { en: moved, it: pathFor(IT, 'it') },
      { en: pathFor('# new en') }
    );

    expect(previous).toEqual(['# old en']);
    expect(store.calls.download).toEqual([moved]);
  });

  it('skips the read when the pointer does not move', async () => {
    const unchanged = pathFor(EN);
    const store = fakeStorage();

    const previous = await replacedBodyMarkdown(
      store.api,
      [{ locale: 'en', body: EN }],
      { en: unchanged },
      { en: unchanged }
    );
    expect(previous).toEqual([]);
    expect(store.calls.download).toEqual([]);
  });

  it('tolerates a missing previous object instead of failing the save', async () => {
    const missing = pathFor('# gone');
    const store = fakeStorage();

    const previous = await replacedBodyMarkdown(
      store.api,
      [{ locale: 'en', body: '# new' }],
      { en: missing },
      { en: pathFor('# new') }
    );

    expect(previous).toEqual([]);
    expect(store.calls.download).toEqual([missing]);
  });
});

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FALLBACK_BLURHASH } from '@/utils/blurhashUtils';
import type { BodyImageUpload } from '@/utils/cms/postBody';
import {
  applyBodyImageRewrites,
  cleanupOrphanedBodyImages,
  removeBodyUploads,
  uploadBodyImages,
  validateBodyImagePayload,
} from './postBodyFiles';

const ORIGIN = 'https://x.test';
const BUCKET = 'website-dev';
const PREFIX = 'blog/7';

function webpFile(name = 'shot.webp'): File {
  return new File([new Uint8Array(64)], name, { type: 'image/webp' });
}

function stagedFile(localId: string, alt = 'my-photo'): BodyImageUpload {
  return { localId, file: webpFile(), blurhash: FALLBACK_BLURHASH, alt };
}

function makeFake() {
  const uploaded: string[] = [];
  const removed: string[][] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          uploaded.push(`${bucket}/${path}`);
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: {
            publicUrl: `${ORIGIN}/storage/v1/object/public/${bucket}/${path}`,
          },
        }),
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, uploaded, removed };
}

describe('validateBodyImagePayload', () => {
  it('accepts resolvable pending refs and legacy lines', () => {
    expect(
      validateBodyImagePayload([stagedFile('a')], [
        'text ![cap-pending:a](blob:u)',
        '![No dash](https://x.test/f.webp)',
      ])
    ).toBeNull();
  });

  it('rejects duplicates, dangling refs and broken syntax', () => {
    expect(
      validateBodyImagePayload([stagedFile('a'), stagedFile('a')], [])
    ).toContain('Duplicate');
    expect(validateBodyImagePayload([], ['![c-pending:zz](blob:u)'])).toContain(
      're-insert'
    );
    expect(validateBodyImagePayload([], ['broken ![alt(url)'])).toContain(
      'line 1'
    );
  });
});

describe('uploadBodyImages + applyBodyRewrites', () => {
  it('uploads into the post prefix and rewrites both locales', async () => {
    const { client, uploaded } = makeFake();
    const { rewrites, staged } = await uploadBodyImages(
      client,
      BUCKET,
      PREFIX,
      'post',
      [stagedFile('a')]
    );
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.startsWith(`${BUCKET}/${PREFIX}/`)).toBe(true);
    expect(staged).toHaveLength(1);
    const committed = rewrites.get('a') ?? '';
    // Alt dashes sanitized, real blurhash embedded, absolute public URL.
    expect(committed.startsWith(`![my photo-${FALLBACK_BLURHASH}](`)).toBe(
      true
    );
    const bodies = applyBodyImageRewrites(
      {
        body_en: 'x ![c-pending:a](blob:u)',
        body_it: 'y ![c-pending:a](blob:u)',
      },
      rewrites
    );
    expect(bodies.body_en).toBe(`x ${committed}`);
    expect(bodies.body_it).toBe(`y ${committed}`);
  });

  it('removeBodyUploads deletes every staged path', async () => {
    const { client, removed } = makeFake();
    await removeBodyUploads(client, BUCKET, ['blog/7/a.webp', 'blog/7/b.webp']);
    expect(removed).toEqual([['blog/7/a.webp'], ['blog/7/b.webp']]);
  });
});

describe('cleanupOrphanedBodyImages', () => {
  const url = (path: string) =>
    `${ORIGIN}/storage/v1/object/public/${BUCKET}/${path}`;

  it('removes unreferenced post-folder objects, keeps cover and referenced', async () => {
    const { client, removed } = makeFake();
    await cleanupOrphanedBodyImages(
      client,
      BUCKET,
      ORIGIN,
      PREFIX,
      [
        `![a-h](${url(`${PREFIX}/gone.webp`)}) ![b-h](${url(`${PREFIX}/kept.webp`)})`,
      ],
      [`![b-h](${url(`${PREFIX}/kept.webp`)})`],
      [url(`${PREFIX}/cover.webp`)]
    );
    expect(removed).toEqual([[`${PREFIX}/gone.webp`]]);
  });

  it('ignores external, cross-bucket and pending urls', async () => {
    const { client, removed } = makeFake();
    await cleanupOrphanedBodyImages(
      client,
      BUCKET,
      ORIGIN,
      PREFIX,
      [
        '![a-h](https://cdn.test/x.webp)',
        `![b-h](${ORIGIN}/storage/v1/object/public/website/${PREFIX}/p.webp)`,
        '![c-pending:z](blob:u)',
      ],
      ['nothing here'],
      []
    );
    expect(removed).toEqual([]);
  });
});

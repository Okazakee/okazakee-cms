/**
 * Storage-only reader for the EN/IT Markdown of a single post (server-only).
 *
 * Supabase Storage is the SOLE authoritative body store: every locale is
 * resolved from the committed content-addressed pointer on the row, and the
 * retired `body_en`/`body_it` columns are never read, never compared against
 * Storage and never used as a fallback. The reader therefore keeps working
 * unchanged once those columns are dropped.
 *
 * Contract per locale:
 * - NULL pointer             -> `''`: the row has no body committed yet. A row
 *                              only gets its canonical key on the first save
 *                              that carries content (the pointer columns stay
 *                              nullable for exactly that reason), so there is
 *                              nothing else to serve.
 * - pointer                  -> download that object and verify that its raw
 *                              bytes hash to the SHA-256 embedded in the
 *                              canonical key.
 * - missing / unreadable / mismatched / non-canonical -> error. A referenced
 *   object is never silently reported as an empty body, and a pointer that
 *   names another entity, post id or locale is rejected instead of trusted.
 *
 * The Storage surface is injected (a bucket-scoped `storage.from(bucket)`), so
 * the module never constructs credentials or resolves a bucket itself. The
 * exact UTF-8 bytes are the identity: no trim, no newline or Unicode
 * normalization.
 */
import {
  type BodyContentKind,
  type BodyContentLocale,
  type BodyContentStorageApi,
  readBodyContentBytes,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';

/** Both locales are always resolved; a locale without a body resolves to `''`. */
export type ResolvedPostBodies = Record<BodyContentLocale, string>;

/** Committed content-addressed pointers, as read from the row. */
export type PostBodyPointers = Record<BodyContentLocale, string | null>;

/**
 * The read-path projection for a body read: the caller already knows the row id,
 * so the canonical pointers are all a query needs. The retired `body_en` /
 * `body_it` columns are never named, which is what keeps this working once they
 * are dropped.
 */
export const POST_BODY_POINTER_COLUMNS = 'body_en_path, body_it_path';

/** Those columns exactly as they come back from a row. */
export type PostBodyPointerRow = {
  body_en_path: string | null;
  body_it_path: string | null;
};

const BODY_LOCALES: readonly BodyContentLocale[] = ['en', 'it'];

/** Canonical key prefix for one language of one post: `<kind>/<postId>/<locale>/`. */
function pointerPrefix(
  kind: BodyContentKind,
  postId: number,
  locale: BodyContentLocale
): string {
  return `${kind}/${postId}/${locale}/`;
}

/**
 * The SHA-256 embedded in a committed pointer, or a throw when the pointer does
 * not name exactly the requested entity, post id and locale with a canonical
 * `<sha256>.md` file name. This is what stops a mis-typed or cross-post pointer
 * from silently serving another post's content.
 */
function expectedHashFromPointer(
  kind: BodyContentKind,
  postId: number,
  locale: BodyContentLocale,
  path: string
): string {
  const prefix = pointerPrefix(kind, postId, locale);
  if (!path.startsWith(prefix)) {
    throw new Error(
      `[body-read] pointer '${path}' does not belong to ${prefix}`
    );
  }
  const file = path.slice(prefix.length);
  if (!/^[0-9a-f]{64}\.md$/.test(file)) {
    throw new Error(
      `[body-read] pointer '${path}' is not a canonical ${prefix}<sha256>.md key`
    );
  }
  return file.slice(0, -'.md'.length);
}

/**
 * Resolves the EN/IT Markdown of a single post from Storage, downloading each
 * referenced locale independently: one locale's object key never decides
 * another's. Throws on any integrity failure.
 */
export async function readPostBodies(
  storage: BodyContentStorageApi,
  kind: BodyContentKind,
  postId: number,
  pointers: PostBodyPointers
): Promise<ResolvedPostBodies> {
  const bodies: ResolvedPostBodies = { en: '', it: '' };

  for (const locale of BODY_LOCALES) {
    const path = pointers[locale] ?? null;
    if (path === null) continue;

    const expectedHash = expectedHashFromPointer(kind, postId, locale, path);
    const bytes = await readBodyContentBytes(storage, path);
    const actualHash = sha256Hex(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(
        `[body-read] integrity failure at ${path}: content hash ${actualHash} does not match the object key`
      );
    }

    bodies[locale] = bytes.toString('utf8');
  }

  return bodies;
}

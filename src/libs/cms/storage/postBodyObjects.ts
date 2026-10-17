/**
 * Shared orchestration for storing the final EN/IT Markdown of a post as
 * immutable content-addressed objects (Phase 7A; reused by Phase 7B).
 *
 * It sits above the low-level `bodyContent` module and knows nothing about
 * buckets or credentials: the caller passes an already-scoped Storage API
 * (`admin.storage.from(bucket)`). It prepares and uploads only the languages a
 * save actually touches, so a metadata-only update makes no Storage call.
 *
 * Phase 9A adds the mirrored read path (`readPostBodies`): a Storage-first read
 * for referenced languages, the legacy DB column for NULL pointers, and hard
 * integrity errors (never a silent fallback) when a referenced object is
 * missing, corrupt or disagrees with the committed body.
 */
import {
  prepareBodyContent,
  readBodyContentBytes,
  sha256Hex,
  uploadBodyContent,
  type BodyContentKind,
  type BodyContentLocale,
  type BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';

export type PostBodyKind = BodyContentKind;
export type PostBodyLocale = BodyContentLocale;

/**
 * Per-language request:
 *   undefined -> not part of this save (pointer preserved by the caller)
 *   null/''   -> clear this language's body and pointer
 *   string    -> store this exact Markdown
 */
export type PostBodyRequest = {
  locale: PostBodyLocale;
  body: string | null | undefined;
};

export type StoredPostBody = {
  path: string;
  hash: string;
  size: number;
  /**
   * `uploaded` when this call wrote the object; `existing` when it was already
   * stored under the same key (either byte-verified after an upload conflict,
   * or reused because the committed row already holds this exact body+pointer).
   */
  status: 'uploaded' | 'existing';
};

export type StorePostBodiesResult = {
  kind: PostBodyKind;
  postId: number;
  /** Languages stored by this call, keyed by locale. */
  stored: Partial<Record<PostBodyLocale, StoredPostBody>>;
  /** Languages explicitly cleared by this call. */
  cleared: PostBodyLocale[];
};

/** Server-generated pointer columns clients must never supply. */
const BODY_POINTER_FIELDS = ['body_en_path', 'body_it_path'] as const;

/**
 * Client action payloads are typed but not validated at runtime, and several
 * paths spread them into DB writes. Own-property detection only: an inherited
 * `body_en_path` (e.g. from a prototype) is not a payload field.
 *
 * Returns an error message, or null when the payload is clean. Pointer paths are
 * always generated server-side from the final body and the real row id.
 */
export function clientBodyPointerRejection(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  for (const field of BODY_POINTER_FIELDS) {
    if (Object.hasOwn(data, field)) {
      return `${field} is server-generated and cannot be supplied by clients`;
    }
  }
  return null;
}

/** The locales this module will consider. */
const BODY_LOCALES: PostBodyLocale[] = ['en', 'it'];

/**
 * Prepares and immutably stores the requested languages.
 *
 * `current` carries the committed body + pointer per locale so an unchanged body
 * with an already-correct pointer is reused without a Storage call; a NULL
 * pointer is initialised on the next save that supplies the body.
 */
export async function storePostBodies(
  storage: BodyContentStorageApi,
  kind: PostBodyKind,
  postId: number,
  requests: PostBodyRequest[],
  current?: Partial<
    Record<PostBodyLocale, { body?: string | null; path?: string | null }>
  >
): Promise<StorePostBodiesResult> {
  const stored: Partial<Record<PostBodyLocale, StoredPostBody>> = {};
  const cleared: PostBodyLocale[] = [];

  for (const request of requests) {
    const { locale, body } = request;
    if (body === undefined) continue;
    if (body === null || body === '') {
      cleared.push(locale);
      continue;
    }

    const prepared = prepareBodyContent(kind, postId, locale, body);
    const previous = current?.[locale];
    if (previous?.body === body && previous.path === prepared.path) {
      // The committed row already points at this exact content-addressed key.
      stored[locale] = {
        path: prepared.path,
        hash: prepared.hash,
        size: prepared.size,
        status: 'existing',
      };
      continue;
    }

    const result = await uploadBodyContent(storage, prepared);
    stored[locale] = {
      path: result.path,
      hash: result.hash,
      size: result.size,
      status: result.status,
    };
  }

  return { kind, postId, stored, cleared };
}

/**
 * Pointer columns a DB update must write for the languages this save touched.
 * Languages that were neither stored nor cleared are omitted so their existing
 * pointer is left untouched.
 */
export function bodyPointerUpdates(
  result: StorePostBodiesResult
): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  for (const locale of BODY_LOCALES) {
    const entry = result.stored[locale];
    if (entry) {
      fields[`body_${locale}_path`] = entry.path;
    } else if (result.cleared.includes(locale)) {
      fields[`body_${locale}_path`] = null;
    }
  }
  return fields;
}

/**
 * Which languages a save modifies, derived from the loosely-typed action
 * payload: an explicit `undefined` means "not part of this save".
 */
export function modifiedLocales(
  data: { body_en?: string | null; body_it?: string | null }
): PostBodyRequest[] {
  const requests: PostBodyRequest[] = [];
  for (const locale of BODY_LOCALES) {
    const body = locale === 'en' ? data.body_en : data.body_it;
    if (body !== undefined) requests.push({ locale, body });
  }
  return requests;
}

/** Committed state for one language of a post, as read from the DB row. */
export type ReadPostBodyRequest = {
  /** Legacy DB body for this locale; NULL when the column is empty. */
  legacy: string | null;
  /** Committed content-addressed pointer; NULL when the language has none. */
  path: string | null;
};

/** Where a returned body came from — drives diagnostics, never the contract. */
export type PostBodySource = 'legacy' | 'storage';

export type ReadPostBodiesResult = {
  kind: PostBodyKind;
  postId: number;
  /** Exact Markdown per locale; NULL when that language has no body at all. */
  bodies: Record<PostBodyLocale, string | null>;
  /** Locales resolved by this call, and from where. */
  sources: Partial<Record<PostBodyLocale, PostBodySource>>;
};

/** Canonical key prefix for one language of one post: `<kind>/<postId>/<locale>/`. */
function pointerPrefix(
  kind: PostBodyKind,
  postId: number,
  locale: PostBodyLocale
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
  kind: PostBodyKind,
  postId: number,
  locale: PostBodyLocale,
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
 * Resolves the EN/IT Markdown of a single post.
 *
 * Contract per language:
 * - NULL pointer            -> the legacy DB body (no Storage call).
 * - pointer + `storage`     -> download the object, verify its bytes hash to the
 *                              SHA-256 embedded in the key, and — when the
 *                              legacy column also holds content — verify the two
 *                              agree.
 * - pointer + `storage === null` -> error: a referenced object can never be
 *                              silently rendered as an empty body.
 *
 * A missing, unreadable or hash-mismatched object throws; a disagreement between
 * Storage and the legacy column throws. Nothing here normalizes Markdown: the
 * exact UTF-8 bytes are the identity, so Unicode and newlines round-trip
 * unchanged.
 */
export async function readPostBodies(
  storage: BodyContentStorageApi | null,
  kind: PostBodyKind,
  postId: number,
  requests: Partial<Record<PostBodyLocale, ReadPostBodyRequest>>
): Promise<ReadPostBodiesResult> {
  const bodies: Record<PostBodyLocale, string | null> = { en: null, it: null };
  const sources: Partial<Record<PostBodyLocale, PostBodySource>> = {};

  for (const locale of BODY_LOCALES) {
    const request = requests[locale];
    if (!request) continue;

    const legacy = request.legacy ?? null;
    const path = request.path ?? null;

    if (!path) {
      bodies[locale] = legacy;
      sources[locale] = 'legacy';
      continue;
    }

    if (!storage) {
      throw new Error(
        `[body-read] ${path} is referenced but Storage reads are disabled`
      );
    }

    const expectedHash = expectedHashFromPointer(kind, postId, locale, path);
    const bytes = await readBodyContentBytes(storage, path);
    const actualHash = sha256Hex(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(
        `[body-read] integrity failure at ${path}: content hash ${actualHash} does not match the object key`
      );
    }

    const markdown = bytes.toString('utf8');
    if (legacy !== null && legacy !== markdown) {
      throw new Error(
        `[body-read] disagreement at ${path}: stored Markdown differs from the committed legacy body`
      );
    }

    bodies[locale] = markdown;
    sources[locale] = 'storage';
  }

  return { kind, postId, bodies, sources };
}

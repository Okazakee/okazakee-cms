/**
 * Shared orchestration for storing the final EN/IT Markdown of a post as
 * immutable content-addressed objects (Phase 7A; reused by Phase 7B).
 *
 * It sits above the low-level `bodyContent` module and knows nothing about
 * buckets or credentials: the caller passes an already-scoped Storage API
 * (`admin.storage.from(bucket)`). It prepares and uploads only the languages a
 * save actually touches, so a metadata-only update makes no Storage call.
 */
import {
  prepareBodyContent,
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

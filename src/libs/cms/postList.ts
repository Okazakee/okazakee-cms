/**
 * Phase 9B: CMS list reads and the lazy Markdown load gate.
 *
 * Client-safe on purpose (no server or Node imports).
 *
 * The metadata-only list read (`GET_LIST`) plus the authenticated per-post
 * `GET_BODIES` read is the ONLY supported CMS editor path, in EVERY real
 * deployment — production (`public`) and the dev clone (`dev_staging`) alike.
 * It is not opt-in, no environment variable gates it, and no variable has to be
 * set for it to be active.
 *
 * The previous gate ANDed `NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED` with
 * `dev_staging`, which left production on the legacy `select('*')` list read.
 * That read returned the retired `body_en`/`body_it` columns, which Storage-only
 * writes never populate (they stay NULL), so the production editor opened on an
 * EMPTY Markdown body — while the real Markdown sat in Storage. Opening that
 * editor and saving would therefore have destroyed committed content. The gate
 * is gone; the variable is no longer read.
 *
 * A list read resolves no bodies at all (its projection names none of the body
 * or pointer columns), so this predicate stays independent of the per-post
 * Storage read that `GET_BODIES` performs. Demo mode never reaches either path:
 * it renders its own fixtures and is guarded explicitly at each call site.
 */

/**
 * The explicit metadata projections the CMS list actions select.
 *
 * These are the authoritative list contract: every non-body column a list card
 * or editor form needs, and never `body_en`, `body_it`, `body_en_path` or
 * `body_it_path`. `select('*')` is deliberately not used anywhere on this path,
 * so a body can never be loaded by an incidental list read.
 *
 * Every column below exists in BOTH the dev clone and `public` — verified
 * against the live schema, not the type declarations (the `BlogPost` type
 * declares a `title` column that does not exist in either schema, which is why
 * the projection is enumerated explicitly).
 */
export const BLOG_LIST_COLUMNS =
  'id, created_at, title_en, title_it, image, description_en, description_it, blurhashURL, post_tags, views, hidden, author_id';

export const PORTFOLIO_LIST_COLUMNS =
  'id, created_at, title_en, title_it, image, source_link, demo_link, description_en, description_it, blurhashURL, post_tags, store_link, fdroid_link, website, ios_store_link, buttons, views, hidden, author_id';

/**
 * Always `true`, in production and in the dev clone alike.
 *
 * The editors call it to document that they take the metadata-only list path
 * and hydrate Markdown through `GET_BODIES`. It deliberately reads no
 * environment: production sets neither `NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED`
 * nor a dev schema, and must still hydrate its bodies. The regression test in
 * `postList.test.ts` pins that under `public` with the variable unset.
 */
export function bodyLazyLoadEnabled(): boolean {
  return true;
}

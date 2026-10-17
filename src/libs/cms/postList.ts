/**
 * Phase 9B: CMS list reads and the lazy Markdown load gate.
 *
 * Client-safe on purpose (no server or Node imports): client components resolve
 * the gate, and `process.env.NEXT_PUBLIC_*` is inlined by the bundler only when
 * read as a literal — the reason the two variables below are spelled out rather
 * than looked up through a computed key.
 *
 * The lazy path is opt-in and only for the dev clone:
 *   NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED=true
 *   NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging
 *
 * It deliberately does NOT depend on `CMS_BODY_STORAGE_READ_ENABLED`: a
 * metadata-only list and the per-post legacy fallback must work with Storage
 * reads off, and read/write activation stays independently controllable.
 */

export const BODY_LAZY_LOAD_FLAG = 'NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED';

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

export type BodyLazyLoadEnv = {
  /** Raw flag value — active only when exactly `'true'`. */
  enabled: boolean;
  schema: string;
};

/** Pure gate: metadata-only lists require the flag AND the dev clone. */
export function resolveBodyLazyLoad(env: BodyLazyLoadEnv): boolean {
  return env.enabled && env.schema === 'dev_staging';
}

export function bodyLazyLoadEnabled(): boolean {
  return resolveBodyLazyLoad({
    enabled: process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED === 'true',
    schema: process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? 'public',
  });
}

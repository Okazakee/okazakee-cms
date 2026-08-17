/**
 * Public cache-tag vocabulary — the single source of truth for tag names.
 *
 * Used by:
 * - the public read layer (src/utils/getData.ts) via cacheTag();
 * - CMS invalidation descriptors (src/libs/cms/invalidation.ts);
 * - the signed revalidation endpoint (Phase 9) allowlist.
 *
 * Do NOT write tag string literals elsewhere. Adding a tag here extends the
 * public cache contract; keep docs/cms-decoupling/behavior-matrix.md in sync.
 */
export const cacheTags = {
  translations: 'translations',
  privacyPolicy: 'privacy-policy',
  hero: 'hero',
  skills: 'skills',
  career: 'career',
  contacts: 'contacts',
  blog: 'blog',
  portfolio: 'portfolio',
  /** All post lists (blog + portfolio shared listing/search cache). */
  posts: 'posts',
  resume: 'resume',
  heroSection: 'hero_section',
} as const;

/** Entity-specific post detail tag: post:blog:<id> / post:portfolio:<id>. */
export function postDetailTag(
  type: 'blog' | 'portfolio',
  id: number | string
): string {
  return `post:${type}:${id}`;
}

/** Author profile tag: author:<user-id> (embedded in cached post details). */
export function authorTag(id: number | string): string {
  return `author:${id}`;
}

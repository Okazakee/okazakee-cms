/**
 * Canonical CMS Storage prefixes for post assets (server actions and tests).
 *
 * Layout (per post, flat — cover and body assets share the folder so the
 * future post builder has one directory per post to manage):
 * - `blog/<id>/<file>`
 * - `portfolio/<id>/<file>`
 *
 * Creates upload to a staging folder first because the row id does not exist
 * yet (`blog/staging/<file>`, `portfolio/staging/<file>`); the staged object
 * is copied into its per-post folder after the INSERT commits. Anything left
 * in staging is an orphan from a failed create and is safe to delete.
 *
 * Legacy `Website Assets/blog|portfolio|avatars/...` paths are still readable
 * (old rows, old tests) but no new upload may target them. Career logos
 * moved to the root `career/` folder; the legacy `Website Assets/career/`
 * objects were relocated one-to-one.
 */

export const BLOG_ASSET_ROOT = 'blog';

export const PORTFOLIO_ASSET_ROOT = 'portfolio';

export const CAREER_ASSET_ROOT = 'career';

export const BLOG_STAGING_PREFIX = 'blog/staging';

export const PORTFOLIO_STAGING_PREFIX = 'portfolio/staging';

export const AVATAR_ROOT = 'avatars';

export function blogPostPrefix(id: number): string {
  return `${BLOG_ASSET_ROOT}/${id}`;
}

export function portfolioPostPrefix(id: number): string {
  return `${PORTFOLIO_ASSET_ROOT}/${id}`;
}

/**
 * Per-profile avatar folder. Every avatar upload for a profile lands here,
 * so removing a profile can wipe exactly its own objects.
 */
export function avatarPrefixForProfile(profileId: string): string {
  return `${AVATAR_ROOT}/${profileId}`;
}

/**
 * Final resting place of a staged upload once its row id is known. Keeps the
 * staged unique basename (`<timestamp>-<uuid>-<label>.<ext>`) so the copy can
 * never collide with a live object.
 */
export function finalizedPostAssetPath(
  prefix: string,
  stagedPath: string
): string {
  return `${prefix}/${basenameOfStoragePath(stagedPath)}`;
}

export function basenameOfStoragePath(path: string): string {
  const tail = path.split('/').pop() ?? '';
  return tail;
}

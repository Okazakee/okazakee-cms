/**
 * DELETE ME TOGETHER WITH THE LEGACY `body_en` / `body_it` COLUMNS.
 *
 * Temporary rollout shim for the Storage-only Markdown write path. Markdown now
 * lives exclusively as immutable content-addressed objects in the private
 * content bucket and the row holds only the pointer (`body_<locale>_path`), but
 * production still has `body_en NOT NULL` until the schema contraction drops
 * the column pair. While that column exists, an INSERT/UPDATE must carry a
 * value for it:
 *
 *   CMS_LEGACY_BODY_EN_SHIM=false -> stop writing the column (only valid once
 *                                    the columns are gone)
 *   anything else / unset         -> ON (the default until the contraction)
 *
 * The placeholder is deliberately NOT Markdown and is never derived from the
 * post's real content: a legacy reader that still renders `body_en` must show
 * an obviously migrated value rather than a stale copy that could disagree with
 * the committed pointer. `body_it` is NEVER written by the write path (it is
 * nullable, so "leave it as-is" is the safest value); the real body for both
 * locales is the committed object.
 *
 * `legacyBodyEnShimFields()` is the ONLY place allowed to name `body_en` on a
 * write. Removing this file, its call sites and the flag is the whole cleanup
 * step after the columns are dropped.
 */

export const LEGACY_BODY_EN_SHIM_FLAG = 'CMS_LEGACY_BODY_EN_SHIM';

/**
 * Value stored in `body_en` while the NOT NULL column exists. Not valid
 * Markdown on purpose, greppable, and stable so a row's legacy column never
 * churns between saves.
 */
export const LEGACY_BODY_EN_SHIM_PLACEHOLDER =
  '[content moved to object storage]';

/**
 * Legacy-column fields to spread into one INSERT/UPDATE. Empty when the shim is
 * off, so a post-contraction schema (no `body_en`) is written exactly the same
 * way. The environment is injectable so the default-on semantics are testable
 * without touching the process.
 */
export function legacyBodyEnShimFields(
  env: Record<string, string | undefined> = process.env
): Record<string, unknown> {
  return env[LEGACY_BODY_EN_SHIM_FLAG] !== 'false'
    ? { body_en: LEGACY_BODY_EN_SHIM_PLACEHOLDER }
    : {};
}

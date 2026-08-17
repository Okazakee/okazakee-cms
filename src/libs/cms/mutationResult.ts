/**
 * Shared mutation result contract for CMS actions (client-safe: no server or
 * node imports — components import this type/helper directly).
 *
 * A CMS mutation result must express four states:
 * - mutation failed;
 * - mutation succeeded + public-site revalidation sent;
 * - mutation succeeded + public-site revalidation skipped (not configured /
 *   no affected tags);
 * - mutation succeeded + public-site revalidation failed.
 *
 * `success` describes the DATABASE mutation only: a valid committed write is
 * never reported as failed because the cross-app cache propagation failed.
 * The `revalidation` field carries the propagation outcome so the UI can
 * warn without treating the save as failed.
 */
export type RevalidationStatus = 'sent' | 'skipped' | 'failed';

export type MutationResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Outcome of propagating the committed change to the public site cache.
   * Set on successful mutations that attempted propagation:
   * - 'sent':    event accepted by the public site
   * - 'skipped': propagation not configured or no affected tags
   * - 'failed':  DB commit succeeded but the public cache event failed
   */
  revalidation?: RevalidationStatus;
};

export const PUBLIC_CACHE_WARNING =
  'Changes saved, but the public site cache update failed. The live site may show stale content for a few minutes.';

/**
 * Returns a user-facing warning when a successful mutation could not be
 * propagated to the public site cache, or null otherwise.
 */
export function revalidationWarning(
  result: Pick<MutationResult, 'success' | 'revalidation'>
): string | null {
  return result.success && result.revalidation === 'failed'
    ? PUBLIC_CACHE_WARNING
    : null;
}

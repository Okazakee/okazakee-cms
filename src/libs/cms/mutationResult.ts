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
 * Extracts a displayable message from a caught value.
 *
 * Supabase answers a failed query with a plain `{ message, code, details,
 * hint }` object, not an `Error` instance, so `error instanceof Error` alone
 * collapses every database failure into the caller's generic fallback and
 * hides the actual reason (e.g. a column the deployed schema does not have
 * yet). Read `message` structurally instead.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

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

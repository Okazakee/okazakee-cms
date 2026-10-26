/**
 * Pure parsing for the public invitation-confirmation surface.
 *
 * Kept out of the page component so the token-shape rules are unit-testable
 * without a browser. The page reads the live URL once, scrubs it, and passes
 * the already-captured fragments here — no token ever reaches React state,
 * storage or a request until the Server Action validates it again.
 */

export type InviteLinkInput =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  | { kind: 'tokenHash'; tokenHash: string }
  | { kind: 'invalid' };

const MAX_SESSION_TOKEN_LENGTH = 4096;
const MAX_TOKEN_HASH_LENGTH = 512;
const TOKEN_HASH_MIN_LENGTH = 16;
// Opaque base64url/hex credentials only: printable, non-whitespace ASCII.
const PRINTABLE_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function isPlausibleSessionToken(value: string | null): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SESSION_TOKEN_LENGTH &&
    PRINTABLE_TOKEN_PATTERN.test(value)
  );
}

function isPlausibleTokenHash(value: string | null): value is string {
  return (
    typeof value === 'string' &&
    value.length >= TOKEN_HASH_MIN_LENGTH &&
    value.length <= MAX_TOKEN_HASH_LENGTH &&
    PRINTABLE_TOKEN_PATTERN.test(value)
  );
}

function toParams(raw: string, strip: '#' | '?'): URLSearchParams {
  if (raw.startsWith(strip)) return new URLSearchParams(raw.slice(1));
  return new URLSearchParams(raw);
}

/**
 * Classifies an invitation link.
 *
 * - fragment (`#access_token=…&refresh_token=…&type=invite`) is the standard
 *   Supabase invite email; `type` must be absent or `invite`.
 * - `?token_hash=…&type=invite` is the optional custom-template form and
 *   REQUIRES `type=invite` (never recovery/magic-link/email).
 * - provider error fragments (`#error=…`, e.g. expired OTP) are invalid and
 *   their raw description is never rendered.
 */
export function parseInviteLink(hash: string, search: string): InviteLinkInput {
  const fragment = toParams(hash ?? '', '#');

  if (fragment.has('error') || fragment.has('error_description')) {
    return { kind: 'invalid' };
  }

  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');

  if (accessToken !== null || refreshToken !== null) {
    if (
      !isPlausibleSessionToken(accessToken) ||
      !isPlausibleSessionToken(refreshToken)
    ) {
      return { kind: 'invalid' };
    }
    const type = fragment.get('type');
    if (type !== null && type !== 'invite') return { kind: 'invalid' };
    return { kind: 'session', accessToken, refreshToken };
  }

  const query = toParams(search ?? '', '?');
  const tokenHash = query.get('token_hash');

  if (tokenHash !== null) {
    if (query.get('type') !== 'invite') return { kind: 'invalid' };
    if (!isPlausibleTokenHash(tokenHash)) return { kind: 'invalid' };
    return { kind: 'tokenHash', tokenHash };
  }

  return { kind: 'invalid' };
}

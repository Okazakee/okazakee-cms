import { describe, expect, it } from 'vitest';
import { parseInviteLink } from './confirm/parseInviteLink';

/**
 * Invitation-link classification (behavior).
 *
 * The public /auth/confirm page accepts exactly two shapes: the standard
 * Supabase invite fragment (implicit flow, tokens) and the optional
 * `?token_hash=...&type=invite` custom template. Recovery/magic-link/
 * password-reset links are not product scope and must be rejected before any
 * Server Action call.
 */

const accessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
const refreshToken = 'v1.refresh-token-value';
const tokenHash =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

describe('standard Supabase invite fragment', () => {
  it('accepts access_token/refresh_token with type=invite', () => {
    const hash = `#access_token=${accessToken}&expires_at=1790000000&expires_in=3600&refresh_token=${refreshToken}&token_type=bearer&type=invite`;

    expect(parseInviteLink(hash, '')).toEqual({
      kind: 'session',
      accessToken,
      refreshToken,
    });
  });

  it('accepts a fragment without a type parameter', () => {
    const hash = `#access_token=${accessToken}&refresh_token=${refreshToken}`;

    expect(parseInviteLink(hash, '')).toEqual({
      kind: 'session',
      accessToken,
      refreshToken,
    });
  });

  it('accepts the fragment without its leading hash', () => {
    const hash = `access_token=${accessToken}&refresh_token=${refreshToken}`;

    expect(parseInviteLink(hash, '').kind).toBe('session');
  });

  it('rejects non-invite flow types', () => {
    for (const type of ['recovery', 'magiclink', 'signup', 'email_change']) {
      const hash = `#access_token=${accessToken}&refresh_token=${refreshToken}&type=${type}`;
      expect(parseInviteLink(hash, ''), type).toEqual({ kind: 'invalid' });
    }
  });

  it('rejects a partial or malformed token pair', () => {
    expect(parseInviteLink(`#access_token=${accessToken}`, '')).toEqual({
      kind: 'invalid',
    });
    expect(parseInviteLink(`#refresh_token=${refreshToken}`, '')).toEqual({
      kind: 'invalid',
    });
    expect(
      parseInviteLink(`#access_token=${accessToken}&refresh_token=`, '')
    ).toEqual({ kind: 'invalid' });
    expect(
      parseInviteLink(
        `#access_token=${accessToken}&refresh_token=has space`,
        ''
      )
    ).toEqual({ kind: 'invalid' });
    expect(
      parseInviteLink(
        `#access_token=${'a'.repeat(5000)}&refresh_token=${refreshToken}`,
        ''
      )
    ).toEqual({ kind: 'invalid' });
  });

  it('treats an expired-link provider fragment as invalid without exposing it', () => {
    const hash =
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

    expect(parseInviteLink(hash, '')).toEqual({ kind: 'invalid' });
  });
});

describe('token_hash custom template', () => {
  it('accepts token_hash only with type=invite', () => {
    expect(parseInviteLink('', `?token_hash=${tokenHash}&type=invite`)).toEqual(
      { kind: 'tokenHash', tokenHash }
    );
  });

  it('rejects token_hash without the invite type', () => {
    expect(parseInviteLink('', `?token_hash=${tokenHash}`)).toEqual({
      kind: 'invalid',
    });
    for (const type of ['recovery', 'magiclink', 'email', 'signup']) {
      expect(
        parseInviteLink('', `?token_hash=${tokenHash}&type=${type}`),
        type
      ).toEqual({ kind: 'invalid' });
    }
  });

  it('rejects malformed token hashes', () => {
    expect(parseInviteLink('', '?token_hash=short&type=invite')).toEqual({
      kind: 'invalid',
    });
    expect(
      parseInviteLink('', `?token_hash=${'a'.repeat(600)}&type=invite`)
    ).toEqual({ kind: 'invalid' });
  });
});

describe('unusable confirmation links', () => {
  it('rejects an empty URL instead of implying a session', () => {
    expect(parseInviteLink('', '')).toEqual({ kind: 'invalid' });
  });

  it('ignores credentials passed as query parameters', () => {
    expect(
      parseInviteLink(
        '',
        `?access_token=${accessToken}&refresh_token=${refreshToken}&type=invite`
      )
    ).toEqual({ kind: 'invalid' });
  });
});

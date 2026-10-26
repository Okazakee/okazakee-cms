import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Invitation confirmation behavior.
 *
 * The action is the only place invitation credentials meet the allowlist:
 * malformed/expired links must never create a session outcome, denied
 * identities must be signed out, authorized ones sync the profile and hand
 * navigation to the framework (`redirect('/auth/setup')`). Credentials and
 * provider detail never appear in results or logs.
 */

const sampleUser = {
  id: 'invited-user-id',
  email: 'invited@example.com',
  email_confirmed_at: '2026-10-01T09:00:00.000Z',
  app_metadata: { provider: 'email' },
  user_metadata: {},
};

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  findAllowed: vi.fn(),
  syncProfile: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));

vi.mock('@/utils/supabase/server', () => ({
  createClient: h.createClient,
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => ({ from: vi.fn() }),
}));

vi.mock('./utils/auth', () => ({
  findAllowedCmsUser: h.findAllowed,
  getUserGithubId: () => null,
  getUserGithubUsername: () => null,
  getVerifiedUserEmail: (user: { email?: string | null }) => user.email ?? null,
}));

vi.mock('./utils/profileSync', () => ({
  syncCmsUserProfile: h.syncProfile,
}));

import { confirmCmsInvite } from './onboardingActions';

interface AuthResultOverrides {
  /** Result returned by auth.setSession (expired/reused pair cases). */
  setSession?: unknown;
  /** Result returned by auth.verifyOtp (expired OTP cases). */
  verifyOtp?: unknown;
  /** Result returned by auth.getUser (unreadable-session case). */
  getUser?: unknown;
}

function setupAuth(overrides: AuthResultOverrides = {}) {
  const auth = {
    setSession: vi.fn(
      async () =>
        overrides.setSession ?? {
          data: { user: sampleUser, session: { user: sampleUser } },
          error: null,
        }
    ),
    verifyOtp: vi.fn(
      async () =>
        overrides.verifyOtp ?? {
          data: { user: sampleUser, session: { user: sampleUser } },
          error: null,
        }
    ),
    getUser: vi.fn(
      async () =>
        overrides.getUser ?? { data: { user: sampleUser }, error: null }
    ),
    signOut: vi.fn(async () => ({ error: null })),
  };

  h.createClient.mockResolvedValue({ auth });
  return auth;
}

beforeEach(() => {
  h.createClient.mockReset();
  h.findAllowed.mockReset();
  h.findAllowed.mockResolvedValue({ role: 'editor', matchSource: 'email' });
  h.syncProfile.mockReset();
  h.syncProfile.mockResolvedValue(undefined);
  h.redirect.mockReset();
  // Mirrors next/navigation: redirect() throws NEXT_REDIRECT (control flow).
  h.redirect.mockImplementation((path: string): never => {
    throw new Error(`NEXT_REDIRECT;replace;${path}`);
  });
});

describe('malformed invitation input', () => {
  it('rejects unusable token shapes without touching Supabase', async () => {
    const cases = [
      { tokenHash: '' },
      { tokenHash: 'short' },
      { tokenHash: 'a'.repeat(600) },
      { accessToken: '', refreshToken: '' },
      { accessToken: 'has space', refreshToken: 'refresh-token' },
      { accessToken: 'x'.repeat(5000), refreshToken: 'refresh-token' },
    ];

    for (const input of cases) {
      await expect(confirmCmsInvite(input)).resolves.toEqual({
        status: 'invalid-link',
      });
    }

    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe('implicit fragment confirmation', () => {
  it('sets the session, re-reads the user, syncs the profile and redirects to setup', async () => {
    const auth = setupAuth();

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
    });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    expect(h.findAllowed).toHaveBeenCalledWith(expect.anything(), {
      email: sampleUser.email,
      githubUserId: null,
      githubUsernameLegacy: null,
    });
    expect(h.syncProfile).toHaveBeenCalledWith(sampleUser);
    expect(h.redirect).toHaveBeenCalledWith('/auth/setup');
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('treats an expired or reused pair as an invalid link without a session outcome', async () => {
    const auth = setupAuth({
      setSession: {
        data: { user: null, session: null },
        error: {
          code: 'refresh_token_not_found',
          message: 'Invalid Refresh Token: Refresh Token Not Found',
        },
      },
    });

    await expect(
      confirmCmsInvite({
        accessToken: 'expired-access',
        refreshToken: 'expired-refresh',
      })
    ).resolves.toEqual({ status: 'invalid-link' });

    expect(auth.getUser).not.toHaveBeenCalled();
    expect(h.findAllowed).not.toHaveBeenCalled();
    expect(h.syncProfile).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe('token_hash confirmation', () => {
  it('verifies ONLY the invite OTP type and completes the flow', async () => {
    const auth = setupAuth();
    const tokenHash = 'abcdef0123456789abcdef0123456789';

    await expect(confirmCmsInvite({ tokenHash })).rejects.toThrow(
      'NEXT_REDIRECT'
    );

    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: tokenHash,
      type: 'invite',
    });
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(h.redirect).toHaveBeenCalledWith('/auth/setup');
  });

  it('rejects an expired OTP as an invalid link', async () => {
    const auth = setupAuth({
      verifyOtp: {
        data: { user: null, session: null },
        error: { code: 'otp_expired', message: 'Token has expired' },
      },
    });

    await expect(
      confirmCmsInvite({ tokenHash: 'abcdef0123456789abcdef0123456789' })
    ).resolves.toEqual({ status: 'invalid-link' });

    expect(auth.getUser).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('clears the OTP session when onboarding fails after verification', async () => {
    const auth = setupAuth();
    h.syncProfile.mockRejectedValue(new Error('profile write failed'));

    await expect(
      confirmCmsInvite({ tokenHash: 'abcdef0123456789abcdef0123456789' })
    ).resolves.toEqual({ status: 'failed' });

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe('allowlist enforcement', () => {
  it('signs a denied identity out and never syncs or navigates', async () => {
    const auth = setupAuth();
    h.findAllowed.mockResolvedValue(null);

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).resolves.toEqual({ status: 'unauthorized' });

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(h.syncProfile).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('clears a session that cannot be re-read', async () => {
    const auth = setupAuth({
      getUser: {
        data: { user: null },
        error: { code: 'session_not_found', message: 'Session not found' },
      },
    });

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).resolves.toEqual({ status: 'invalid-link' });

    expect(h.findAllowed).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('clears the session when the session re-read throws', async () => {
    const auth = setupAuth();
    auth.getUser.mockRejectedValue(new Error('auth endpoint unavailable'));

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).resolves.toEqual({ status: 'failed' });

    expect(h.findAllowed).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('orders session establishment before the allowlist decision', async () => {
    const auth = setupAuth();
    h.findAllowed.mockResolvedValue(null);

    await confirmCmsInvite({
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
    });

    expect(auth.setSession.mock.invocationCallOrder[0]).toBeLessThan(
      auth.getUser.mock.invocationCallOrder[0]
    );
    expect(auth.getUser.mock.invocationCallOrder[0]).toBeLessThan(
      h.findAllowed.mock.invocationCallOrder[0]
    );
    expect(h.findAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      auth.signOut.mock.invocationCallOrder[0]
    );
  });

  it('clears the session when profile sync throws after the handshake', async () => {
    const auth = setupAuth();
    h.syncProfile.mockRejectedValue(new Error('profile write failed'));

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).resolves.toEqual({ status: 'failed' });

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('clears the session when the allowlist lookup throws after the handshake', async () => {
    const auth = setupAuth();
    h.findAllowed.mockRejectedValue(new Error('allowlist read failed'));

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).resolves.toEqual({ status: 'failed' });

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(h.syncProfile).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('returns a failure result even if clearing the session also fails', async () => {
    const auth = setupAuth();
    auth.signOut.mockRejectedValue(new Error('sign-out unavailable'));
    h.syncProfile.mockRejectedValue(new Error('profile write failed'));

    await expect(
      confirmCmsInvite({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      })
    ).resolves.toEqual({ status: 'failed' });

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe('credential hygiene', () => {
  it('never logs tokens or provider errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupAuth();

    await expect(
      confirmCmsInvite({
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
      })
    ).rejects.toThrow('NEXT_REDIRECT');

    // Failure paths surface provider detail just as little as success paths.
    h.syncProfile.mockRejectedValue(
      new Error('provider rejected secret-refresh-token')
    );

    await expect(
      confirmCmsInvite({
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
      })
    ).resolves.toEqual({ status: 'failed' });

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    log.mockRestore();
    error.mockRestore();
  });
});

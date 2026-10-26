import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Invitation helper behavior: the caller owns allowlist/permission rows, so
 * this module's whole contract is "send exactly one Supabase email to the
 * canonical confirm URL, classify the result, never leak provider detail".
 */

const h = vi.hoisted(() => ({
  cmsPublicUrl: 'https://cms.example.com',
  inviteUserByEmail: vi.fn(),
}));

vi.mock('@/config/cms', () => ({
  cmsConfig: {
    get cmsPublicUrl() {
      return h.cmsPublicUrl;
    },
  },
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => ({
    auth: {
      admin: { inviteUserByEmail: h.inviteUserByEmail },
    },
  }),
}));

import {
  buildCmsInviteRedirectTo,
  getCanonicalCmsOrigin,
  isExistingAccountInviteError,
  sendCmsInvitation,
} from './invite';

const invitedAt = '2026-10-01T09:30:00.000Z';

beforeEach(() => {
  h.cmsPublicUrl = 'https://cms.example.com';
  h.inviteUserByEmail.mockReset();
  h.inviteUserByEmail.mockResolvedValue({
    data: { user: { id: 'invited-user', invited_at: invitedAt } },
    error: null,
  });
});

describe('canonical origin', () => {
  it('normalizes a configured origin with a trailing slash', () => {
    h.cmsPublicUrl = 'https://cms.example.com/';
    expect(getCanonicalCmsOrigin()).toBe('https://cms.example.com');
    expect(buildCmsInviteRedirectTo('https://cms.example.com')).toBe(
      'https://cms.example.com/auth/confirm'
    );
  });

  it('rejects a missing, malformed or non-origin value', () => {
    for (const value of [
      '',
      '   ',
      'not a url',
      'ftp://cms.example.com',
      'https://user:pass@cms.example.com',
      'https://cms.example.com/cms',
      'https://cms.example.com/?next=x',
    ]) {
      h.cmsPublicUrl = value;
      expect(getCanonicalCmsOrigin(), value).toBeNull();
    }
  });
});

describe('sendCmsInvitation', () => {
  it('normalizes the address and sends one invite to the canonical confirm URL', async () => {
    const result = await sendCmsInvitation('  New.User@Example.COM  ');

    expect(h.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(h.inviteUserByEmail).toHaveBeenCalledWith('new.user@example.com', {
      redirectTo: 'https://cms.example.com/auth/confirm',
    });
    expect(result).toEqual({ status: 'sent', invitedAt });
  });

  it('falls back to the current time when the provider omits invited_at', async () => {
    h.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: 'invited-user' } },
      error: null,
    });

    const result = await sendCmsInvitation('new.user@example.com');

    expect(result.status).toBe('sent');
    expect(typeof result.invitedAt).toBe('string');
    expect(Number.isNaN(Date.parse(result.invitedAt ?? ''))).toBe(false);
  });

  it('reports an existing Auth account explicitly instead of a fake success', async () => {
    h.inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        code: 'email_exists',
        message: 'A user with this email address has already been registered',
      },
    });

    const result = await sendCmsInvitation('existing@example.com');

    expect(result).toEqual({ status: 'existing-account' });
  });

  it('detects older deployments that only return the message', async () => {
    h.inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { message: 'User already registered' },
    });

    const result = await sendCmsInvitation('existing@example.com');

    expect(result.status).toBe('existing-account');
  });

  it('maps provider failures to a fixed message without provider detail', async () => {
    h.inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        code: 'unexpected_failure',
        message: 'smtp rejected message; server-key=super-secret',
      },
    });

    const result = await sendCmsInvitation('new.user@example.com');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Failed to send the invitation email');
    expect(result.error).not.toContain('smtp');
    expect(result.error).not.toContain('super-secret');
  });

  it('never throws when the provider call rejects', async () => {
    h.inviteUserByEmail.mockRejectedValue(new Error('socket hang up'));

    await expect(sendCmsInvitation('new.user@example.com')).resolves.toEqual({
      status: 'failed',
      error: 'Failed to send the invitation email',
    });
  });

  it('rejects a malformed address before calling Supabase', async () => {
    for (const email of [
      '',
      '   ',
      'not-an-email',
      `${'a'.repeat(250)}@x.io`,
    ]) {
      await expect(sendCmsInvitation(email)).resolves.toEqual({
        status: 'failed',
        error: 'Please enter a valid email address',
      });
    }
    expect(h.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('fails clearly when CMS_PUBLIC_URL is not a usable canonical origin', async () => {
    h.cmsPublicUrl = '';

    await expect(sendCmsInvitation('new.user@example.com')).resolves.toEqual({
      status: 'failed',
      error: 'CMS_PUBLIC_URL is not configured correctly',
    });
    expect(h.inviteUserByEmail).not.toHaveBeenCalled();
  });
});

describe('isExistingAccountInviteError', () => {
  it('ignores empty/invalid error values', () => {
    expect(isExistingAccountInviteError(null)).toBe(false);
    expect(isExistingAccountInviteError(undefined)).toBe(false);
    expect(isExistingAccountInviteError('email_exists')).toBe(false);
    expect(isExistingAccountInviteError({ code: 'bad_jwt' })).toBe(false);
  });
});

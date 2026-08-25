import { describe, expect, it } from 'vitest';
import {
  isPasskeyChallengeFresh,
  requirePasskeyMediation,
  withKnownPasskeyCredentials,
} from '@/utils/supabase/passkeys';

describe('isPasskeyChallengeFresh', () => {
  it('reserves time to obtain a replacement challenge', () => {
    const now = 1_000_000;

    expect(isPasskeyChallengeFresh(1_011, now)).toBe(true);
    expect(isPasskeyChallengeFresh(1_010, now)).toBe(false);
  });
});

describe('withKnownPasskeyCredentials', () => {
  it('adds local credential ids without mutating server options', () => {
    const options = {
      challenge: 'challenge',
      rpId: 'cms.okazakee.dev',
      userVerification: 'preferred' as const,
    };

    const result = withKnownPasskeyCredentials(options, ['credential-id']);

    expect(result.allowCredentials).toEqual([
      { id: 'credential-id', type: 'public-key' },
    ]);
    expect(options).not.toHaveProperty('allowCredentials');
  });
});

describe('requirePasskeyMediation', () => {
  it('uses a modal request for an explicit sign-in button', () => {
    const publicKey = {
      challenge: new ArrayBuffer(0),
      rpId: 'cms.okazakee.dev',
      userVerification: 'required' as const,
    };

    const request = requirePasskeyMediation(publicKey);

    expect(request.mediation).toBe('required');
    expect(request.publicKey).toBe(publicKey);
  });
});

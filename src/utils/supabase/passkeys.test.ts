import { describe, expect, it } from 'vitest';
import { requirePasskeyMediation } from '@/utils/supabase/passkeys';

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

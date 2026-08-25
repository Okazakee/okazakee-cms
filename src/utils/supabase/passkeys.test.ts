import { describe, expect, it } from 'vitest';
import { requireDiscoverablePasskey } from '@/utils/supabase/passkeys';

const registrationOptions = {
  challenge: 'challenge',
  rp: { id: 'cms.okazakee.dev', name: 'Okazakee CMS' },
  user: {
    displayName: 'CMS user',
    id: 'user-id',
    name: 'cms@example.com',
  },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' as const }],
};

describe('requireDiscoverablePasskey', () => {
  it('requires a discoverable credential without mutating server options', () => {
    const result = requireDiscoverablePasskey(registrationOptions);

    expect(result.authenticatorSelection).toEqual({
      requireResidentKey: true,
      residentKey: 'required',
    });
    expect(registrationOptions).not.toHaveProperty('authenticatorSelection');
  });
});

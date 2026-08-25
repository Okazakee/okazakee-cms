import type { AuthPasskeyRegistrationVerifyResponse } from '@supabase/auth-js';
import {
  createCredential,
  deserializeCredentialCreationOptions,
  serializeCredentialCreationResponse,
} from '@supabase/auth-js/dist/module/lib/webauthn';
import type { SupabaseClient } from '@supabase/supabase-js';

type PasskeyAuth = Pick<SupabaseClient['auth'], 'passkey'>;
type RegistrationOptions = Parameters<
  typeof deserializeCredentialCreationOptions
>[0];

export function requireDiscoverablePasskey(
  options: RegistrationOptions
): RegistrationOptions {
  return {
    ...options,
    authenticatorSelection: {
      ...options.authenticatorSelection,
      residentKey: 'required',
      requireResidentKey: true,
    },
  };
}

export async function registerDiscoverablePasskey(
  auth: PasskeyAuth
): Promise<AuthPasskeyRegistrationVerifyResponse> {
  const { data, error } = await auth.passkey.startRegistration();
  if (error) return { data: null, error };
  if (!data) throw new Error('Passkey registration options are missing');

  const { data: credential, error: credentialError } = await createCredential({
    publicKey: deserializeCredentialCreationOptions(
      requireDiscoverablePasskey(data.options)
    ),
  });

  if (credentialError) return { data: null, error: credentialError };
  if (!credential) {
    throw new Error(
      'Passkey registration did not return a public-key credential'
    );
  }

  return auth.passkey.verifyRegistration({
    challengeId: data.challenge_id,
    credential: serializeCredentialCreationResponse(credential),
  });
}

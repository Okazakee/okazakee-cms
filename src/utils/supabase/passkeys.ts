import type { AuthPasskeyAuthenticationVerifyResponse } from '@supabase/auth-js';
import {
  deserializeCredentialRequestOptions,
  getCredential,
  serializeCredentialRequestResponse,
} from '@supabase/auth-js/dist/module/lib/webauthn';
import type { SupabaseClient } from '@supabase/supabase-js';

type PasskeyAuth = Pick<SupabaseClient['auth'], 'passkey'>;
type PasskeyCredentialRequest = Parameters<typeof getCredential>[0];

export function requirePasskeyMediation(
  publicKey: PasskeyCredentialRequest['publicKey']
): PasskeyCredentialRequest {
  return { mediation: 'required', publicKey };
}

export async function signInWithRequiredPasskeyMediation(
  auth: PasskeyAuth
): Promise<AuthPasskeyAuthenticationVerifyResponse> {
  const { data, error } = await auth.passkey.startAuthentication();
  if (error) return { data: null, error };
  if (!data) throw new Error('Passkey authentication options are missing');

  const { data: credential, error: credentialError } = await getCredential(
    requirePasskeyMediation(deserializeCredentialRequestOptions(data.options))
  );

  if (credentialError) return { data: null, error: credentialError };
  if (!credential) {
    throw new Error('Passkey authentication did not return a credential');
  }

  return auth.passkey.verifyAuthentication({
    challengeId: data.challenge_id,
    credential: serializeCredentialRequestResponse(credential),
  });
}

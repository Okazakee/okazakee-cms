import type { AuthPasskeyAuthenticationVerifyResponse } from '@supabase/auth-js';
import {
  deserializeCredentialRequestOptions,
  getCredential,
  serializeCredentialRequestResponse,
} from '@supabase/auth-js/dist/module/lib/webauthn';
import type { SupabaseClient } from '@supabase/supabase-js';

type PasskeyAuth = Pick<SupabaseClient['auth'], 'passkey'>;
type PasskeyCredentialRequest = Parameters<typeof getCredential>[0];
type PasskeyOptions = Parameters<typeof deserializeCredentialRequestOptions>[0];
type PasskeyCredential = Parameters<
  typeof serializeCredentialRequestResponse
>[0];

export function isPasskeyChallengeFresh(
  expiresAt: number,
  now: number = Date.now()
): boolean {
  return expiresAt * 1000 > now + 10_000;
}

export function requirePasskeyMediation(
  publicKey: PasskeyCredentialRequest['publicKey']
): PasskeyCredentialRequest {
  return { mediation: 'required', publicKey };
}

export function getPasskeyAssertion(options: PasskeyOptions) {
  return getCredential(
    requirePasskeyMediation(deserializeCredentialRequestOptions(options))
  );
}

export async function verifyPasskeyAssertion(
  auth: PasskeyAuth,
  challengeId: string,
  credential: PasskeyCredential
): Promise<AuthPasskeyAuthenticationVerifyResponse> {
  return auth.passkey.verifyAuthentication({
    challengeId,
    credential: serializeCredentialRequestResponse(credential),
  });
}

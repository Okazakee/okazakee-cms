import type {
  AuthPasskeyAuthenticationVerifyResponse,
  AuthPasskeyRegistrationVerifyResponse,
} from '@supabase/auth-js';
import {
  createCredential,
  deserializeCredentialCreationOptions,
  deserializeCredentialRequestOptions,
  getCredential,
  serializeCredentialCreationResponse,
  serializeCredentialRequestResponse,
} from '@supabase/auth-js/dist/module/lib/webauthn';
import type { SupabaseClient } from '@supabase/supabase-js';

const passkeyCredentialIdsKey = 'cms_passkey_credential_ids';

type PasskeyAuth = Pick<SupabaseClient['auth'], 'passkey'>;
type PasskeyCredentialRequest = Parameters<typeof getCredential>[0];
type PasskeyOptions = Parameters<typeof deserializeCredentialRequestOptions>[0];
type PasskeyCredential = Parameters<
  typeof serializeCredentialRequestResponse
>[0];

function getKnownPasskeyCredentialIds(): string[] {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(passkeyCredentialIdsKey) ?? '[]'
    ) as unknown;
    if (!Array.isArray(stored)) return [];

    return [
      ...new Set(
        stored.filter(
          (credentialId): credentialId is string =>
            typeof credentialId === 'string' &&
            /^[A-Za-z0-9_-]+$/.test(credentialId)
        )
      ),
    ].slice(0, 10);
  } catch {
    return [];
  }
}

function rememberPasskeyCredentialId(credentialId: string): void {
  try {
    window.localStorage.setItem(
      passkeyCredentialIdsKey,
      JSON.stringify([
        ...new Set([...getKnownPasskeyCredentialIds(), credentialId]),
      ])
    );
  } catch {
    // Registration remains valid when local storage is unavailable.
  }
}

export function isPasskeyChallengeFresh(
  expiresAt: number,
  now: number = Date.now()
): boolean {
  return expiresAt * 1000 > now + 10_000;
}

export function withKnownPasskeyCredentials(
  options: PasskeyOptions,
  credentialIds: string[]
): PasskeyOptions {
  if (credentialIds.length === 0) return options;

  return {
    ...options,
    allowCredentials: credentialIds.map((id) => ({
      id,
      type: 'public-key',
    })),
  };
}

export function requirePasskeyMediation(
  publicKey: PasskeyCredentialRequest['publicKey']
): PasskeyCredentialRequest {
  return { mediation: 'required', publicKey };
}

export function getPasskeyAssertion(options: PasskeyOptions) {
  return getCredential(
    requirePasskeyMediation(
      deserializeCredentialRequestOptions(
        withKnownPasskeyCredentials(options, getKnownPasskeyCredentialIds())
      )
    )
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

export async function registerPasskeyAndRememberCredential(
  auth: PasskeyAuth
): Promise<AuthPasskeyRegistrationVerifyResponse> {
  const { data, error } = await auth.passkey.startRegistration();
  if (error) return { data: null, error };
  if (!data) throw new Error('Passkey registration options are missing');

  const { data: credential, error: credentialError } = await createCredential({
    publicKey: deserializeCredentialCreationOptions(data.options),
  });
  if (credentialError) return { data: null, error: credentialError };
  if (!credential) {
    throw new Error(
      'Passkey registration did not return a public-key credential'
    );
  }

  const result = await auth.passkey.verifyRegistration({
    challengeId: data.challenge_id,
    credential: serializeCredentialCreationResponse(credential),
  });
  if (!result.error) rememberPasskeyCredentialId(credential.id);

  return result;
}

/**
 * Isolated fixture — real local GoTrue sessions.
 *
 * Creates the allowlisted admin/editor (and one non-allowlisted outsider)
 * inside the throwaway GoTrue instance, signs in with the password grant, and
 * serialises the resulting session into the exact @supabase/ssr cookie format
 * so a browser can start authenticated without going through GitHub OAuth.
 *
 * Token values are never logged. Cookie files are written with mode 0o600.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { testAccounts } from './config.mjs';

const MAX_CHUNK_SIZE = 3180;

export function createAdminClient(status) {
  return createClient(status.apiUrl, status.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function createAnonClient(status) {
  return createClient(status.apiUrl, status.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function ensureTestUsers(status, log) {
  const admin = createAdminClient(status);
  const created = [];
  for (const account of testAccounts) {
    const existing = await findUserByEmail(admin, account.email);
    if (existing) {
      created.push(existing);
      continue;
    }
    const { data, error } = await admin.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: true,
      user_metadata: {
        user_name: account.githubUsername,
        full_name: account.displayName,
      },
    });
    if (error) {
      throw new Error(`failed to create ${account.key}: ${error.message}`);
    }
    created.push(data.user);
  }
  // The baseline trigger inserts user_profiles; make sure GitHub usernames
  // match the allowlist even if a user predates the trigger.
  for (const account of testAccounts) {
    if (!account.githubUsername) continue;
    await admin
      .from('user_profiles')
      .update({ github_username: account.githubUsername })
      .eq('email', account.email);
  }
  log?.info(`GoTrue users ready (${created.length})`);
  return created;
}

async function findUserByEmail(admin, email) {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`failed to list users: ${error.message}`);
  return data.users.find((user) => user.email === email) ?? null;
}

export function accountByKey(key) {
  return testAccounts.find((account) => account.key === key) ?? null;
}

export function authStorageKey(supabaseUrl) {
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  return `sb-${ref}-auth-token`;
}

export function encodeSessionCookieValue(session) {
  const json = JSON.stringify(session);
  const base64url = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `base64-${base64url}`;
}

/** Faithful port of @supabase/ssr's createChunks (MAX_CHUNK_SIZE = 3180). */
export function createChunks(key, value) {
  let encodedValue = encodeURIComponent(value);
  if (encodedValue.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }];
  }
  const chunks = [];
  while (encodedValue.length > 0) {
    let encodedChunkHead = encodedValue.slice(0, MAX_CHUNK_SIZE);
    const lastEscapePos = encodedChunkHead.lastIndexOf('%');
    if (lastEscapePos > MAX_CHUNK_SIZE - 3) {
      encodedChunkHead = encodedChunkHead.slice(0, lastEscapePos);
    }
    let valueHead = '';
    while (encodedChunkHead.length > 0) {
      try {
        valueHead = decodeURIComponent(encodedChunkHead);
        break;
      } catch (error) {
        if (
          error instanceof URIError &&
          encodedChunkHead.at(-3) === '%' &&
          encodedChunkHead.length > 3
        ) {
          encodedChunkHead = encodedChunkHead.slice(
            0,
            encodedChunkHead.length - 3
          );
        } else {
          throw error;
        }
      }
    }
    chunks.push(valueHead);
    encodedValue = encodedValue.slice(encodedChunkHead.length);
  }
  return chunks.map((value, i) => ({ name: `${key}.${i}`, value }));
}

/**
 * Serialises a Supabase session into cookie pairs. Returns
 * [{ name, value }] ready to be written as Set-Cookie headers.
 */
export function buildSessionCookies({ supabaseUrl, session }) {
  const key = authStorageKey(supabaseUrl);
  const encoded = encodeSessionCookieValue(session);
  return createChunks(key, encoded);
}

export function serializeCookieHeader({ name, value }) {
  const encodedName = encodeURIComponent(name);
  const encodedValue = encodeURIComponent(value);
  return `${encodedName}=${encodedValue}; Path=/; HttpOnly; SameSite=Lax`;
}

/** Mints a session for an account and returns the cookie pairs. */
export async function mintSessionCookies(status, account) {
  const anon = createAnonClient(status);
  const { data, error } = await anon.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) {
    throw new Error(`sign-in failed for ${account.key}: ${error.message}`);
  }
  return {
    cookies: buildSessionCookies({
      supabaseUrl: status.apiUrl,
      session: data.session,
    }),
    userId: data.user.id,
  };
}

/** Persists cookie pairs to a 0600 file and returns its path. */
export async function writeSessionFile(sessionsDir, key, cookies) {
  await mkdir(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, `${key}.cookie`);
  const content = cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  await writeFile(file, content, { mode: 0o600 });
  return file;
}

/** Returns a redacted representation safe for logs. */
export function describeCookies(cookies) {
  return cookies.map((cookie) => cookie.name).join(', ');
}

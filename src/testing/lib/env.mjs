/**
 * Isolated fixture — environment building and loopback safety assertions.
 *
 * The fixture must never be able to talk to the production Supabase project,
 * the production public site, or the production revalidation endpoint. Every
 * URL this module emits is validated as loopback before the Next dev server
 * is spawned.
 */
import { loopbackHosts } from './config.mjs';

/** Env var names that the fixture forces to loopback values. */
export const managedEnvKeys = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'WEBSITE_REVALIDATION_URL',
  'WEBSITE_REVALIDATION_SECRET',
  'NEXT_PUBLIC_SITE_URL',
  'CMS_PUBLIC_URL',
  'APP_ENV',
  'CMS_ISOLATED_TEST',
  'CMS_AUTH_DEBUG',
  'CONTENT_ENFORCE_PUBLISH_DATE',
  'NODE_ENV',
];

export function hostnameOf(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

export function isLoopbackUrl(raw) {
  const hostname = hostnameOf(raw);
  return hostname !== null && loopbackHosts.has(hostname);
}

export function assertLoopbackUrl(name, raw) {
  if (!raw) {
    throw new Error(`[isolated] ${name} is required`);
  }
  if (!isLoopbackUrl(raw)) {
    throw new Error(
      `[isolated] refusing non-loopback ${name}: ${shortenUrl(raw)}`
    );
  }
  return raw;
}

export function assertNonProdEnv(env) {
  if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
    throw new Error(
      '[isolated] refusing to run with production environment semantics'
    );
  }
}

/**
 * Produces the full environment for the Next dev server. All Supabase /
 * revalidation / site variables are overwritten with loopback values; any
 * inherited production values are dropped, not merged.
 */
/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.baseEnv]
 * @param {string} options.supabaseUrl
 * @param {string} options.publishableKey
 * @param {string} options.secretKey
 * @param {string} options.revalidationUrl
 * @param {string} options.revalidationSecret
 * @param {string} options.nextUrl
 * @param {Record<string, string | undefined>} [options.parentEnv]
 */
export function buildIsolatedEnv({
  baseEnv = process.env,
  supabaseUrl,
  publishableKey,
  secretKey,
  revalidationUrl,
  revalidationSecret,
  nextUrl,
  parentEnv = {},
} = {}) {
  // Refuse an explicit production intent rather than silently masking it.
  assertNonProdEnv({ ...baseEnv, ...parentEnv });

  const env = { ...baseEnv };

  // Drop ambient values the fixture owns so a caller's shell can never leak
  // prod credentials into the spawned process.
  for (const key of managedEnvKeys) {
    delete env[key];
  }

  // Extra caller-supplied (non-managed) variables.
  Object.assign(env, parentEnv);

  // Managed values are authoritative and always loopback/non-prod.
  env.NEXT_PUBLIC_SUPABASE_URL = assertLoopbackUrl(
    'NEXT_PUBLIC_SUPABASE_URL',
    supabaseUrl
  );
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  env.SUPABASE_SECRET_KEY = secretKey;
  env.WEBSITE_REVALIDATION_URL = assertLoopbackUrl(
    'WEBSITE_REVALIDATION_URL',
    revalidationUrl
  );
  env.WEBSITE_REVALIDATION_SECRET = revalidationSecret;
  env.NEXT_PUBLIC_SITE_URL = assertLoopbackUrl('NEXT_PUBLIC_SITE_URL', nextUrl);
  env.CMS_PUBLIC_URL = nextUrl;
  env.APP_ENV = 'development';
  env.NODE_ENV = 'development';
  env.CMS_ISOLATED_TEST = '1';
  env.CMS_AUTH_DEBUG = 'true';
  env.CONTENT_ENFORCE_PUBLISH_DATE = 'false';
  env.PORT = String(new URL(nextUrl).port || 80);
  return env;
}

function shortenUrl(raw) {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '<unparseable>';
  }
}

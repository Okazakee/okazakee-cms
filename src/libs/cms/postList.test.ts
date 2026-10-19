import { afterEach, expect, it, vi } from 'vitest';
import { bodyLazyLoadEnabled } from '@/libs/cms/postList';

/**
 * The production regression this file guards.
 *
 * The gate used to be `NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED === 'true' &&
 * schema === 'dev_staging'`. Production runs schema `public` and does NOT set
 * that variable, so the gate was false there and the editors fell back to the
 * legacy `select('*')` list read — which returns the retired `body_en`/`body_it`
 * columns, i.e. NULL for everything written since Storage became the only body
 * store. The production editor therefore opened EMPTY, and saving it would have
 * destroyed the real Markdown.
 *
 * The gate is now unconditional in every real deployment.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

it('is enabled in production (schema `public`) with no flag set', () => {
  vi.unstubAllEnvs();
  delete process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
  vi.stubEnv('APP_ENV', 'production');
  expect(process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED).toBeUndefined();

  expect(bodyLazyLoadEnabled()).toBe(true);
});

it('is enabled when neither the flag nor a schema is configured', () => {
  vi.unstubAllEnvs();
  delete process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED;
  const schema = process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA;
  const appEnv = process.env.APP_ENV;
  delete process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA;
  delete process.env.APP_ENV;

  try {
    expect(bodyLazyLoadEnabled()).toBe(true);
  } finally {
    if (schema !== undefined)
      process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA = schema;
    if (appEnv !== undefined) process.env.APP_ENV = appEnv;
  }
});

it('is enabled in the dev clone (schema `dev_staging`)', () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');

  expect(bodyLazyLoadEnabled()).toBe(true);
});

it('ignores the retired flag, including an explicit `false`', () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
  for (const value of ['true', 'false', '', '0']) {
    vi.stubEnv('NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED', value);
    expect(bodyLazyLoadEnabled()).toBe(true);
  }
});

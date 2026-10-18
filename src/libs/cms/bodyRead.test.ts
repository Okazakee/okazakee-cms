import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_STORAGE_READ_FLAG,
  bodyPointerColumnsReadable,
  currentBodyStorageRead,
  resolveBodyStorageRead,
} from '@/libs/cms/bodyRead';

/**
 * Phase 9A read gate. Pure resolution is exercised directly; the environment
 * wrapper through `vi.stubEnv`, so the decision is proven both ways.
 */
describe('resolveBodyStorageRead', () => {
  it('is disabled by default, whatever the environment', () => {
    expect(
      resolveBodyStorageRead({
        enabled: false,
        appEnv: 'development',
        schema: 'dev_staging',
      })
    ).toEqual({ mode: 'disabled' });
    expect(
      resolveBodyStorageRead({
        enabled: false,
        appEnv: 'production',
        schema: 'public',
      })
    ).toEqual({ mode: 'disabled' });
  });

  it('enables the dev clone against the private dev content bucket', () => {
    expect(
      resolveBodyStorageRead({
        enabled: true,
        appEnv: 'development',
        schema: 'dev_staging',
      })
    ).toEqual({ mode: 'enabled', bucket: 'website-content-dev' });
  });

  it('enables the production bucket for production+public', () => {
    expect(
      resolveBodyStorageRead({
        enabled: true,
        appEnv: 'production',
        schema: 'public',
      })
    ).toEqual({ mode: 'enabled', bucket: 'website-content' });
  });

  it('rejects a production env pointed at the dev clone schema', () => {
    const decision = resolveBodyStorageRead({
      enabled: true,
      appEnv: 'production',
      schema: 'dev_staging',
    });
    expect(decision.mode).toBe('invalid');
    expect(decision.mode === 'invalid' ? decision.error : '').toContain(
      'refusing to resolve a content bucket'
    );
  });

  it('rejects enablement outside the dev clone schema', () => {
    const decision = resolveBodyStorageRead({
      enabled: true,
      appEnv: 'development',
      schema: 'public',
    });
    expect(decision.mode).toBe('invalid');
    expect(decision.mode === 'invalid' ? decision.error : '').toContain(
      'refusing to resolve a content bucket'
    );
  });

  it('lets only the enabled dev clone name the pointer columns', () => {
    expect(bodyPointerColumnsReadable({ mode: 'enabled', bucket: 'b' })).toBe(
      true
    );
    expect(bodyPointerColumnsReadable({ mode: 'disabled' })).toBe(false);
    expect(
      bodyPointerColumnsReadable({ mode: 'invalid', error: 'nope' })
    ).toBe(false);
  });
});

describe('currentBodyStorageRead', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.APP_ENV;
  });

  it('stays disabled when the flag is absent in a valid dev clone', () => {
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    expect(currentBodyStorageRead()).toEqual({ mode: 'disabled' });
  });

  it('enables only when the flag is exactly "true"', () => {
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'TRUE');
    expect(currentBodyStorageRead().mode).toBe('disabled');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, '1');
    expect(currentBodyStorageRead().mode).toBe('disabled');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    expect(currentBodyStorageRead().mode).toBe('enabled');
  });

  it('falls back to the default schema, which is never the dev clone', () => {
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    delete process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA;
    expect(currentBodyStorageRead().mode).toBe('invalid');
  });

  it('derives production semantics from NODE_ENV when APP_ENV is unset', () => {
    delete process.env.APP_ENV;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    // NODE_ENV=production resolves production semantics, so the public schema
    // enables reads against the PRODUCTION bucket — never the dev one.
    expect(currentBodyStorageRead()).toEqual({
      mode: 'enabled',
      bucket: 'website-content',
    });
  });

  it('is independent of the dual-write flag in both directions', () => {
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');

    // Writing to Storage does not switch the readers.
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    expect(currentBodyStorageRead().mode).toBe('disabled');

    // Reading from Storage does not switch the writers.
    vi.unstubAllEnvs();
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
    vi.stubEnv(BODY_STORAGE_READ_FLAG, 'true');
    expect(currentBodyStorageRead().mode).toBe('enabled');
    expect(process.env.CMS_BODY_DUAL_WRITE_ENABLED).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { assertLoopbackUrl, buildIsolatedEnv, isLoopbackUrl } from './env.mjs';

describe('isolated environment safety', () => {
  it('recognises loopback URLs only', () => {
    expect(isLoopbackUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLoopbackUrl('http://localhost:54321')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:54321')).toBe(true);
    expect(isLoopbackUrl('https://project.supabase.co')).toBe(false);
    expect(isLoopbackUrl('not-a-url')).toBe(false);
  });

  it('refuses non-loopback managed URLs', () => {
    expect(() =>
      assertLoopbackUrl('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.com')
    ).toThrow(/non-loopback/);
  });

  it('builds an env that overwrites ambient prod values', () => {
    const env = buildIsolatedEnv({
      baseEnv: {
        PATH: '/usr/bin',
        NEXT_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co',
        SUPABASE_SECRET_KEY: 'prod-secret',
        WEBSITE_REVALIDATION_URL:
          'https://okazakee.dev/api/internal/content-revalidate',
      },
      supabaseUrl: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_local',
      secretKey: 'sb_secret_local',
      revalidationUrl: 'http://localhost:3200/api/internal/content-revalidate',
      revalidationSecret: 'local-secret',
      nextUrl: 'http://localhost:3100',
    });

    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(env.SUPABASE_SECRET_KEY).toBe('sb_secret_local');
    expect(env.CMS_ISOLATED_TEST).toBe('1');
    expect(env.APP_ENV).toBe('development');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CONTENT_ENFORCE_PUBLISH_DATE).toBe('false');
  });

  it('cannot be pointed at production through caller overrides', () => {
    const env = buildIsolatedEnv({
      baseEnv: {},
      supabaseUrl: 'http://127.0.0.1:54321',
      publishableKey: 'p',
      secretKey: 's',
      revalidationUrl: 'http://localhost:3200/api/internal/content-revalidate',
      revalidationSecret: 'x',
      nextUrl: 'http://localhost:3100',
      parentEnv: { NEXT_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co' },
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:54321');
  });

  it('refuses production semantics', () => {
    expect(() =>
      buildIsolatedEnv({
        baseEnv: {},
        supabaseUrl: 'http://127.0.0.1:54321',
        publishableKey: 'p',
        secretKey: 's',
        revalidationUrl:
          'http://localhost:3200/api/internal/content-revalidate',
        revalidationSecret: 'x',
        nextUrl: 'http://localhost:3100',
        parentEnv: { APP_ENV: 'production' },
      })
    ).toThrow(/production/);
  });
});

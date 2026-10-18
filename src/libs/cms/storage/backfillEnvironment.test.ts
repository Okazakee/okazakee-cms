import { describe, expect, it } from 'vitest';
import {
  assertBackfillAcknowledged,
  assertBackfillEnvironment,
  BACKFILL_BODY_COLUMNS,
  BACKFILL_POINTER_COLUMNS,
  type BackfillObservedEnvironment,
  DEV_BACKFILL_ENVIRONMENT,
  PROD_BACKFILL_ENVIRONMENT,
  parseRevalidationOrigins,
  projectRefFromUrl,
  REVALIDATION_PATH,
  validateRevalidationEndpointFor,
} from '@/libs/cms/storage/backfillEnvironment';

/**
 * Phase 13 — the shared environment descriptor and its gates.
 *
 * Pure and isolated: no network, no database, no Storage. Every case asserts
 * observable behaviour (returned values, thrown messages) and the fixtures are
 * synthetic on purpose — the tooling must never be pinned against real content.
 */

const PROJECT_REF = 'mtvwynyikouqzmhqespl';
const PROD_ORIGINS = ['https://okazakee.dev'];

/** A valid DEV-shaped tuple; individual fields are bent per test. */
function observed(
  overrides: Partial<BackfillObservedEnvironment> = {}
): BackfillObservedEnvironment {
  return {
    appEnv: 'development',
    schema: 'dev_staging',
    supabaseUrl: `https://${PROJECT_REF}.supabase.co`,
    hasServerSecret: true,
    ...overrides,
  };
}

describe('descriptor values', () => {
  it('pins the DEV descriptor', () => {
    expect(DEV_BACKFILL_ENVIRONMENT).toEqual({
      name: 'dev',
      commandPrefix: 'storage:content:dev:backfill',
      appEnv: 'development',
      schema: 'dev_staging',
      projectRef: PROJECT_REF,
      bucket: 'website-content-dev',
      cas: {
        forward: 'dev_backfill_body_pointer_cas',
        rollback: 'dev_backfill_body_pointer_rollback',
      },
      projections: {
        bodies: BACKFILL_BODY_COLUMNS,
        pointers: BACKFILL_POINTER_COLUMNS,
      },
      journal: { env: 'BACKFILL_JOURNAL_PATH' },
      applyAck: {
        env: 'CMS_BACKFILL_APPLY_ACK',
        value: 'yes-apply-to-dev-staging',
      },
      rollbackAck: {
        env: 'CMS_BACKFILL_ROLLBACK_ACK',
        value: 'yes-rollback-dev-staging',
      },
      revalidation: { kind: 'local-http', allowedPath: REVALIDATION_PATH },
    });
  });

  it('pins the production descriptor', () => {
    expect(PROD_BACKFILL_ENVIRONMENT).toEqual({
      name: 'production',
      commandPrefix: 'storage:content:prod:backfill',
      appEnv: 'production',
      schema: 'public',
      projectRef: PROJECT_REF,
      bucket: 'website-content',
      cas: {
        forward: 'prod_backfill_body_pointer_cas',
        rollback: 'prod_backfill_body_pointer_rollback',
      },
      projections: {
        bodies: BACKFILL_BODY_COLUMNS,
        pointers: BACKFILL_POINTER_COLUMNS,
      },
      journal: { env: 'PROD_BACKFILL_JOURNAL_PATH' },
      applyAck: {
        env: 'CMS_PROD_BACKFILL_APPLY_ACK',
        value: 'yes-apply-to-production-backfill',
      },
      rollbackAck: {
        env: 'CMS_PROD_BACKFILL_ROLLBACK_ACK',
        value: 'yes-rollback-to-production-backfill',
      },
      revalidation: {
        kind: 'https-allowlist',
        allowedPath: REVALIDATION_PATH,
        originsEnv: 'CMS_PROD_REVALIDATION_ORIGINS',
      },
    });
  });

  it('shares the project ref and the projections but nothing that arms a run', () => {
    const dev = DEV_BACKFILL_ENVIRONMENT;
    const prod = PROD_BACKFILL_ENVIRONMENT;

    expect(dev.projectRef).toBe(PROJECT_REF);
    expect(prod.projectRef).toBe(PROJECT_REF);
    expect(dev.projections).toEqual(prod.projections);
    expect(dev.revalidation.allowedPath).toBe(REVALIDATION_PATH);
    expect(prod.revalidation.allowedPath).toBe(REVALIDATION_PATH);

    const devAckEnv = [dev.applyAck.env, dev.rollbackAck.env];
    const prodAckEnv = [prod.applyAck.env, prod.rollbackAck.env];
    expect(devAckEnv.filter((name) => prodAckEnv.includes(name))).toEqual([]);

    const devAckValues = [dev.applyAck.value, dev.rollbackAck.value];
    const prodAckValues = [prod.applyAck.value, prod.rollbackAck.value];
    for (const value of devAckValues) {
      expect(prodAckValues).not.toContain(value);
    }

    expect(dev.journal.env).not.toBe(prod.journal.env);
    expect(dev.bucket).not.toBe(prod.bucket);
    expect(dev.schema).not.toBe(prod.schema);
    expect(dev.cas.forward).not.toBe(prod.cas.forward);
    expect(dev.cas.rollback).not.toBe(prod.cas.rollback);
  });
});

describe('assertBackfillEnvironment', () => {
  it('accepts the exact production tuple', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({ appEnv: 'production', schema: 'public' })
      )
    ).not.toThrow();
  });

  it('accepts the exact DEV tuple and refuses production', () => {
    expect(() =>
      assertBackfillEnvironment(DEV_BACKFILL_ENVIRONMENT, observed())
    ).not.toThrow();

    expect(() =>
      assertBackfillEnvironment(
        DEV_BACKFILL_ENVIRONMENT,
        observed({ appEnv: 'production' })
      )
    ).toThrow(/APP_ENV must be exactly 'development', got 'production'/);
  });

  it('refuses a wrong app env, naming the required value', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({ appEnv: 'development', schema: 'public' })
      )
    ).toThrow(/APP_ENV must be exactly 'production', got 'development'/);
  });

  it('refuses a wrong schema, naming the required value', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({ appEnv: 'production', schema: 'dev_staging' })
      )
    ).toThrow(
      /NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be 'public', got 'dev_staging'/
    );
  });

  it('refuses an empty Supabase URL', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({ appEnv: 'production', schema: 'public', supabaseUrl: '' })
      )
    ).toThrow(/missing NEXT_PUBLIC_SUPABASE_URL/);
  });

  it('refuses an unparseable Supabase URL', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({
          appEnv: 'production',
          schema: 'public',
          supabaseUrl: 'not-a-url',
        })
      )
    ).toThrow(/is not a usable https:\/\/<ref>\.supabase\.co URL/);
  });

  it('refuses a URL targeting another project', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({
          appEnv: 'production',
          schema: 'public',
          supabaseUrl: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
        })
      )
    ).toThrow(
      /project mismatch: configured URL targets 'aaaaaaaaaaaaaaaaaaaa' but the production tooling only operates on 'mtvwynyikouqzmhqespl'/
    );
  });

  it('refuses a http:// Supabase URL', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({
          appEnv: 'production',
          schema: 'public',
          supabaseUrl: `http://${PROJECT_REF}.supabase.co`,
        })
      )
    ).toThrow(/is not a usable https:\/\/<ref>\.supabase\.co URL/);
  });

  it('refuses a missing server secret', () => {
    expect(() =>
      assertBackfillEnvironment(
        PROD_BACKFILL_ENVIRONMENT,
        observed({
          appEnv: 'production',
          schema: 'public',
          hasServerSecret: false,
        })
      )
    ).toThrow(
      /missing SUPABASE_SECRET_KEY \(server-side credentials required\)/
    );
  });
});

describe('projectRefFromUrl', () => {
  it('extracts the ref from a https supabase.co URL', () => {
    expect(projectRefFromUrl(`https://${PROJECT_REF}.supabase.co`)).toBe(
      PROJECT_REF
    );
  });

  it('extracts the ref from a https supabase.in URL', () => {
    expect(projectRefFromUrl(`https://${PROJECT_REF}.supabase.in`)).toBe(
      PROJECT_REF
    );
  });

  it('lowercases the host before matching', () => {
    expect(projectRefFromUrl('https://MTVWYNYIKOUQZMHQESPL.supabase.co')).toBe(
      PROJECT_REF
    );
  });

  it('returns null for http, non-supabase hosts and malformed refs', () => {
    expect(projectRefFromUrl(`http://${PROJECT_REF}.supabase.co`)).toBeNull();
    expect(projectRefFromUrl(`https://${PROJECT_REF}.supabase.dev`)).toBeNull();
    expect(projectRefFromUrl(`https://${PROJECT_REF}.example.com`)).toBeNull();
    // 19 characters: too short.
    expect(
      projectRefFromUrl('https://abcdefghijklmnopqrs.supabase.co')
    ).toBeNull();
    // 21 characters: too long.
    expect(
      projectRefFromUrl('https://abcdefghijklmnopqrstu.supabase.co')
    ).toBeNull();
    // 20 characters, but one of them is not a lowercase alphanumeric.
    expect(
      projectRefFromUrl('https://mtvwynyikouqzmhqes-l.supabase.co')
    ).toBeNull();
    expect(
      projectRefFromUrl(`https://${PROJECT_REF}.supabase.co.attacker.io`)
    ).toBeNull();
    expect(projectRefFromUrl('not a url')).toBeNull();
    expect(projectRefFromUrl('')).toBeNull();
  });
});

describe('parseRevalidationOrigins', () => {
  it('refuses an empty allowlist', () => {
    const result = parseRevalidationOrigins('');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe(
      'the HTTPS revalidation origin allowlist is empty'
    );
  });

  it('refuses a whitespace-only allowlist', () => {
    const result = parseRevalidationOrigins(' , , ');
    expect(result.ok).toBe(false);
  });

  it('accepts and lowercases a bare https origin', () => {
    expect(parseRevalidationOrigins('https://okazakee.dev')).toEqual({
      ok: true,
      origins: ['https://okazakee.dev'],
    });
    expect(parseRevalidationOrigins('https://OKAZAKEE.DEV')).toEqual({
      ok: true,
      origins: ['https://okazakee.dev'],
    });
  });

  it('accepts multiple comma-separated origins in order', () => {
    expect(
      parseRevalidationOrigins(
        'https://a.example ,https://b.example, https://c.example'
      )
    ).toEqual({
      ok: true,
      origins: ['https://a.example', 'https://b.example', 'https://c.example'],
    });
  });

  it('refuses http, paths, queries, fragments, credentials and non-URLs', () => {
    const cases: Array<[string, RegExp]> = [
      ['http://okazakee.dev', /must use https/],
      ['https://okazakee.dev/api', /must be a bare origin without a path/],
      ['https://okazakee.dev/?a=1', /must be a bare origin without a path/],
      ['https://okazakee.dev/#frag', /must be a bare origin without a path/],
      ['https://user:pass@okazakee.dev', /must not carry credentials/],
      ['not-a-url', /is not a valid origin/],
    ];
    for (const [raw, pattern] of cases) {
      const result = parseRevalidationOrigins(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).toMatch(pattern);
    }
  });
});

describe('validateRevalidationEndpointFor — DEV policy', () => {
  const dev = DEV_BACKFILL_ENVIRONMENT;

  it('approves the local HTTP destination and local HTTPS', () => {
    expect(
      validateRevalidationEndpointFor(
        dev,
        `http://localhost:3000${REVALIDATION_PATH}`
      )
    ).toBeNull();
    expect(
      validateRevalidationEndpointFor(
        dev,
        `https://localhost:3000${REVALIDATION_PATH}`
      )
    ).toBeNull();
  });

  it('refuses a non-local host, naming the host', () => {
    expect(
      validateRevalidationEndpointFor(
        dev,
        `https://okazakee.dev${REVALIDATION_PATH}`
      )
    ).toMatch(
      /WEBSITE_REVALIDATION_URL must target a local DEV host, got 'okazakee\.dev'/
    );
  });

  it('refuses a wrong path, naming the expected path', () => {
    expect(
      validateRevalidationEndpointFor(dev, 'http://localhost:3000/api/other')
    ).toMatch(
      /WEBSITE_REVALIDATION_URL path must be '\/api\/internal\/content-revalidate', got '\/api\/other'/
    );
  });

  it('refuses a non-http(s) scheme', () => {
    expect(
      validateRevalidationEndpointFor(
        dev,
        `ftp://localhost:3000${REVALIDATION_PATH}`
      )
    ).toMatch(/WEBSITE_REVALIDATION_URL must be http\(s\), got 'ftp:'/);
  });

  it('refuses an empty and an invalid URL', () => {
    expect(validateRevalidationEndpointFor(dev, '')).toMatch(
      /WEBSITE_REVALIDATION_URL is not configured/
    );
    expect(validateRevalidationEndpointFor(dev, 'http://')).toMatch(
      /WEBSITE_REVALIDATION_URL 'http:\/\/' is not a valid URL/
    );
  });
});

describe('validateRevalidationEndpointFor — production policy', () => {
  const prod = PROD_BACKFILL_ENVIRONMENT;
  const prodUrl = `https://okazakee.dev${REVALIDATION_PATH}`;

  it('approves an exact allowlisted https origin on the exact path', () => {
    expect(
      validateRevalidationEndpointFor(prod, prodUrl, PROD_ORIGINS)
    ).toBeNull();
    expect(
      validateRevalidationEndpointFor(prod, prodUrl, ['https://okazakee.dev'])
    ).toBeNull();
  });

  it('refuses http outright even on an approved origin', () => {
    expect(
      validateRevalidationEndpointFor(
        prod,
        `http://okazakee.dev${REVALIDATION_PATH}`,
        PROD_ORIGINS
      )
    ).toMatch(
      /WEBSITE_REVALIDATION_URL must use https in production, got 'http:'/
    );
  });

  it('refuses an origin that is not in the allowlist, naming the variable', () => {
    expect(
      validateRevalidationEndpointFor(
        prod,
        `https://other.example${REVALIDATION_PATH}`,
        PROD_ORIGINS
      )
    ).toMatch(
      /origin 'https:\/\/other\.example' is not in CMS_PROD_REVALIDATION_ORIGINS/
    );
  });

  it('refuses an empty allowlist, naming the variable', () => {
    expect(validateRevalidationEndpointFor(prod, prodUrl, [])).toMatch(
      /CMS_PROD_REVALIDATION_ORIGINS must list the approved HTTPS origin\(s\)/
    );
  });

  it('refuses a wrong path on an approved origin', () => {
    expect(
      validateRevalidationEndpointFor(
        prod,
        'https://okazakee.dev/other',
        PROD_ORIGINS
      )
    ).toMatch(
      /WEBSITE_REVALIDATION_URL path must be '\/api\/internal\/content-revalidate', got '\/other'/
    );
  });

  it('refuses a URL carrying credentials', () => {
    expect(
      validateRevalidationEndpointFor(
        prod,
        `https://user:pass@okazakee.dev${REVALIDATION_PATH}`,
        PROD_ORIGINS
      )
    ).toMatch(/WEBSITE_REVALIDATION_URL must not carry credentials/);
  });
});

describe('cross-arm revalidation safety', () => {
  it('never approves one environment’s destination with the other policy', () => {
    const devDestination = `http://localhost:3000${REVALIDATION_PATH}`;
    const prodDestination = `https://okazakee.dev${REVALIDATION_PATH}`;

    expect(
      validateRevalidationEndpointFor(
        PROD_BACKFILL_ENVIRONMENT,
        devDestination,
        PROD_ORIGINS
      )
    ).not.toBeNull();

    expect(
      validateRevalidationEndpointFor(DEV_BACKFILL_ENVIRONMENT, prodDestination)
    ).not.toBeNull();

    expect(
      validateRevalidationEndpointFor(DEV_BACKFILL_ENVIRONMENT, devDestination)
    ).toBeNull();
    expect(
      validateRevalidationEndpointFor(
        PROD_BACKFILL_ENVIRONMENT,
        prodDestination,
        PROD_ORIGINS
      )
    ).toBeNull();
  });
});

describe('assertBackfillAcknowledged', () => {
  it('accepts each environment’s own values', () => {
    expect(() =>
      assertBackfillAcknowledged(
        PROD_BACKFILL_ENVIRONMENT,
        'apply',
        'yes-apply-to-production-backfill'
      )
    ).not.toThrow();
    expect(() =>
      assertBackfillAcknowledged(
        PROD_BACKFILL_ENVIRONMENT,
        'rollback',
        'yes-rollback-to-production-backfill'
      )
    ).not.toThrow();
    expect(() =>
      assertBackfillAcknowledged(
        DEV_BACKFILL_ENVIRONMENT,
        'apply',
        'yes-apply-to-dev-staging'
      )
    ).not.toThrow();
    expect(() =>
      assertBackfillAcknowledged(
        DEV_BACKFILL_ENVIRONMENT,
        'rollback',
        'yes-rollback-dev-staging'
      )
    ).not.toThrow();
  });

  it('refuses an undefined acknowledgement, naming variable and value', () => {
    expect(() =>
      assertBackfillAcknowledged(PROD_BACKFILL_ENVIRONMENT, 'apply', undefined)
    ).toThrow(
      /refusing to mutate: set CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill to acknowledge a production apply backfill run/
    );
    expect(() =>
      assertBackfillAcknowledged(
        DEV_BACKFILL_ENVIRONMENT,
        'rollback',
        undefined
      )
    ).toThrow(
      /set CMS_BACKFILL_ROLLBACK_ACK=yes-rollback-dev-staging to acknowledge a dev rollback/
    );
  });

  it('refuses the DEV value under the production spec', () => {
    expect(() =>
      assertBackfillAcknowledged(
        PROD_BACKFILL_ENVIRONMENT,
        'apply',
        'yes-apply-to-dev-staging'
      )
    ).toThrow(/CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill/);
    expect(() =>
      assertBackfillAcknowledged(
        PROD_BACKFILL_ENVIRONMENT,
        'rollback',
        'yes-rollback-dev-staging'
      )
    ).toThrow(
      /CMS_PROD_BACKFILL_ROLLBACK_ACK=yes-rollback-to-production-backfill/
    );
  });

  it('refuses the production value under the DEV spec', () => {
    expect(() =>
      assertBackfillAcknowledged(
        DEV_BACKFILL_ENVIRONMENT,
        'apply',
        'yes-apply-to-production-backfill'
      )
    ).toThrow(/CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging/);
    expect(() =>
      assertBackfillAcknowledged(
        DEV_BACKFILL_ENVIRONMENT,
        'rollback',
        'yes-rollback-to-production-backfill'
      )
    ).toThrow(/CMS_BACKFILL_ROLLBACK_ACK=yes-rollback-dev-staging/);
  });
});

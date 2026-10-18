import { describe, expect, it } from 'vitest';
import { PROD_BACKFILL_ENVIRONMENT } from '@/libs/cms/storage/backfillEnvironment';
import {
  PROD_FORBIDDEN_ROOTS_ENV,
  type ProdMutationGateResult,
  REVALIDATION_SECRET_ENV,
  REVALIDATION_URL_ENV,
  resolveProdMutationGates,
} from '@/libs/cms/storage/prodBackfillGates';

/**
 * Phase 13 C3/C4 — the production-only mutation gates.
 *
 * Pure and isolated: the environment is an injected map, nothing is bound to
 * the live process, and no Supabase project is touched. Each case asserts the
 * refusal message (or the returned gate values) rather than a snapshot.
 */

const ENDPOINT = 'https://okazakee.dev/api/internal/content-revalidate';
const ORIGINS = 'https://okazakee.dev';

/** A fully configured production environment; fields are removed per test. */
function configuredEnv(): Record<string, string | undefined> {
  return {
    PROD_BACKFILL_JOURNAL_PATH: '/var/lib/okazakee/prod-backfill.jsonl',
    CMS_PROD_REVALIDATION_ORIGINS: ORIGINS,
    [REVALIDATION_URL_ENV]: ENDPOINT,
    [REVALIDATION_SECRET_ENV]: 'test-signing-secret',
  };
}

function expectRefused(result: ProdMutationGateResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected the gates to refuse');
  return result.error;
}

describe('resolveProdMutationGates', () => {
  it('exports the gate variable names', () => {
    expect(PROD_FORBIDDEN_ROOTS_ENV).toBe('CMS_PROD_BACKFILL_FORBIDDEN_ROOTS');
    expect(REVALIDATION_SECRET_ENV).toBe('WEBSITE_REVALIDATION_SECRET');
    expect(REVALIDATION_URL_ENV).toBe('WEBSITE_REVALIDATION_URL');
  });

  it('refuses a missing journal variable, naming it', () => {
    const env = configuredEnv();
    env.PROD_BACKFILL_JOURNAL_PATH = undefined;
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, env))
    ).toMatch(
      /PROD_BACKFILL_JOURNAL_PATH must be set so the run is recoverable across invocations/
    );

    const empty = { ...configuredEnv(), PROD_BACKFILL_JOURNAL_PATH: '' };
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, empty))
    ).toMatch(/PROD_BACKFILL_JOURNAL_PATH must be set/);
  });

  it('refuses an unset or empty origin allowlist', () => {
    for (const origins of [undefined, '', ' , ']) {
      const env = {
        ...configuredEnv(),
        CMS_PROD_REVALIDATION_ORIGINS: origins,
      };
      expect(
        expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, env))
      ).toMatch(
        /CMS_PROD_REVALIDATION_ORIGINS: the HTTPS revalidation origin allowlist is empty/
      );
    }
  });

  it('refuses an unparseable origin entry', () => {
    const env = {
      ...configuredEnv(),
      CMS_PROD_REVALIDATION_ORIGINS: 'http://okazakee.dev',
    };
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, env))
    ).toMatch(
      /CMS_PROD_REVALIDATION_ORIGINS: 'http:\/\/okazakee\.dev' must use https/
    );

    const junk = {
      ...configuredEnv(),
      CMS_PROD_REVALIDATION_ORIGINS: 'not-a-url',
    };
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, junk))
    ).toMatch(
      /CMS_PROD_REVALIDATION_ORIGINS: 'not-a-url' is not a valid origin/
    );
  });

  it('refuses an unset, http or unapproved revalidation endpoint', () => {
    const unset = configuredEnv();
    unset[REVALIDATION_URL_ENV] = undefined;
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, unset))
    ).toMatch(
      /WEBSITE_REVALIDATION_URL is not configured \(a pointer switch must be able to invalidate the public cache\)/
    );

    const http = {
      ...configuredEnv(),
      [REVALIDATION_URL_ENV]:
        'http://okazakee.dev/api/internal/content-revalidate',
    };
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, http))
    ).toMatch(
      /WEBSITE_REVALIDATION_URL must use https in production, got 'http:'/
    );

    const foreign = {
      ...configuredEnv(),
      [REVALIDATION_URL_ENV]:
        'https://other.example/api/internal/content-revalidate',
    };
    expect(
      expectRefused(
        resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, foreign)
      )
    ).toMatch(
      /origin 'https:\/\/other\.example' is not in CMS_PROD_REVALIDATION_ORIGINS/
    );

    const wrongPath = {
      ...configuredEnv(),
      [REVALIDATION_URL_ENV]: 'https://okazakee.dev/other',
    };
    expect(
      expectRefused(
        resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, wrongPath)
      )
    ).toMatch(
      /WEBSITE_REVALIDATION_URL path must be '\/api\/internal\/content-revalidate', got '\/other'/
    );
  });

  it('refuses a missing signing secret once the endpoint is approved', () => {
    const env = configuredEnv();
    env[REVALIDATION_SECRET_ENV] = undefined;
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, env))
    ).toMatch(/WEBSITE_REVALIDATION_SECRET is not configured/);

    const blank = { ...configuredEnv(), [REVALIDATION_SECRET_ENV]: '' };
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, blank))
    ).toMatch(/WEBSITE_REVALIDATION_SECRET is not configured/);
  });

  it('returns the resolved gates when fully configured', () => {
    const env = configuredEnv();
    const result = resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, env);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the gates to pass');
    expect(result.gates).toEqual({
      journalPath: env.PROD_BACKFILL_JOURNAL_PATH,
      allowedOrigins: ['https://okazakee.dev'],
      endpoint: ENDPOINT,
    });
  });

  it('normalises a mixed-case allowlist and accepts the destination', () => {
    const env = {
      ...configuredEnv(),
      CMS_PROD_REVALIDATION_ORIGINS:
        ' HTTPS://OKAZAKEE.DEV , https://cdn.okazakee.dev ',
      [REVALIDATION_URL_ENV]:
        'https://cdn.okazakee.dev/api/internal/content-revalidate',
    };
    const result = resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, env);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the gates to pass');
    expect(result.gates.allowedOrigins).toEqual([
      'https://okazakee.dev',
      'https://cdn.okazakee.dev',
    ]);
    expect(result.gates.endpoint).toBe(
      'https://cdn.okazakee.dev/api/internal/content-revalidate'
    );
  });

  it('cannot be satisfied with the DEV journal variable or value', () => {
    const devOnly = {
      BACKFILL_JOURNAL_PATH: '/tmp/dev-backfill.jsonl',
      CMS_BACKFILL_APPLY_ACK: 'yes-apply-to-dev-staging',
      CMS_PROD_REVALIDATION_ORIGINS: ORIGINS,
      [REVALIDATION_URL_ENV]: ENDPOINT,
      [REVALIDATION_SECRET_ENV]: 'test-signing-secret',
    };
    expect(
      expectRefused(
        resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, devOnly)
      )
    ).toMatch(/PROD_BACKFILL_JOURNAL_PATH must be set/);
  });

  it('refuses an entirely empty environment at the first gate', () => {
    expect(
      expectRefused(resolveProdMutationGates(PROD_BACKFILL_ENVIRONMENT, {}))
    ).toMatch(/PROD_BACKFILL_JOURNAL_PATH must be set/);
  });
});

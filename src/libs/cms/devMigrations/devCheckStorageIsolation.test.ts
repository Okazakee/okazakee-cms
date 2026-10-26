import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CheckFinding,
  CONSTRAINTS_QUERY,
  type ContentStorageFacts,
  checkContentStorageIsolation,
  DEV_RBAC_ALLOWLIST_ACL_QUERY,
  DEV_RBAC_ROLE_CONSTRAINTS_QUERY,
  DEV_RBAC_RPC_COPIES_QUERY,
  DEV_RBAC_TRIGGERS_QUERY,
  EXPECTED_BODY_PATH_CHECKS,
  evaluateContentStorageIsolation,
  LEDGER_ROWS_QUERY,
  loadRegistry,
  PROD_CAS_FUNCTIONS_QUERY,
  PROD_CONSTRAINTS_QUERY,
  PROD_LEGACY_BODY_COLUMNS_QUERY,
  PROD_POINTER_COLUMNS_QUERY,
  type ProdCasFunctionFact,
  type ProdColumnFact,
  type ProdConstraintFact,
  runDevCheck,
  STORAGE_BUCKETS_QUERY,
  STORAGE_POLICIES_QUERY,
  STORAGE_POLICY_RELATION_BINDINGS_QUERY,
  type StorageBucketFact,
  type StoragePolicyBindingFact,
  type StoragePolicyFact,
} from '@/libs/cms/devMigrations/devCheck';

/**
 * Regression cases for the lifecycle-aware content Storage contract. The
 * fixtures below reproduce the LIVE catalog shapes (dev_staging and production
 * queried 2026-10-18 on mtvwynyikouqzmhqespl), so a fixture that drifts from
 * the real deparser output fails here before it fails against the database.
 */

const DEV_BUCKET: StorageBucketFact = {
  id: 'website-content-dev',
  name: 'website-content-dev',
  public: false,
  file_size_limit: 1048576,
  allowed_mime_types: '{text/markdown}',
};
const PROD_BUCKET: StorageBucketFact = {
  id: 'website-content',
  name: 'website-content',
  public: false,
  file_size_limit: 1048576,
  allowed_mime_types: '{text/markdown}',
};
const ASSET_BUCKETS: StorageBucketFact[] = [
  {
    id: 'website',
    name: 'website',
    public: true,
    file_size_limit: 10485760,
    allowed_mime_types: '{image/webp,image/png,application/pdf,image/svg+xml}',
  },
  {
    id: 'website-dev',
    name: 'website-dev',
    public: true,
    file_size_limit: 10485760,
    allowed_mime_types: '{image/webp,image/png,application/pdf,image/svg+xml}',
  },
];

const DEV_POLICY_QUAL = `((bucket_id = 'website-content-dev'::text) AND storage.allow_any_operation(ARRAY['object.get_authenticated_info'::text, 'object.get_authenticated'::text]) AND ((EXISTS ( SELECT 1
   FROM dev_staging.blog_posts b
  WHERE ((objects.name = b.body_en_path) OR (objects.name = b.body_it_path))))) OR (EXISTS ( SELECT 1
   FROM dev_staging.portfolio_posts p
  WHERE ((objects.name = p.body_en_path) OR (objects.name = p.body_it_path))))))`;

const PROD_POLICY_QUAL = `((bucket_id = 'website-content'::text) AND storage.allow_any_operation(ARRAY['object.get_authenticated_info'::text, 'object.get_authenticated'::text]) AND ((EXISTS ( SELECT 1
   FROM blog_posts b
  WHERE ((b.hidden = false) AND ((objects.name = b.body_en_path) OR (objects.name = b.body_it_path))))) OR (EXISTS ( SELECT 1
   FROM portfolio_posts p
  WHERE ((p.hidden = false) AND ((objects.name = p.body_en_path) OR (objects.name = p.body_it_path)))))))`;

const DEV_POLICY: StoragePolicyFact = {
  policy_name: 'website_content_dev_body_read',
  cmd: 'r',
  roles: '{anon,authenticated}',
  using_expr: DEV_POLICY_QUAL,
  with_check_expr: null,
};
const PROD_POLICY: StoragePolicyFact = {
  policy_name: 'website_content_body_read',
  cmd: 'r',
  roles: '{anon,authenticated}',
  using_expr: PROD_POLICY_QUAL,
  with_check_expr: null,
};

/** pg_depend reports one row per column reference, so duplicates are real. */
function bindings(
  policy: string,
  relations: string[]
): StoragePolicyBindingFact[] {
  return relations.flatMap((relation) => {
    const [ref_schema, ref_relation] = relation.split('.');
    return [
      { policy_name: policy, ref_schema, ref_relation },
      { policy_name: policy, ref_schema, ref_relation },
    ];
  });
}

const DEV_BINDINGS = bindings('website_content_dev_body_read', [
  'dev_staging.blog_posts',
  'dev_staging.portfolio_posts',
]);
const PROD_BINDINGS = bindings('website_content_body_read', [
  'public.blog_posts',
  'public.portfolio_posts',
]);

const PROD_COLUMNS: ProdColumnFact[] = [
  'blog_posts',
  'portfolio_posts',
].flatMap((table_name) =>
  ['body_en_path', 'body_it_path'].map((name) => ({
    table_name,
    name,
    formatted_type: 'text',
    nullable: true,
  }))
);

function pointerCheck(
  table_name: string,
  column: string,
  lang: string,
  prefix: string
): ProdConstraintFact {
  return {
    table_name,
    constraint_name: `${table_name}_${column}_check`,
    contype: 'c',
    definition: `CHECK (${column} IS NULL OR ${column} ~ (('^${prefix}/'::text || id::text) || '/${lang}/[0-9a-f]{64}\\.md$'::text))`,
  };
}

const PROD_CONSTRAINTS: ProdConstraintFact[] = [
  pointerCheck('blog_posts', 'body_en_path', 'en', 'blog'),
  pointerCheck('blog_posts', 'body_it_path', 'it', 'blog'),
  pointerCheck('portfolio_posts', 'body_en_path', 'en', 'portfolio'),
  pointerCheck('portfolio_posts', 'body_it_path', 'it', 'portfolio'),
];

/**
 * The RETIRED CAS pair, as the pre-contraction project reported it. Present in
 * the fixtures only to prove that a surviving function FAILS the contracted
 * contract; the contracted state has neither.
 */
const PROD_FUNCTIONS: ProdCasFunctionFact[] = [
  {
    name: 'prod_backfill_body_pointer_cas',
    args: 'p_kind text, p_post_id bigint, p_locale text, p_expected_sha256 text, p_expected_previous text, p_new_path text',
    security_definer: true,
    proconfig: 'search_path=pg_catalog, pg_temp',
    acl_raw: '{postgres=X/postgres,service_role=X/postgres}',
  },
  {
    name: 'prod_backfill_body_pointer_rollback',
    args: 'p_kind text, p_post_id bigint, p_locale text, p_installed_path text, p_expected_sha256 text, p_previous_path text',
    security_definer: true,
    proconfig: 'search_path=pg_catalog, pg_temp',
    acl_raw: '{postgres=X/postgres,service_role=X/postgres}',
  },
];

/**
 * The RETIRED legacy body columns, as the pre-contraction project reported
 * them. Present in the fixtures only to prove that a surviving column FAILS the
 * contracted contract; the contracted state has neither.
 */
const PROD_LEGACY_COLUMNS: ProdColumnFact[] = [
  'blog_posts',
  'portfolio_posts',
].flatMap((table_name) =>
  ['body_en', 'body_it'].map((name) => ({
    table_name,
    name,
    formatted_type: 'text',
    nullable: true,
  }))
);

/** The DEV plane only: the pre-CP-1 lifecycle state. */
const PRE_CP1_FACTS: ContentStorageFacts = {
  buckets: [...ASSET_BUCKETS, DEV_BUCKET],
  policies: [DEV_POLICY],
  bindings: DEV_BINDINGS,
  prodColumns: [],
  prodConstraints: [],
  prodLegacyColumns: [],
  prodFunctions: [],
};

/** The CONTRACTED production plane, exactly as the live project reports it. */
const CONTRACTED_FACTS: ContentStorageFacts = {
  buckets: [...ASSET_BUCKETS, PROD_BUCKET, DEV_BUCKET],
  policies: [PROD_POLICY, DEV_POLICY],
  bindings: [...PROD_BINDINGS, ...DEV_BINDINGS],
  prodColumns: PROD_COLUMNS,
  prodConstraints: PROD_CONSTRAINTS,
  prodLegacyColumns: [],
  prodFunctions: [],
};

function facts(overrides: Partial<ContentStorageFacts>): ContentStorageFacts {
  return { ...CONTRACTED_FACTS, ...overrides };
}

function evaluate(f: ContentStorageFacts): CheckFinding[] {
  const findings: CheckFinding[] = [];
  evaluateContentStorageIsolation(f, findings);
  return findings;
}

function fails(findings: CheckFinding[]): CheckFinding[] {
  return findings.filter((f) => f.status === 'FAIL');
}

function detailOf(findings: CheckFinding[], id: string): string {
  return findings.find((f) => f.id === id)?.detail ?? '';
}

describe('content Storage contract — lifecycle states', () => {
  it('accepts a full pre-CP-1 state (production plane absent)', () => {
    const findings = evaluate(PRE_CP1_FACTS);
    expect(fails(findings)).toEqual([]);
    expect(detailOf(findings, 'S-bucket-prod')).toContain('valid pre-CP-1');
    expect(detailOf(findings, 'S-website_content_body_read')).toContain(
      'valid pre-CP-1'
    );
    expect(
      detailOf(findings, 'S-website_content_body_read-bindings')
    ).toContain('valid pre-CP-1');
    expect(detailOf(findings, 'S-prod-columns')).toContain('valid pre-CP-1');
    expect(detailOf(findings, 'S-prod-checks')).toContain('valid pre-CP-1');
    expect(detailOf(findings, 'S-prod-legacy-columns')).toContain(
      'contraction applied'
    );
    expect(detailOf(findings, 'S-prod-cas')).toContain('valid pre-CP-1');
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'absent in full'
    );
    // The obsolete pre-CP-1 assertion is gone, not merely re-worded.
    expect(findings.some((f) => f.id === 'S-bucket-prod-absent')).toBe(false);
  });

  it('accepts a CONTRACTED production plane and certifies every remaining artifact', () => {
    const findings = evaluate(CONTRACTED_FACTS);
    expect(fails(findings)).toEqual([]);
    expect(detailOf(findings, 'S-bucket-prod')).toContain(
      'website-content: private, 1048576B limit, text/markdown only'
    );
    expect(detailOf(findings, 'S-website_content_body_read')).toContain(
      'SELECT to anon,authenticated'
    );
    expect(
      detailOf(findings, 'S-website_content_body_read-bindings')
    ).toContain('binds only public.blog_posts + public.portfolio_posts');
    expect(detailOf(findings, 'S-prod-columns')).toContain('4 nullable text');
    expect(detailOf(findings, 'S-prod-checks')).toContain('4 canonical');
    expect(detailOf(findings, 'S-prod-legacy-columns')).toContain(
      'no legacy body_en/body_it columns'
    );
    expect(detailOf(findings, 'S-prod-cas')).toContain(
      'no prod_backfill_* CAS functions'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'plane contracted'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'legacy body columns and prod_backfill_* CAS functions absent'
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain('stay distinct');
    expect(
      findings.find((f) => f.id === 'S-prod-pointers-lifecycle')?.status
    ).toBe('INFO');
    expect(detailOf(findings, 'S-prod-pointers-lifecycle')).toContain(
      'CP-2 backfill'
    );
  });

  it('keeps the completed DEV migration valid alongside the production plane', () => {
    const findings = evaluate(CONTRACTED_FACTS);
    for (const id of [
      'S-bucket',
      'S-website_content_dev_body_read',
      'S-website_content_dev_body_read-bindings',
      'S-no-write',
      'S-single-policy',
    ]) {
      expect(findings.find((f) => f.id === id)?.status).toBe('PASS');
    }
    expect(detailOf(findings, 'S-bucket')).toContain(
      'website-content-dev: private, 1048576B limit, text/markdown only'
    );
    expect(detailOf(findings, 'S-single-policy')).toContain(
      'exactly one storage.objects policy references website-content-dev'
    );
  });
});

describe('content Storage contract — production bucket configuration', () => {
  it('fails on a public production bucket', () => {
    const findings = evaluate(
      facts({
        buckets: [
          ...ASSET_BUCKETS,
          { ...PROD_BUCKET, public: true },
          DEV_BUCKET,
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-prod')).toContain(
      'public got=true exp=false'
    );
    expect(findings.find((f) => f.id === 'S-bucket-prod')?.status).toBe('FAIL');
  });

  it('fails on a wrong production size limit', () => {
    const findings = evaluate(
      facts({
        buckets: [
          ...ASSET_BUCKETS,
          { ...PROD_BUCKET, file_size_limit: 10485760 },
          DEV_BUCKET,
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-prod')).toContain(
      'file_size_limit got=10485760 exp=1048576'
    );
  });

  it('fails on extra or wrong production MIME types', () => {
    const extra = evaluate(
      facts({
        buckets: [
          ...ASSET_BUCKETS,
          { ...PROD_BUCKET, allowed_mime_types: '{text/markdown,text/plain}' },
          DEV_BUCKET,
        ],
      })
    );
    expect(detailOf(extra, 'S-bucket-prod')).toContain('allowed_mime_types');
    const wrong = evaluate(
      facts({
        buckets: [
          ...ASSET_BUCKETS,
          { ...PROD_BUCKET, allowed_mime_types: '{text/plain}' },
          DEV_BUCKET,
        ],
      })
    );
    expect(detailOf(wrong, 'S-bucket-prod')).toContain('allowed_mime_types');
  });

  it('fails when the production bucket row carries an unexpected name', () => {
    const findings = evaluate(
      facts({
        buckets: [
          ...ASSET_BUCKETS,
          { ...PROD_BUCKET, name: 'website-content-renamed' },
          DEV_BUCKET,
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-prod')).toContain(
      'name got=website-content-renamed'
    );
  });
});

describe('content Storage contract — cross-environment contamination', () => {
  it('fails when the dev policy binds public relations', () => {
    const findings = evaluate(
      facts({
        bindings: [
          ...PROD_BINDINGS,
          ...DEV_BINDINGS,
          ...bindings('website_content_dev_body_read', ['public.blog_posts']),
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain(
      'dev-side policy website_content_dev_body_read binds public relations'
    );
    expect(
      findings.find((f) => f.id === 'S-website_content_dev_body_read-bindings')
        ?.status
    ).toBe('FAIL');
  });

  it('fails when the production policy binds dev_staging relations', () => {
    const findings = evaluate(
      facts({
        bindings: [
          ...DEV_BINDINGS,
          ...PROD_BINDINGS,
          ...bindings('website_content_body_read', ['dev_staging.blog_posts']),
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain(
      'production-side policy website_content_body_read binds dev_staging relations'
    );
    expect(
      findings.find((f) => f.id === 'S-website_content_body_read-bindings')
        ?.status
    ).toBe('FAIL');
  });

  it('fails when the production policy is scoped to the dev bucket', () => {
    const findings = evaluate(
      facts({
        policies: [{ ...PROD_POLICY, using_expr: DEV_POLICY_QUAL }, DEV_POLICY],
      })
    );
    expect(
      findings.find((f) => f.id === 'S-website_content_body_read')?.status
    ).toBe('FAIL');
    expect(detailOf(findings, 'S-website_content_body_read')).toContain(
      "references the other environment's bucket 'website-content-dev'"
    );
    // Two policies now claim the dev bucket, so the dev single-policy check
    // must catch it as well.
    expect(findings.find((f) => f.id === 'S-single-policy')?.status).toBe(
      'FAIL'
    );
  });

  it('fails when the dev policy predicate references public relations', () => {
    const findings = evaluate(
      facts({
        policies: [
          PROD_POLICY,
          {
            ...DEV_POLICY,
            using_expr: DEV_POLICY_QUAL.replaceAll('dev_staging.', 'public.'),
          },
        ],
      })
    );
    expect(detailOf(findings, 'S-website_content_dev_body_read')).toContain(
      "references the other environment's schema public"
    );
    expect(
      findings.find((f) => f.id === 'S-website_content_dev_body_read')?.status
    ).toBe('FAIL');
  });

  it('fails when the two content buckets report the same name', () => {
    const findings = evaluate(
      facts({
        buckets: [
          ...ASSET_BUCKETS,
          PROD_BUCKET,
          { ...DEV_BUCKET, name: 'website-content' },
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain(
      'share the name website-content'
    );
    expect(findings.find((f) => f.id === 'S-bucket')?.status).toBe('FAIL');
  });

  it('fails when a write policy targets the production bucket', () => {
    const findings = evaluate(
      facts({
        policies: [
          PROD_POLICY,
          DEV_POLICY,
          {
            policy_name: 'website_content_body_write',
            cmd: 'a',
            roles: '{anon,authenticated}',
            using_expr: "(bucket_id = 'website-content'::text)",
            with_check_expr: "(bucket_id = 'website-content'::text)",
          },
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain(
      'grants a on the production bucket'
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain(
      'policies other than website_content_body_read reference website-content'
    );
  });

  it('fails when another policy binds public content relations', () => {
    const findings = evaluate(
      facts({
        policies: [
          PROD_POLICY,
          DEV_POLICY,
          {
            policy_name: 'public_posts_body_read',
            cmd: 'r',
            roles: '{anon}',
            using_expr: "(bucket_id = 'website'::text)",
            with_check_expr: null,
          },
        ],
        bindings: [
          ...PROD_BINDINGS,
          ...DEV_BINDINGS,
          {
            policy_name: 'public_posts_body_read',
            ref_schema: 'public',
            ref_relation: 'blog_posts',
          },
        ],
      })
    );
    expect(detailOf(findings, 'S-bucket-isolation')).toContain(
      'non-production policy public_posts_body_read binds public content relations'
    );
  });
});

describe('content Storage contract — partial production infrastructure', () => {
  it('fails when a contracted plane carries a resurrected CAS function', () => {
    const findings = evaluate(facts({ prodFunctions: PROD_FUNCTIONS }));
    expect(findings.find((f) => f.id === 'S-prod-cas')?.status).toBe('FAIL');
    expect(detailOf(findings, 'S-prod-cas')).toContain(
      'prod_backfill_body_pointer_cas'
    );
    expect(detailOf(findings, 'S-prod-cas')).toContain(
      'prod_backfill_body_pointer_rollback'
    );
    expect(detailOf(findings, 'S-prod-cas')).toContain('still present');
    expect(findings.find((f) => f.id === 'S-prod-consistency')?.status).toBe(
      'FAIL'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'retired CAS functions'
    );
    // The rest of the plane is intact: only the contraction artifact is wrong.
    expect(detailOf(findings, 'S-prod-columns')).toContain('4 nullable text');
    expect(detailOf(findings, 'S-prod-checks')).toContain('4 canonical');
    expect(detailOf(findings, 'S-prod-legacy-columns')).toContain(
      'no legacy body_en/body_it columns'
    );
  });

  it('fails when a contracted plane still carries a retired legacy body column', () => {
    const findings = evaluate(
      facts({ prodLegacyColumns: PROD_LEGACY_COLUMNS })
    );
    expect(findings.find((f) => f.id === 'S-prod-legacy-columns')?.status).toBe(
      'FAIL'
    );
    expect(detailOf(findings, 'S-prod-legacy-columns')).toContain(
      'blog_posts.body_en'
    );
    expect(detailOf(findings, 'S-prod-legacy-columns')).toContain(
      'portfolio_posts.body_it'
    );
    expect(findings.find((f) => f.id === 'S-prod-consistency')?.status).toBe(
      'FAIL'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'retired legacy body columns'
    );
  });

  it('fails when a legacy body column survives without the contracted plane', () => {
    const findings = evaluate({
      buckets: [...ASSET_BUCKETS, DEV_BUCKET],
      policies: [DEV_POLICY],
      bindings: DEV_BINDINGS,
      prodColumns: [],
      prodConstraints: [],
      prodLegacyColumns: PROD_LEGACY_COLUMNS,
      prodFunctions: [],
    });
    expect(findings.find((f) => f.id === 'S-prod-legacy-columns')?.status).toBe(
      'FAIL'
    );
    expect(findings.find((f) => f.id === 'S-prod-consistency')?.status).toBe(
      'FAIL'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'unexpected=[retired legacy body columns]'
    );
  });

  it('fails when the pointer columns exist without their CHECK constraints', () => {
    const findings = evaluate(facts({ prodConstraints: [] }));
    expect(findings.find((f) => f.id === 'S-prod-checks')?.status).toBe('FAIL');
    expect(detailOf(findings, 'S-prod-checks')).toContain(
      'blog_posts_body_en_path_check'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      '4 canonical CHECK constraints'
    );
  });

  it('fails when only some pointer columns exist', () => {
    const findings = evaluate(facts({ prodColumns: PROD_COLUMNS.slice(0, 3) }));
    expect(findings.find((f) => f.id === 'S-prod-columns')?.status).toBe(
      'FAIL'
    );
    expect(detailOf(findings, 'S-prod-columns')).toContain(
      'portfolio_posts.body_it_path'
    );
  });

  it('fails when the bucket exists without its read policy', () => {
    const findings = evaluate(
      facts({ policies: [DEV_POLICY], bindings: DEV_BINDINGS })
    );
    expect(
      findings.find((f) => f.id === 'S-website_content_body_read')?.status
    ).toBe('FAIL');
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'read policy website_content_body_read'
    );
  });

  it('fails when the read policy exists without the bucket', () => {
    const findings = evaluate(
      facts({ buckets: [...ASSET_BUCKETS, DEV_BUCKET] })
    );
    expect(findings.find((f) => f.id === 'S-bucket-prod')?.status).toBe('FAIL');
    expect(detailOf(findings, 'S-bucket-prod')).toContain(
      'ABSENT while the production content plane is partially installed'
    );
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'bucket website-content'
    );
  });

  it('fails on a weakened production pointer CHECK', () => {
    const findings = evaluate(
      facts({
        prodConstraints: [
          {
            ...PROD_CONSTRAINTS[0],
            definition:
              "CHECK (body_en_path IS NULL OR body_en_path ~ ('^blog/[0-9a-f]{64}\\.md$'::text))",
          },
          ...PROD_CONSTRAINTS.slice(1),
        ],
      })
    );
    expect(findings.find((f) => f.id === 'S-prod-checks')?.status).toBe('FAIL');
    expect(detailOf(findings, 'S-prod-checks')).toContain(
      'missing row-id participation (id)'
    );
  });

  it('fails when a dev pointer CHECK is weakened (unchanged dev contract)', () => {
    const findings = evaluate(
      facts({
        prodConstraints: [
          {
            ...PROD_CONSTRAINTS[0],
            definition: 'CHECK (body_en_path IS NULL)',
          },
          ...PROD_CONSTRAINTS.slice(1),
        ],
      })
    );
    expect(detailOf(findings, 'S-prod-checks')).toContain(
      'missing content-type anchor'
    );
  });
});

describe('checkContentStorageIsolation — query wiring', () => {
  it('reads all seven catalog facts and evaluates the injected state', async () => {
    const seen: string[] = [];
    const queryJson = async (sql: string): Promise<unknown[]> => {
      seen.push(sql);
      if (sql === STORAGE_BUCKETS_QUERY) return CONTRACTED_FACTS.buckets;
      if (sql === STORAGE_POLICIES_QUERY) return CONTRACTED_FACTS.policies;
      if (sql === STORAGE_POLICY_RELATION_BINDINGS_QUERY) {
        return CONTRACTED_FACTS.bindings;
      }
      if (sql === PROD_POINTER_COLUMNS_QUERY) {
        return CONTRACTED_FACTS.prodColumns;
      }
      if (sql === PROD_CONSTRAINTS_QUERY) {
        return CONTRACTED_FACTS.prodConstraints;
      }
      if (sql === PROD_LEGACY_BODY_COLUMNS_QUERY) {
        return CONTRACTED_FACTS.prodLegacyColumns;
      }
      if (sql === PROD_CAS_FUNCTIONS_QUERY) {
        return CONTRACTED_FACTS.prodFunctions;
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    };
    const findings: CheckFinding[] = [];
    await checkContentStorageIsolation(queryJson, findings);
    expect(seen).toEqual([
      STORAGE_BUCKETS_QUERY,
      STORAGE_POLICIES_QUERY,
      STORAGE_POLICY_RELATION_BINDINGS_QUERY,
      PROD_POINTER_COLUMNS_QUERY,
      PROD_CONSTRAINTS_QUERY,
      PROD_LEGACY_BODY_COLUMNS_QUERY,
      PROD_CAS_FUNCTIONS_QUERY,
    ]);
    expect(fails(findings)).toEqual([]);
  });

  it('reports the pre-CP-1 state as valid through the same seam', async () => {
    const queryJson = async (sql: string): Promise<unknown[]> => {
      if (sql === STORAGE_BUCKETS_QUERY) return PRE_CP1_FACTS.buckets;
      if (sql === STORAGE_POLICIES_QUERY) return PRE_CP1_FACTS.policies;
      if (sql === STORAGE_POLICY_RELATION_BINDINGS_QUERY) {
        return PRE_CP1_FACTS.bindings;
      }
      return [];
    };
    const findings: CheckFinding[] = [];
    await checkContentStorageIsolation(queryJson, findings);
    expect(fails(findings)).toEqual([]);
    expect(detailOf(findings, 'S-prod-consistency')).toContain(
      'absent in full'
    );
  });
});

/** Live-shaped dev_staging RBAC mirror rows for the shared runDevCheck fixture. */
const DEV_RBAC_CONSTRAINTS = [
  {
    constraint_name: 'cms_allowed_users_role_check',
    contype: 'c',
    definition:
      "CHECK (role = ANY (ARRAY['editor'::text, 'admin'::text, 'superadmin'::text]))",
  },
];

const DEV_RBAC_TRIGGERS = [
  {
    trigger_name: 'cms_allowed_users_guard_superadmin',
    enabled: 'O',
    trigger_type: 27,
    function_schema: 'dev_staging',
    function_name: 'cms_allowed_users_guard_superadmin',
  },
];

const DEV_RBAC_ALLOWLIST_ACL = [
  {
    table_name: 'cms_allowed_users',
    acl_raw: '{postgres=arwdDxt/postgres,service_role=arwdDxt/postgres}',
  },
];

/**
 * The dev pointer-CHECK contract runs through `runDevCheck`; the ledger rows
 * are rebuilt from the real registry + source bytes so the history stage passes
 * and the K-* findings are reached with injected catalog rows.
 */
async function devConstraintsFindings(
  constraints: ProdConstraintFact[]
): Promise<CheckFinding[]> {
  const repoRoot = process.cwd();
  const registry = await loadRegistry(
    repoRoot,
    'src/libs/cms/devMigrations/registry.json'
  );
  const ledgerRows = await Promise.all(
    registry.map(async (entry) => ({
      version: entry.version,
      name: entry.name,
      source_file: entry.sourceFile,
      source_sha256: createHash('sha256')
        .update(await readFile(path.join(repoRoot, entry.sourceFile)))
        .digest('hex'),
      execution_mode: 'applied',
      recorded_at: null,
    }))
  );
  const queryJson = async (sql: string): Promise<unknown[]> => {
    if (sql === LEDGER_ROWS_QUERY) return ledgerRows;
    if (sql === CONSTRAINTS_QUERY) return constraints;
    if (sql === DEV_RBAC_ROLE_CONSTRAINTS_QUERY) return DEV_RBAC_CONSTRAINTS;
    if (sql === DEV_RBAC_TRIGGERS_QUERY) return DEV_RBAC_TRIGGERS;
    if (sql === DEV_RBAC_RPC_COPIES_QUERY) return [];
    if (sql === DEV_RBAC_ALLOWLIST_ACL_QUERY) return DEV_RBAC_ALLOWLIST_ACL;
    return [];
  };
  const report = await runDevCheck({ repoRoot, queryJson });
  const bodyPathIds = EXPECTED_BODY_PATH_CHECKS.map((want) => `K-${want.name}`);
  return report.findings.filter((f) => bodyPathIds.includes(f.id));
}

describe('dev pointer CHECK contract (regression guard)', () => {
  it('still certifies the four canonical dev pointer CHECKs', async () => {
    const findings = await devConstraintsFindings(PROD_CONSTRAINTS);
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.status === 'PASS')).toBe(true);
  });

  it('still fails on a dev pointer CHECK that lost its id participation', async () => {
    const findings = await devConstraintsFindings([
      {
        ...PROD_CONSTRAINTS[0],
        definition:
          "CHECK (body_en_path IS NULL OR body_en_path ~ ('^blog/[0-9a-f]{64}\\.md$'::text))",
      },
      ...PROD_CONSTRAINTS.slice(1),
    ]);
    const target = findings.find(
      (f) => f.id === 'K-blog_posts_body_en_path_check'
    );
    expect(target?.status).toBe('FAIL');
    expect(target?.detail).toContain('missing row-id participation (id)');
  });
});

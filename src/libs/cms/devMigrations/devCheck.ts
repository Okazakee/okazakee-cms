/**
 * Dev migration check: ledger + source hashes + dev_staging effect proof.
 *
 * Read-only. Uses the logged-in project-local Supabase CLI
 * (`supabase db query --linked -o json`) for live catalog reads and the
 * file system for registry + source bytes. Never mutates, never pushes,
 * never repairs global history. The 7 public/unqualified sources are
 * verified-existing (check-only, never replayed): their ledger rows assert
 * observed-existing effects, not that the original public SQL executed.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runSupabaseQueryJson } from './cliRunner';
import { DEV_SCOPE, normDef, normType } from './sqlGuard';

export type RegistryEntry = {
  version: string;
  name: string;
  sourceFile: string;
};

export type CheckFinding = {
  id: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  detail: string;
};

export type CheckReport = {
  findings: CheckFinding[];
  pass: number;
  fail: number;
  info: number;
  ok: boolean;
};

export const LEDGER_ROWS_QUERY = `select version, name, source_file, source_sha256, execution_mode, recorded_at from dev_staging.cms_migration_audit order by version`;

export const CATALOG_COLUMNS_QUERY = `select c.relname as table_name, a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted_type, not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default_expr, case when a.attidentity = 'a' then 'ALWAYS' when a.attidentity = 'd' then 'BY DEFAULT' end as identity, case when a.attgenerated <> '' then a.attgenerated end as generated_flag, col_description(c.oid, a.attnum) as comment from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum where n.nspname = 'dev_staging' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped order by c.relname, a.attnum`;

export const CONSTRAINTS_QUERY = `select n.nspname as table_schema, c.relname as table_name, con.conname as constraint_name, con.contype::text as contype, pg_get_constraintdef(con.oid, true) as definition from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dev_staging' order by c.relname, con.conname`;

export const INDEXES_QUERY = `select n.nspname as table_schema, c.relname as table_name, i.relname as index_name, ix.indisprimary as is_primary, ix.indisunique as is_unique, am.amname as method, pg_get_indexdef(ix.indexrelid) as indexdef, pg_get_expr(ix.indpred, ix.indrelid) as predicate from pg_index ix join pg_class c on c.oid = ix.indrelid join pg_namespace n on n.oid = c.relnamespace join pg_class i on i.oid = ix.indexrelid join pg_am am on am.oid = i.relam where n.nspname = 'dev_staging' order by c.relname, i.relname`;

export const POLICIES_QUERY = `select n.nspname as table_schema, c.relname as table_name, p.polname as policy_name, p.polcmd::text as cmd, (select array_agg(r.rolname order by r.rolname) from pg_roles r where r.oid = any (p.polroles)) as roles, pg_get_expr(p.polqual, p.polrelid) as using_expr, pg_get_expr(p.polwithcheck, p.polrelid) as with_check_expr from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dev_staging' order by c.relname, p.polname`;

/**
 * Relation bindings of every dev_staging policy, resolved from the catalog
 * (pg_depend holds the OIDs the policy expression actually bound at CREATE
 * time). This is authoritative — unlike a SQL-text scan — so it can prove which
 * SCHEMA a policy relation lives in. The policy's own table is excluded.
 */
export const POLICY_RELATION_BINDINGS_QUERY = `select p.polname as policy_name, n.nspname as table_schema, c.relname as table_name, rn.nspname as ref_schema, rc.relname as ref_relation from pg_depend d join pg_policy p on d.objid = p.oid and d.classid = 'pg_policy'::regclass join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace join pg_class rc on rc.oid = d.refobjid and d.refclassid = 'pg_class'::regclass join pg_namespace rn on rn.oid = rc.relnamespace where n.nspname = 'dev_staging' and rc.oid <> c.oid order by p.polname, rn.nspname, rc.relname`;

export const RLS_QUERY = `select n.nspname as table_schema, c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced, c.relacl as acl_raw from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dev_staging' and c.relkind = 'r' order by c.relname`;
export const SCHEMA_USAGE_QUERY = `select n.nspname as schema_name, n.nspacl as acl_raw from pg_namespace n where n.nspname = 'dev_staging'`;
export const SEQ_GRANTS_QUERY = `select c.relname as sequence_name, c.relacl as acl_raw from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dev_staging' and c.relkind = 'S' and c.relname in ('site_settings_id_seq', 'project_requests_id_seq', 'cms_allowed_users_id_seq') order by c.relname`;
export const FROZEN_TOP_KEYS = [
  'errors',
  'header',
  'footer',
  'skills-section',
  'career-section',
  'posts-section',
  'contacts-section',
  'privacyPolicy',
] as const;
export const DATA_INVARIANTS_QUERY = `select
  (select count(*)::int from dev_staging.portfolio_posts where buttons is null) as buttons_null,
  (select count(*)::int from dev_staging.portfolio_posts where buttons = '[]'::jsonb) as buttons_empty,
  (select count(*)::int from dev_staging.i18n_translations where translations ?| array['errors','header','footer','skills-section','career-section','posts-section','contacts-section','privacyPolicy']) as i18n_frozen_top,
  (select count(*)::int from dev_staging.i18n_translations where (translations #> '{hero-section,top}') ? 'role') as hero_legacy_roles,
  (select count(*)::int from dev_staging.site_settings) as site_settings_rows`;

export const GRANT_MATRIX = {
  site_settings: {
    anon: { SELECT: true, INSERT: false, UPDATE: false, DELETE: false },
    authenticated: {
      SELECT: true,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
    },
    service_role: {
      SELECT: true,
      INSERT: true,
      UPDATE: true,
      DELETE: true,
    },
  },
  project_requests: {
    anon: { SELECT: false, INSERT: false, UPDATE: false, DELETE: false },
    authenticated: {
      SELECT: false,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
    },
    service_role: {
      SELECT: true,
      INSERT: true,
      UPDATE: true,
      DELETE: true,
    },
  },
} as const;

export const EXPECTED_COLS: Record<
  string,
  Array<{
    name: string;
    type: string;
    nullable: boolean;
    def: string | null;
    identity?: string;
  }>
> = {
  skills: [
    { name: 'link', type: 'text', nullable: true, def: null },
    { name: 'position', type: 'integer', nullable: true, def: null },
  ],
  hero_section: [{ name: 'shape', type: 'text', nullable: true, def: null }],
  portfolio_posts: [
    { name: 'buttons', type: 'jsonb', nullable: true, def: null },
  ],
  site_settings: [
    {
      name: 'id',
      type: 'bigint',
      nullable: false,
      def: null,
      identity: 'BY DEFAULT',
    },
    { name: 'created_at', type: 'timestamptz', nullable: false, def: 'now()' },
    { name: 'header_logo_dark', type: 'text', nullable: true, def: null },
    { name: 'header_logo_light', type: 'text', nullable: true, def: null },
    { name: 'footer_vat_number', type: 'text', nullable: true, def: null },
  ],
  project_requests: [
    {
      name: 'id',
      type: 'bigint',
      nullable: false,
      def: null,
      identity: 'BY DEFAULT',
    },
    { name: 'created_at', type: 'timestamptz', nullable: false, def: 'now()' },
    { name: 'locale', type: 'text', nullable: false, def: "'en'::text" },
    { name: 'name', type: 'text', nullable: false, def: null },
    { name: 'email', type: 'text', nullable: false, def: null },
    { name: 'company', type: 'text', nullable: false, def: "''::text" },
    { name: 'website', type: 'text', nullable: false, def: "''::text" },
    { name: 'project_type', type: 'text', nullable: false, def: null },
    { name: 'budget', type: 'text', nullable: false, def: null },
    { name: 'timeline', type: 'text', nullable: false, def: null },
    { name: 'request', type: 'text', nullable: false, def: null },
    { name: 'consent', type: 'boolean', nullable: false, def: null },
    { name: 'archived', type: 'boolean', nullable: false, def: 'false' },
    { name: 'archived_at', type: 'timestamptz', nullable: true, def: null },
  ],
};

export const EXPECTED_CONSTRAINTS = [
  { table: 'project_requests', name: 'project_requests_budget_check' },
  { table: 'project_requests', name: 'project_requests_locale_check' },
  { table: 'project_requests', name: 'project_requests_project_type_check' },
  { table: 'project_requests', name: 'project_requests_timeline_check' },
  { table: 'project_requests', name: 'project_requests_pkey' },
];

/**
 * Indexes `20261017134507_optimize_indexes_dev_staging` must leave present in
 * dev_staging, with the exact column list the application query model relies
 * on. `columns` is compared against the normalized pg_get_indexdef output.
 *
 * `project_requests_active_idx` is asserted by the dedicated
 * `X-project_requests_active_idx` finding in checkConstraintsIndexes (it has a
 * DESC-ordering contract worth its own id), so it is intentionally not
 * duplicated here.
 */
export const EXPECTED_INDEXES_PRESENT = [
  {
    table: 'blog_posts',
    name: 'blog_posts_author_id_idx',
    columns: '(author_id)',
  },
  {
    table: 'portfolio_posts',
    name: 'portfolio_posts_author_id_idx',
    columns: '(author_id)',
  },
  {
    table: 'skills',
    name: 'skills_category_position_id_idx',
    columns: '(category_id, position, id)',
  },
  {
    table: 'skills_categories',
    name: 'skills_categories_position_idx',
    columns: '(position)',
  },
] as const;

/**
 * Redundant/unused indexes the same migration drops: absent here means
 * certified-gone. A surviving index is a FAIL (the redundant `views` indexes
 * and the PK-duplicate `site_settings_single_row_idx`).
 */
export const EXPECTED_INDEXES_ABSENT = [
  'blog_posts_views_idx',
  'portfolio_posts_views_idx',
  'site_settings_single_row_idx',
] as const;

/**
 * Every index name this check certifies (present or must-be-absent), plus the
 * dedicated active-idx finding. The `X-extras` INFO excludes these so it stays
 * a list of genuine unknowns rather than restating certified state.
 */
export const CERTIFIED_INDEX_NAMES: Record<string, true> =
  Object.fromEntries(
    [
      'project_requests_active_idx',
      ...EXPECTED_INDEXES_PRESENT.map((i) => i.name),
      ...EXPECTED_INDEXES_ABSENT,
    ].map((name) => [name, true as const])
  );

/**
 * RLS normalization contract for dev_staging (migration
 * 20261017140338_normalize_rls_dev_staging).
 *
 * `cmd` is the raw pg_policy code (r=SELECT, a=INSERT, w=UPDATE, d=DELETE).
 * `roles` is compared against the sorted, comma-joined role names — omitted
 * where the deparse cannot resolve them (a policy granted TO PUBLIC yields
 * NULL through POLICIES_QUERY's pg_roles join, so presence is asserted
 * without a role comparison there).
 *
 * Expression matching is whitespace-collapsed and `public.`-stripped so it is
 * not brittle to deparser formatting or schema qualification.
 */
type ExpectedPolicy = {
  table: string;
  name: string;
  cmd: string;
  roles?: string;
  /** Exact normalized qual (e.g. `true`). */
  qualEquals?: string;
  /** Substrings that must appear in the normalized qual. */
  qualIncludes?: string[];
  /** Substrings that must appear in the normalized with-check. */
  withCheckIncludes?: string[];
  /** Substrings that must NOT appear in the normalized qual. */
  qualExcludes?: string[];
};

export const EXPECTED_POLICIES_PRESENT: ExpectedPolicy[] = [
  {
    table: 'hero_section',
    name: 'hero_section_public_read',
    cmd: 'r',
    roles: 'anon,authenticated',
    qualEquals: 'true',
  },
  {
    table: 'hero_section',
    name: 'hero_section_insert_admins',
    cmd: 'a',
    roles: 'authenticated',
  },
  {
    table: 'hero_section',
    name: 'hero_section_update_admins',
    cmd: 'w',
    roles: 'authenticated',
  },
  {
    table: 'hero_section',
    name: 'hero_section_delete_admins',
    cmd: 'd',
    roles: 'authenticated',
  },
  {
    table: 'i18n_translations',
    name: 'i18n_translations_public_read',
    cmd: 'r',
    roles: 'anon,authenticated',
    qualEquals: 'true',
  },
  {
    table: 'i18n_translations',
    name: 'Admins can insert i18n_translations',
    cmd: 'a',
  },
  {
    table: 'i18n_translations',
    name: 'Admins can update i18n_translations',
    cmd: 'w',
  },
  {
    table: 'user_profiles',
    name: 'user_profiles_authenticated_read',
    cmd: 'r',
    roles: 'authenticated',
    qualEquals: 'true',
  },
  {
    table: 'user_profiles',
    name: 'user_profiles_public_author_read',
    cmd: 'r',
    roles: 'anon',
    qualIncludes: ['EXISTS', 'blog_posts', 'portfolio_posts', 'author_id'],
    // dev semantics: the author predicate carries no `hidden` filter.
    qualExcludes: ['hidden'],
  },
  {
    table: 'user_profiles',
    name: 'user_profiles_self_update',
    cmd: 'w',
    roles: 'authenticated',
    qualIncludes: ['auth.uid()'],
    withCheckIncludes: ['auth.uid()'],
  },
  {
    table: 'blog_posts',
    name: 'Admins and mods can insert',
    cmd: 'a',
    roles: 'authenticated',
    withCheckIncludes: ["'role'", "'admin'", "'mod'", 'auth.uid()'],
  },
];

/** Redundant/duplicate policies the normalization must remove. */
export const EXPECTED_POLICIES_ABSENT: Array<{
  table: string;
  name: string;
}> = [
  {
    table: 'hero_section',
    name: 'Allow authenticated users to select from hero_section',
  },
  { table: 'hero_section', name: 'Public can read hero_section' },
  { table: 'hero_section', name: 'hero_section_public_select' },
  { table: 'i18n_translations', name: 'Admins can select i18n_translations' },
  { table: 'i18n_translations', name: 'Allow public read access' },
  { table: 'i18n_translations', name: 'Public can select i18n_translations' },
  { table: 'user_profiles', name: 'Admins can read all profiles' },
  { table: 'user_profiles', name: 'Authenticated can read post authors' },
  { table: 'user_profiles', name: 'Authenticated can read profiles' },
  { table: 'user_profiles', name: 'Public can read post authors' },
  { table: 'user_profiles', name: 'Users can read their own profile' },
  { table: 'user_profiles', name: 'Users can update own profile' },
];

/** Policies whose helper calls must be wrapped in a scalar subquery (InitPlan). */
export const INITPLAN_SAFE_POLICIES: Array<{ table: string; name: string }> = [
  { table: 'hero_section', name: 'hero_section_insert_admins' },
  { table: 'hero_section', name: 'hero_section_update_admins' },
  { table: 'hero_section', name: 'hero_section_delete_admins' },
  { table: 'i18n_translations', name: 'Admins can insert i18n_translations' },
  { table: 'i18n_translations', name: 'Admins can update i18n_translations' },
  { table: 'user_profiles', name: 'user_profiles_self_update' },
  { table: 'blog_posts', name: 'Admins and mods can insert' },
];

function parseAcl(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const inner = raw.replace(/^\{|\}$/g, '');
  if (!inner) return out;
  for (const part of inner.split(',')) {
    const m = /^(?:"?([^"=]+)"?)=([^/]*)\/(.*)$/.exec(part.trim());
    if (!m) continue;
    out[m[1] === '' ? 'PUBLIC' : m[1]] = [...m[2]];
  }
  return out;
}

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function loadRegistry(
  repoRoot: string,
  registryPath: string
): Promise<RegistryEntry[]> {
  const raw = await readFile(path.join(repoRoot, registryPath), 'utf8');
  return JSON.parse(raw) as RegistryEntry[];
}

function finding(
  findings: CheckFinding[],
  id: string,
  status: CheckFinding['status'],
  detail: string
): void {
  findings.push({ id, status, detail });
}

export async function runDevCheck(opts?: {
  repoRoot?: string;
  registryPath?: string;
  selectedScope?: string;
  queryJson?: (sql: string) => Promise<unknown[]>;
}): Promise<CheckReport> {
  const findings: CheckFinding[] = [];
  const repoRoot = opts?.repoRoot ?? process.cwd();
  const registryPath =
    opts?.registryPath ?? 'src/libs/cms/devMigrations/registry.json';
  const scope = opts?.selectedScope ?? DEV_SCOPE;
  if (scope !== DEV_SCOPE) {
    return toReport([
      {
        id: 'scope',
        status: 'FAIL',
        detail: `selectedScope must be ${DEV_SCOPE}, got ${scope}`,
      },
    ]);
  }
  const queryJson =
    opts?.queryJson ?? ((sql: string) => runSupabaseQueryJson<unknown>(sql));
  let registry: RegistryEntry[];
  try {
    registry = await loadRegistry(repoRoot, registryPath);
  } catch (e) {
    return toReport([
      {
        id: 'registry',
        status: 'FAIL',
        detail: `cannot read registry ${registryPath}: ${String((e as Error)?.message || e)}`,
      },
    ]);
  }
  if (!Array.isArray(registry) || registry.length === 0) {
    return toReport([
      { id: 'registry', status: 'FAIL', detail: 'registry empty' },
    ]);
  }
  const seen = new Set<string>();
  for (const rawEntry of registry) {
    const isObj =
      typeof rawEntry === 'object' &&
      rawEntry !== null &&
      !Array.isArray(rawEntry);
    const version =
      isObj && typeof (rawEntry as RegistryEntry).version === 'string'
        ? (rawEntry as RegistryEntry).version
        : '';
    const name =
      isObj && typeof (rawEntry as RegistryEntry).name === 'string'
        ? (rawEntry as RegistryEntry).name
        : '';
    const sourceFile =
      isObj && typeof (rawEntry as RegistryEntry).sourceFile === 'string'
        ? (rawEntry as RegistryEntry).sourceFile
        : '';
    if (!isObj || !/^[0-9]{14}$/.test(version)) {
      finding(
        findings,
        `H-${version || '?'}.version`,
        'FAIL',
        'version must be 14 digits'
      );
    }
    if (version && seen.has(version)) {
      finding(
        findings,
        `H-${version}.dup`,
        'FAIL',
        'duplicate registry version'
      );
    }
    if (version) seen.add(version);
    if (!isObj || !name || !sourceFile) {
      finding(
        findings,
        `H-${version || '?'}.shape`,
        'FAIL',
        'entry needs {version,name,sourceFile} as non-empty strings'
      );
    }
  }
  // Source bytes + ledger cross-check.
  let ledgerRows: Array<{
    version: string;
    name: string;
    source_file: string;
    source_sha256: string;
    execution_mode: string;
  }>;
  try {
    ledgerRows = (await queryJson(LEDGER_ROWS_QUERY)) as typeof ledgerRows;
  } catch (e) {
    finding(
      findings,
      'ledger.read',
      'FAIL',
      `dev ledger unreadable (run logged-in, linked project): ${String((e as Error)?.message || e).slice(0, 200)}`
    );
    return toReport(findings);
  }
  const byVersion = new Map(ledgerRows.map((r) => [r.version, r]));
  for (const e of registry) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(repoRoot, e.sourceFile));
    } catch {
      finding(
        findings,
        `H-${e.version}.source`,
        'FAIL',
        `source missing: ${e.sourceFile}`
      );
      continue;
    }
    const sha = sha256Hex(bytes);
    const row = byVersion.get(e.version);
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      finding(
        findings,
        `H-${e.version}.hash-local`,
        'FAIL',
        'local sha unusable'
      );
      continue;
    }
    if (!row) {
      finding(
        findings,
        `H-${e.version}.ledger`,
        'FAIL',
        `ledger MISSING version ${e.version} (history immutable: investigate, never rewrite)`
      );
      continue;
    }
    if (row.source_sha256 !== sha) {
      finding(
        findings,
        `H-${e.version}.hash`,
        'FAIL',
        `source DRIFTED: ledger ${row.source_sha256.slice(0, 12)}.. != file ${sha.slice(0, 12)}.. — never reapply changed history`
      );
      continue;
    }
    if (row.source_file !== e.sourceFile || row.name !== e.name) {
      finding(
        findings,
        `H-${e.version}.meta`,
        'FAIL',
        `ledger name/file mismatch: ledger ${row.name}/${row.source_file} vs registry ${e.name}/${e.sourceFile}`
      );
      continue;
    }
    if (
      row.execution_mode !== 'verified_existing' &&
      row.execution_mode !== 'applied'
    ) {
      finding(
        findings,
        `H-${e.version}.mode`,
        'FAIL',
        `unknown execution_mode ${row.execution_mode}`
      );
      continue;
    }
    finding(
      findings,
      `H-${e.version}`,
      'PASS',
      `${e.version} ${row.execution_mode}: ledger hash matches source bytes`
    );
  }
  for (const r of ledgerRows) {
    if (!seen.has(r.version)) {
      finding(
        findings,
        `H-${r.version}.unregistered`,
        'FAIL',
        `ledger has version absent from registry/history: ${r.version} — registry is the only history`
      );
    }
  }
  finding(
    findings,
    'scope.shared-auth',
    'INFO',
    'shared-auth/global objects (auth.users FK targets, auth.jwt()/is_admin_user() policies, global supabase_migrations history) are NOT certified by this check'
  );
  // Live catalog effects at the same precision as the 93-check audit.
  try {
    await checkColumns(queryJson, findings);
    await checkConstraintsIndexes(queryJson, findings);
    await checkIndexContract(queryJson, findings);
    await checkRlsPoliciesAcls(queryJson, findings);
    await checkRlsNormalization(queryJson, findings);
    await checkAuthorPolicyIsolation(queryJson, findings);
    await checkPostVisibility(queryJson, findings);
    await checkSchemaAndSequences(queryJson, findings);
    await checkDataInvariants(queryJson, findings);
  } catch (e) {
    finding(
      findings,
      'catalog.read',
      'FAIL',
      `catalog read failed: ${String((e as Error)?.message || e).slice(0, 220)}`
    );
  }
  return toReport(findings);
}

function toReport(findings: CheckFinding[]): CheckReport {
  const pass = findings.filter((f) => f.status === 'PASS').length;
  const fail = findings.filter((f) => f.status === 'FAIL').length;
  const info = findings.filter((f) => f.status === 'INFO').length;
  return { findings, pass, fail, info, ok: fail === 0 };
}

async function checkColumns(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const rows = (await queryJson(CATALOG_COLUMNS_QUERY)) as Array<{
    table_name: string;
    name: string;
    formatted_type: string;
    nullable: boolean;
    default_expr: string | null;
    identity: string | null;
    generated_flag: string | null;
    comment: string | null;
  }>;
  const byTable = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? [];
    list.push(r);
    byTable.set(r.table_name, list);
  }
  for (const [table, cols] of Object.entries(EXPECTED_COLS)) {
    const live = new Map((byTable.get(table) ?? []).map((c) => [c.name, c]));
    for (const exp of cols) {
      const got = live.get(exp.name);
      if (!got) {
        finding(
          findings,
          `C-${table}.${exp.name}`,
          'FAIL',
          `dev ${table}.${exp.name} ABSENT in live catalog`
        );
        continue;
      }
      const diffs: string[] = [];
      if (normType(got.formatted_type) !== normType(exp.type)) {
        diffs.push(`type got=${got.formatted_type} exp=${exp.type}`);
      }
      if (Boolean(got.nullable) !== exp.nullable) {
        diffs.push(`nullable got=${got.nullable} exp=${exp.nullable}`);
      }
      const gd = got.default_expr == null ? null : normDef(got.default_expr);
      const ed = exp.def == null ? null : normDef(exp.def);
      if (gd !== ed)
        diffs.push(`default got=${got.default_expr} exp=${exp.def}`);
      if ((exp.identity ?? null) !== (got.identity ?? null)) {
        diffs.push(`identity got=${got.identity} exp=${exp.identity}`);
      }
      if ((got.generated_flag ?? '') !== '') {
        diffs.push(`generated got=${got.generated_flag} exp=''`);
      }
      finding(
        findings,
        `C-${table}.${exp.name}`,
        diffs.length ? 'FAIL' : 'PASS',
        diffs.length
          ? `dev ${table}.${exp.name} diverges: ${diffs.join('; ')}`
          : `dev ${table}.${exp.name}: ${exp.type} ${exp.nullable ? 'NULL' : 'NOT NULL'}${exp.def ? ` DEFAULT ${exp.def}` : ''}${exp.identity ? ` ${exp.identity}` : ''} — matches source spec`
      );
    }
    const expected = new Set(cols.map((c) => c.name));
    const extras = (byTable.get(table) ?? [])
      .map((c) => c.name)
      .filter((n) => !expected.has(n));
    if (extras.length > 0) {
      finding(
        findings,
        `C-${table}.extras`,
        'INFO',
        `pre-existing live columns outside migration scope: ${extras.join(',')}`
      );
    }
  }
}

async function checkConstraintsIndexes(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const cons = (await queryJson(CONSTRAINTS_QUERY)) as Array<{
    table_name: string;
    constraint_name: string;
    contype: string;
    definition: string;
  }>;
  for (const want of EXPECTED_CONSTRAINTS) {
    const got = cons.find(
      (c) => c.table_name === want.table && c.constraint_name === want.name
    );
    if (!got) {
      finding(
        findings,
        `K-${want.name}`,
        'FAIL',
        `constraint ${want.name} ABSENT in live dev catalog`
      );
      continue;
    }
    // Casts/quotes preserved: normalized outside literals only, never erased.
    finding(
      findings,
      `K-${want.name}`,
      'PASS',
      `dev def present (raw deparser, ::text preserved): ${got.definition}`
    );
  }
  const idx = (await queryJson(INDEXES_QUERY)) as Array<{
    table_name: string;
    index_name: string;
    indexdef: string;
    predicate: string | null;
  }>;
  const active = idx.find(
    (x) =>
      x.table_name === 'project_requests' &&
      x.index_name === 'project_requests_active_idx'
  );
  const idxOk =
    !!active &&
    normDef(active.indexdef).includes('(archived, created_at DESC)') &&
    (active.predicate ?? null) === null;
  finding(
    findings,
    'X-project_requests_active_idx',
    idxOk ? 'PASS' : 'FAIL',
    idxOk
      ? `dev def identical (raw indexdef, no predicate, btree, DESC kept): ${active?.indexdef}`
      : `remote=${active?.indexdef} predicate=${active?.predicate} — drift or missing`
  );
  const others = idx.filter(
    (x) =>
      CERTIFIED_INDEX_NAMES[x.index_name] !== true &&
      !x.index_name.endsWith('_pkey') &&
      !x.index_name.endsWith('_key')
  );
  if (others.length > 0) {
    finding(
      findings,
      'X-extras',
      'INFO',
      `pre-existing/extra indexes, never deletion authorization: ${others.map((x) => x.index_name).join(',')}`
    );
  }
}

/**
 * Certifies the dev_staging index contract established by
 * 20261017134507_optimize_indexes_dev_staging: the FK-support and composite
 * indexes must be present with their exact column lists, and the redundant
 * `views` / PK-duplicate indexes must be absent. `project_requests_active_idx`
 * keeps its own `X-project_requests_active_idx` finding above.
 */
async function checkIndexContract(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const idx = (await queryJson(INDEXES_QUERY)) as Array<{
    table_name: string;
    index_name: string;
    indexdef: string;
    predicate: string | null;
  }>;
  const byName = new Map(idx.map((x) => [x.index_name, x]));
  for (const want of EXPECTED_INDEXES_PRESENT) {
    const got = byName.get(want.name);
    // Identifier quoting is dropped so the expectation is not brittle about
    // keywords the deparser quotes (e.g. `("position")`); column order and the
    // rest of the definition are still compared verbatim.
    const def = got ? normDef(got.indexdef).replace(/"/g, '') : '';
    const ok =
      !!got &&
      got.table_name === want.table &&
      def.includes(want.columns) &&
      (got.predicate ?? null) === null;
    finding(
      findings,
      `X-${want.name}`,
      ok ? 'PASS' : 'FAIL',
      ok
        ? `dev ${want.name} present on ${want.table} ${want.columns} (raw indexdef, no predicate): ${got?.indexdef}`
        : `remote=${
            got
              ? `${got.table_name} ${got.indexdef} predicate=${got.predicate}`
              : 'ABSENT'
          } — expected on ${want.table} ${want.columns}`
    );
  }
  for (const name of EXPECTED_INDEXES_ABSENT) {
    const got = byName.get(name);
    finding(
      findings,
      `X-absent:${name}`,
      got ? 'FAIL' : 'PASS',
      got
        ? `obsolete index ${name} still present in dev dev_staging: ${got.indexdef}`
        : `obsolete index ${name} absent (redundant/unused; dropped by 20261017134507_optimize_indexes_dev_staging)`
    );
  }
}

/** Sorted, comma-joined role names for a pg_policies roles string. */
function policyRolesOf(raw: string | null): string {
  return (raw ?? '')
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

/** Collapse deparser whitespace and drop schema qualification for comparison. */
function normalizePolicyExpr(expr: string | null): string {
  return (expr ?? '').replace(/\bpublic\./g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Helper calls (`auth.jwt()`, `auth.uid()`, `is_admin_user()`) that appear
 * OUTSIDE a scalar subquery, i.e. still evaluated once per row. The wrapped
 * form deparses as `( SELECT <call> AS <alias>)`, so a safe call is always
 * immediately preceded by `SELECT `.
 */
function unwrappedHelperCalls(expr: string | null): string[] {
  if (!expr) return [];
  const normalized = normalizePolicyExpr(expr);
  const bad = new Set<string>();
  for (const call of ['auth.jwt()', 'auth.uid()', 'is_admin_user()']) {
    let i = normalized.indexOf(call);
    while (i >= 0) {
      const before = normalized.slice(Math.max(0, i - 7), i).toLowerCase();
      if (!/select $/.test(before)) bad.add(call);
      i = normalized.indexOf(call, i + 1);
    }
  }
  return [...bad];
}

/**
 * Certifies the dev_staging RLS normalization (migration
 * 20261017140338_normalize_rls_dev_staging): the collapsed policy set is
 * present, the redundant/duplicate policies are gone, and every retained
 * `auth.*` / `is_admin_user()` call is wrapped in a scalar subquery so it is
 * evaluated once instead of per row.
 */
async function checkRlsNormalization(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const pols = (await queryJson(POLICIES_QUERY)) as Array<{
    table_name: string;
    policy_name: string;
    cmd: string;
    roles: string | null;
    using_expr: string | null;
    with_check_expr: string | null;
  }>;
  const key = (table: string, name: string): string => `${table}.${name}`;
  const byKey = new Map(
    pols.map((p) => [key(p.table_name, p.policy_name), p])
  );

  for (const want of EXPECTED_POLICIES_PRESENT) {
    const got = byKey.get(key(want.table, want.name));
    if (!got) {
      finding(
        findings,
        `R-${want.name}`,
        'FAIL',
        `policy ${key(want.table, want.name)} ABSENT in live dev_staging`
      );
      continue;
    }
    const diffs: string[] = [];
    if (got.cmd !== want.cmd) diffs.push(`cmd got=${got.cmd} exp=${want.cmd}`);
    if (want.roles !== undefined && policyRolesOf(got.roles) !== want.roles) {
      diffs.push(`roles got=${got.roles} exp=${want.roles}`);
    }
    const qual = normalizePolicyExpr(got.using_expr);
    const check = normalizePolicyExpr(got.with_check_expr);
    if (want.qualEquals !== undefined && qual !== want.qualEquals) {
      diffs.push(`qual got=${got.using_expr} exp=${want.qualEquals}`);
    }
    for (const needle of want.qualIncludes ?? []) {
      if (!qual.includes(needle)) diffs.push(`qual missing ${needle}`);
    }
    for (const needle of want.withCheckIncludes ?? []) {
      if (!check.includes(needle)) diffs.push(`with_check missing ${needle}`);
    }
    for (const needle of want.qualExcludes ?? []) {
      if (qual.includes(needle)) diffs.push(`qual unexpectedly has ${needle}`);
    }
    finding(
      findings,
      `R-${want.name}`,
      diffs.length ? 'FAIL' : 'PASS',
      diffs.length
        ? `policy ${key(want.table, want.name)} diverges: ${diffs.join('; ')}`
        : `dev policy present (cmd=${got.cmd}${want.roles !== undefined ? `, roles=${got.roles}` : ''})`
    );
  }

  for (const gone of EXPECTED_POLICIES_ABSENT) {
    const got = byKey.get(key(gone.table, gone.name));
    finding(
      findings,
      `R-absent:${gone.name}`,
      got ? 'FAIL' : 'PASS',
      got
        ? `redundant policy ${key(gone.table, gone.name)} still present in dev_staging (cmd=${got.cmd})`
        : `redundant policy ${key(gone.table, gone.name)} absent (normalized by 20261017140338)`
    );
  }

  for (const want of INITPLAN_SAFE_POLICIES) {
    const got = byKey.get(key(want.table, want.name));
    if (!got) {
      finding(
        findings,
        `R-initplan:${want.name}`,
        'FAIL',
        `policy ${key(want.table, want.name)} ABSENT — InitPlan form not certifiable`
      );
      continue;
    }
    const unsafe = [
      ...unwrappedHelperCalls(got.using_expr),
      ...unwrappedHelperCalls(got.with_check_expr),
    ];
    finding(
      findings,
      `R-initplan:${want.name}`,
      unsafe.length ? 'FAIL' : 'PASS',
      unsafe.length
        ? `policy ${key(want.table, want.name)} still evaluates ${unsafe.join(', ')} per row (not wrapped in a scalar subquery)`
        : `policy ${key(want.table, want.name)} wraps every auth helper in a scalar subquery (InitPlan-safe)`
    );
  }
}

/**
 * Schema-isolation contract for the dev author-profile policy (migration
 * 20261017160247_isolate_dev_author_profile_policy): its predicate must bind to
 * the dev clone's own post tables and never to production's. Compared against
 * pg_depend relation OIDs so it proves the resolved SCHEMA rather than the
 * presence of a table name in the deparsed SQL.
 */
export const AUTHOR_POLICY_TARGET = 'user_profiles_public_author_read';

export const AUTHOR_POLICY_DEV_RELATIONS: string[] = [
  'dev_staging.blog_posts',
  'dev_staging.portfolio_posts',
];

export const AUTHOR_POLICY_FORBIDDEN_RELATIONS: string[] = [
  'public.blog_posts',
  'public.portfolio_posts',
];

/**
 * Certifies that the dev author-profile policy reads ONLY the dev clone's post
 * tables. A surviving `public.*` binding is the environment-isolation leak this
 * phase removes; a missing dev binding means the policy is absent or still
 * binds production.
 */
async function checkAuthorPolicyIsolation(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const rows = (await queryJson(POLICY_RELATION_BINDINGS_QUERY)) as Array<{
    policy_name: string;
    ref_schema: string;
    ref_relation: string;
  }>;
  const actual = rows
    .filter((r) => r.policy_name === AUTHOR_POLICY_TARGET)
    .map((r) => `${r.ref_schema}.${r.ref_relation}`)
    .sort();
  const missing = AUTHOR_POLICY_DEV_RELATIONS.filter(
    (rel) => !actual.includes(rel)
  );
  const leaked = actual.filter((rel) =>
    AUTHOR_POLICY_FORBIDDEN_RELATIONS.includes(rel)
  );
  const unexpected = actual.filter(
    (rel) =>
      !AUTHOR_POLICY_DEV_RELATIONS.includes(rel) &&
      !AUTHOR_POLICY_FORBIDDEN_RELATIONS.includes(rel)
  );
  const ok =
    actual.length > 0 &&
    missing.length === 0 &&
    leaked.length === 0 &&
    unexpected.length === 0;
  finding(
    findings,
    'R-user_profiles-author-schema',
    ok ? 'PASS' : 'FAIL',
    ok
      ? `policy ${AUTHOR_POLICY_TARGET} binds only ${AUTHOR_POLICY_DEV_RELATIONS.join(' + ')} (pg_depend OIDs, no production relation)`
      : `policy ${AUTHOR_POLICY_TARGET} relation bindings = ${JSON.stringify(actual)}; expected=${JSON.stringify(AUTHOR_POLICY_DEV_RELATIONS)}; missing=${JSON.stringify(missing)}; production-leak=${JSON.stringify(leaked)}; unexpected=${JSON.stringify(unexpected)}`
  );
}

/**
 * Post-visibility contract for dev_staging (migration
 * 20261017165547_harden_post_reads_dev_staging): the public read policy on both
 * post tables must restrict anon/authenticated to `hidden = false`, and must
 * NOT carry a publish-date predicate — scheduling stays an application concern
 * so future unhidden posts remain previewable in dev/staging.
 */
export const POST_VISIBILITY_POLICY = 'cms_published_read';

export const POST_VISIBILITY_TABLES: string[] = [
  'blog_posts',
  'portfolio_posts',
];

export const POST_VISIBILITY_SUPERSEDED_POLICIES: Array<{
  table: string;
  name: string;
}> = [
  { table: 'blog_posts', name: 'Allow public read access to blog_posts' },
  { table: 'portfolio_posts', name: 'Public can read posts' },
];

async function checkPostVisibility(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const pols = (await queryJson(POLICIES_QUERY)) as Array<{
    table_name: string;
    policy_name: string;
    cmd: string;
    roles: string | null;
    using_expr: string | null;
  }>;
  const key = (table: string, name: string): string => `${table}.${name}`;
  const byKey = new Map(
    pols.map((p) => [key(p.table_name, p.policy_name), p])
  );

  for (const table of POST_VISIBILITY_TABLES) {
    const got = byKey.get(key(table, POST_VISIBILITY_POLICY));
    if (!got) {
      finding(
        findings,
        `R-visibility:${table}`,
        'FAIL',
        `policy ${key(table, POST_VISIBILITY_POLICY)} ABSENT in live dev_staging`
      );
      continue;
    }
    const qual = normalizePolicyExpr(got.using_expr);
    const diffs: string[] = [];
    if (got.cmd !== 'r') diffs.push(`cmd got=${got.cmd} exp=r`);
    if (policyRolesOf(got.roles) !== 'anon,authenticated') {
      diffs.push(`roles got=${got.roles} exp=anon,authenticated`);
    }
    if (!qual.includes('hidden = false')) {
      diffs.push(`qual missing "hidden = false" (got=${got.using_expr})`);
    }
    if (qual.includes('created_at')) {
      diffs.push('qual carries a created_at publish-date predicate');
    }
    finding(
      findings,
      `R-visibility:${table}`,
      diffs.length ? 'FAIL' : 'PASS',
      diffs.length
        ? `dev ${table} ${POST_VISIBILITY_POLICY} diverges: ${diffs.join('; ')}`
        : `dev ${table} ${POST_VISIBILITY_POLICY}: SELECT to anon,authenticated USING (hidden = false), no publish-date predicate`
    );
  }

  for (const gone of POST_VISIBILITY_SUPERSEDED_POLICIES) {
    const got = byKey.get(key(gone.table, gone.name));
    finding(
      findings,
      `R-visibility-absent:${key(gone.table, gone.name)}`,
      got ? 'FAIL' : 'PASS',
      got
        ? `permissive policy ${key(gone.table, gone.name)} still present (cmd=${got.cmd}, using=${got.using_expr})`
        : `superseded permissive policy ${key(gone.table, gone.name)} absent (replaced by ${POST_VISIBILITY_POLICY})`
    );
  }
}

async function checkRlsPoliciesAcls(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const rls = (await queryJson(RLS_QUERY)) as Array<{
    table_name: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    acl_raw: string | null;
  }>;
  for (const t of ['site_settings', 'project_requests']) {
    const row = rls.find((r) => r.table_name === t);
    const ok = !!row && row.rls_enabled === true && row.rls_forced !== true;
    finding(
      findings,
      `P-${t}.rls`,
      ok ? 'PASS' : 'FAIL',
      `RLS enforced, not forced: enabled=${row?.rls_enabled} forced=${row?.rls_forced}`
    );
  }
  const pols = (await queryJson(POLICIES_QUERY)) as Array<{
    table_name: string;
    policy_name: string;
    cmd: string;
    roles: string | null;
    using_expr: string | null;
    with_check_expr: string | null;
  }>;
  const spol = pols.filter((p) => p.table_name === 'site_settings');
  const rolesOf = (s: string | null): string | null => {
    if (s == null) return null;
    return String(s)
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .sort()
      .join(',');
  };
  const siteOk =
    spol.length === 1 &&
    spol[0].cmd === 'r' &&
    rolesOf(spol[0].roles) === 'anon,authenticated' &&
    normDef(spol[0].using_expr ?? '') === 'true' &&
    (spol[0].with_check_expr ?? null) === null;
  finding(
    findings,
    'P-site_settings.policy',
    siteOk ? 'PASS' : 'FAIL',
    siteOk
      ? 'exactly site_settings_public_read, SELECT TO {anon,authenticated}, USING(true), no WITH CHECK (raw pg_get_expr)'
      : `remote=${JSON.stringify(spol.map((p) => ({ n: p.policy_name, cmd: p.cmd, roles: p.roles, using: p.using_expr, check: p.with_check_expr })))}`
  );
  const ppol = pols.filter((p) => p.table_name === 'project_requests' && p.cmd);
  finding(
    findings,
    'P-project_requests.policy',
    ppol.length === 0 ? 'PASS' : 'FAIL',
    ppol.length === 0
      ? 'ZERO live policies; RLS deny-all + service_role bypass'
      : `unexpected policies: ${JSON.stringify(ppol.map((p) => p.policy_name))}`
  );
  const others = pols.filter(
    (p) => !['site_settings', 'project_requests'].includes(p.table_name)
  );
  if (others.length > 0) {
    finding(
      findings,
      'O-policies',
      'INFO',
      `non-content policies on ${JSON.stringify([...new Set(others.map((p) => p.table_name))])} depend on shared-auth objects: out of scope, not compared`
    );
  }
  for (const [t, matrix] of Object.entries(GRANT_MATRIX)) {
    const aclRaw = rls.find((r) => r.table_name === t)?.acl_raw;
    if (aclRaw == null) {
      finding(
        findings,
        `A-${t}`,
        'FAIL',
        `no raw ACL for dev ${t} in live capture`
      );
      continue;
    }
    const acl = parseAcl(aclRaw);
    const bad: string[] = [];
    for (const role of Object.keys(matrix)) {
      const want = (matrix as Record<string, Record<string, boolean>>)[role];
      for (const [priv, code] of Object.entries({
        SELECT: 'r',
        INSERT: 'a',
        UPDATE: 'w',
        DELETE: 'd',
      })) {
        const has = (acl[role] ?? []).includes(code);
        if (has !== want[priv]) bad.push(`${role}/${priv}=${has}`);
      }
    }
    if (acl.PUBLIC) bad.push(`PUBLIC entry present: ${acl.PUBLIC.join('')}`);
    finding(
      findings,
      `A-${t}`,
      bad.length ? 'FAIL' : 'PASS',
      bad.length
        ? `dev ACL diverges from source matrix: ${bad.join('; ')}; raw=${aclRaw}`
        : `dev ACL identical to source matrix; raw=${aclRaw}`
    );
  }
}

async function checkSchemaAndSequences(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  const schemas = (await queryJson(SCHEMA_USAGE_QUERY)) as Array<{
    schema_name: string;
    acl_raw: string | null;
  }>;
  const raw = schemas.find((s) => s.schema_name === 'dev_staging')?.acl_raw;
  if (raw == null) {
    finding(
      findings,
      'Q-schema-usage',
      'FAIL',
      'no raw schema ACL for dev_staging'
    );
  } else {
    const acl = parseAcl(raw);
    const usage = (role: string): boolean => (acl[role] ?? []).includes('U');
    const create = (role: string): boolean => (acl[role] ?? []).includes('C');
    const ok =
      usage('anon') &&
      usage('authenticated') &&
      usage('service_role') &&
      !create('anon');
    finding(
      findings,
      'Q-schema-usage',
      ok ? 'PASS' : 'FAIL',
      ok
        ? `schema USAGE anon/authenticated/service_role, no anon CREATE; raw=${raw}`
        : `schema ACL diverges (expect USAGE anon/auth/service_role, no anon CREATE); raw=${raw}`
    );
  }
  const seqs = (await queryJson(SEQ_GRANTS_QUERY)) as Array<{
    sequence_name: string;
    acl_raw: string | null;
  }>;
  for (const name of [
    'site_settings_id_seq',
    'project_requests_id_seq',
    'cms_allowed_users_id_seq',
  ]) {
    const aclRaw = seqs.find((s) => s.sequence_name === name)?.acl_raw;
    if (aclRaw == null) {
      finding(findings, `Q-${name}`, 'FAIL', `no raw sequence ACL for ${name}`);
      continue;
    }
    const acl = parseAcl(aclRaw);
    const bad: string[] = [];
    if (!(acl.service_role ?? []).includes('U'))
      bad.push('service_role/USAGE=false');
    const requiresSelect = name !== 'cms_allowed_users_id_seq';
    if (requiresSelect && !(acl.service_role ?? []).includes('r'))
      bad.push('service_role/SELECT=false');
    if ((acl.anon ?? []).includes('U')) bad.push('anon/USAGE=true');
    if ((acl.anon ?? []).includes('r')) bad.push('anon/SELECT=true');
    if ((acl.authenticated ?? []).includes('U'))
      bad.push('authenticated/USAGE=true');
    if ((acl.authenticated ?? []).includes('r'))
      bad.push('authenticated/SELECT=true');
    finding(
      findings,
      `Q-${name}`,
      bad.length ? 'FAIL' : 'PASS',
      bad.length
        ? `dev seq ACL diverges: ${bad.join('; ')}; raw=${aclRaw}`
        : `dev seq ACL matches (service_role USAGE${requiresSelect ? '+SELECT' : ''}); raw=${aclRaw}`
    );
  }
}

async function checkDataInvariants(
  queryJson: (sql: string) => Promise<unknown[]>,
  findings: CheckFinding[]
): Promise<void> {
  // Privacy-safe counts only — never row contents.
  const rows = (await queryJson(DATA_INVARIANTS_QUERY)) as Array<{
    buttons_null: number;
    buttons_empty: number;
    i18n_frozen_top: number;
    hero_legacy_roles: number;
    site_settings_rows: number;
  }>;
  const r = rows[0];
  if (!r) {
    finding(
      findings,
      'D-invariants',
      'FAIL',
      'data invariant query returned no row'
    );
    return;
  }
  const backfillOk = r.buttons_null === 0;
  finding(
    findings,
    'D-backfill',
    backfillOk ? 'PASS' : 'FAIL',
    backfillOk
      ? `portfolio_posts buttons NULL=0 (empty=${r.buttons_empty}): backfill fully applied`
      : `portfolio_posts buttons NULL=${r.buttons_null} (empty=${r.buttons_empty}): backfill incomplete or regressed`
  );
  finding(
    findings,
    'D-freeze',
    r.i18n_frozen_top === 0 ? 'PASS' : 'FAIL',
    `site-owned namespaces remaining in dev content: ${r.i18n_frozen_top}`
  );
  finding(
    findings,
    'D-hero-roles',
    r.hero_legacy_roles === 0 ? 'PASS' : 'FAIL',
    `legacy singular hero role rows remaining: ${r.hero_legacy_roles}`
  );
  finding(
    findings,
    'F-data',
    'INFO',
    `VAT is editable: ${r.site_settings_rows} configured or unconfigured rows are allowed`
  );
}

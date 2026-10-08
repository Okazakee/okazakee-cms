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
    await checkRlsPoliciesAcls(queryJson, findings);
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
      x.index_name !== 'project_requests_active_idx' &&
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

/**
 * Isolated, SCHEMA-AWARE PostgREST fixture for the legacy-body retirement
 * rehearsal.
 *
 * The existing `src/testing/unit/supabaseFake.ts` is an in-memory table map: a
 * query that names a column the real schema does not have still "succeeds"
 * there, so it cannot answer "does the application still work once `body_en` /
 * `body_it` are gone?". This fixture closes exactly that gap. It is a
 * supabase-js-shaped client whose statements are translated into SQL and run
 * against a REAL Postgres (PGlite, WASM), so column absence, CHECK constraints,
 * NOT NULL, NULL comparison and row cardinality are all enforced by the
 * database, not by a hand-written mock.
 *
 * The schema is not hand-written either. It is derived from the real reviewed
 * artifacts, in the order the release plan mandates:
 *
 *   1. the CMS-shaped pre-contraction tables (metadata + legacy `body_en`
 *      `NOT NULL` / `body_it` + no pointers);
 *   2. `supabase/review/prod_markdown_backfill_cas.sql` — the production
 *      pointer columns, the four canonical pointer CHECK constraints and the
 *      two `prod_backfill_*` CAS functions;
 *   3. `supabase/review/prod_legacy_body_en_drop_not_null.sql` — the
 *      non-destructive step that makes `body_en` nullable, which is what lets
 *      the write shim be turned off while the column still exists;
 *   4. `supabase/review/prod_legacy_body_retirement.sql` — the contraction:
 *      the CAS functions and the four legacy columns are dropped, pointers and
 *      CHECKs are untouched.
 *
 * The CMS read path (GET_BODIES) and the CMS editor path (BATCH_PUBLISH:
 * create / edit / metadata-only update / delete) are then exercised through the
 * real action code against that database.
 *
 * Fidelity notes (deliberate, and documented as limitations of the rehearsal):
 *   - Storage is an in-memory bucket map, not the real Storage service. Object
 *     bytes and call order are recorded; RLS, limits and MIME typing are not.
 *   - PostgREST's `select` string parser is approximated: a select list is a
 *     plain comma-separated column list, which is all the application uses. A
 *     named column that does not exist reaches Postgres and fails there with
 *     the real `42703`; a payload column that does not exist is relabelled to
 *     PostgREST's `PGRST204` (PostgREST rejects those before building SQL, from
 *     its schema cache).
 *   - `src/utils/supabase/*` would normally attach the environment's schema;
 *     the fixture always runs against `public.*`, which is the schema the
 *     retirement artifacts target.
 *   - The tables are the CMS-facing subset of the real content tables (the
 *     columns the admin actions and the detail read use). Columns no exercised
 *     path touches are omitted on purpose, so the rehearsal cannot pass because
 *     of an over-permissive table.
 *
 * This module is a test helper (like `src/testing/unit/supabaseFake.ts` and
 * `src/testing/sql/prodBackfillPostgresFixture.ts`), not a test: it exports no
 * assertions.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The legacy Markdown columns the contraction removes. */
export const RETIRED_BODY_COLUMNS = ['body_en', 'body_it'] as const;
export type RetiredBodyColumn = (typeof RETIRED_BODY_COLUMNS)[number];

/** The four canonical pointer constraints the contraction must preserve. */
export const POINTER_PATH_CHECKS = [
  'blog_posts_body_en_path_check',
  'blog_posts_body_it_path_check',
  'portfolio_posts_body_en_path_check',
  'portfolio_posts_body_it_path_check',
] as const;

const CAS_SQL_PATH = fileURLToPath(
  new URL(
    '../../../supabase/review/prod_markdown_backfill_cas.sql',
    import.meta.url
  )
);
const DROP_NOT_NULL_SQL_PATH = fileURLToPath(
  new URL(
    '../../../supabase/review/prod_legacy_body_en_drop_not_null.sql',
    import.meta.url
  )
);
const RETIREMENT_SQL_PATH = fileURLToPath(
  new URL(
    '../../../supabase/review/prod_legacy_body_retirement.sql',
    import.meta.url
  )
);

const sqlCache = new Map<string, Promise<string>>();

/** Reads a reviewed SQL artifact once per process. */
function readSqlArtifact(path: string): Promise<string> {
  const cached = sqlCache.get(path);
  if (cached) return cached;
  const read = readFile(path, 'utf8');
  sqlCache.set(path, read);
  return read;
}

/**
 * Which shape of the schema a scenario runs against, named for the release
 * plan's steps so the rehearsal matches the runbook:
 *
 * - `contracted`     — after step 7: no legacy columns, no `prod_backfill_*`
 *                      functions, pointers and CHECKs intact.
 * - `legacy-nullable`— after step 4, at step 5: `body_en` still exists and is
 *                      nullable, so a shim-off write path is valid. This is the
 *                      negative control (the same payloads must keep working
 *                      with the columns present).
 * - `legacy-not-null`— steps 1-3: the pre-relaxation production shape, where
 *                      `body_en NOT NULL` is why the shim exists.
 */
export type ContentSchemaShape =
  | 'contracted'
  | 'legacy-nullable'
  | 'legacy-not-null';

/**
 * The CMS-facing content tables on the pre-contraction shape: every column the
 * admin actions read or write, plus the legacy body columns exactly as
 * production declares them (`body_en NOT NULL`, `body_it` nullable). Pointer
 * columns, CHECK constraints and the nullability relaxation are NOT here — they
 * come from the reviewed artifacts, so the rehearsal exercises the real DDL.
 */
const PRE_CONTRACTION_SCHEMA_SQL = `
  create role anon;
  create role authenticated;
  create role service_role;

  create table public.blog_posts (
    id bigserial primary key,
    title_en text not null default '',
    title_it text not null default '',
    description_en text not null default '',
    description_it text not null default '',
    image text not null default '',
    "blurhashURL" text not null default '',
    post_tags text not null default '',
    author_id text not null default '',
    hidden boolean not null default false,
    created_at timestamptz not null default now(),
    body_en text not null,
    body_it text
  );

  create table public.portfolio_posts (
    id bigserial primary key,
    title_en text not null default '',
    title_it text not null default '',
    description_en text not null default '',
    description_it text not null default '',
    image text not null default '',
    "blurhashURL" text not null default '',
    post_tags text not null default '',
    author_id text not null default '',
    hidden boolean not null default false,
    created_at timestamptz not null default now(),
    buttons jsonb,
    website text,
    source_link text,
    demo_link text,
    store_link text,
    fdroid_link text,
    ios_store_link text,
    body_en text not null,
    body_it text
  );

  create table public.cms_allowed_users (
    email text primary key,
    github_user_id text,
    github_username text,
    role text not null
  );
`;

/**
 * Opens an isolated database on the requested shape by running the reviewed
 * artifacts in the order the release plan mandates: pre-contraction tables, then
 * the CAS artifact (pointers + CHECKs + functions), then — unless the shape is
 * the pre-relaxation one — the preliminary nullability step, and finally the
 * contraction for `contracted`.
 */
export async function openContentDatabase(
  shape: ContentSchemaShape
): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(PRE_CONTRACTION_SCHEMA_SQL);
  await db.exec(await readSqlArtifact(CAS_SQL_PATH));
  if (shape !== 'legacy-not-null') {
    await db.exec(await readSqlArtifact(DROP_NOT_NULL_SQL_PATH));
  }
  if (shape === 'contracted') {
    await db.exec(await readSqlArtifact(RETIREMENT_SQL_PATH));
  }
  return db;
}

/** Column names of one `public` table, as the database reports them. */
export async function tableColumns(
  db: PGlite,
  table: string
): Promise<string[]> {
  const res = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by column_name`,
    [table]
  );
  return res.rows.map((row) => row.column_name);
}

/** Names of the `body_*_path` CHECK constraints present in `public`. */
export async function pointerPathChecks(db: PGlite): Promise<string[]> {
  const res = await db.query<{ conname: string }>(
    `select conname from pg_constraint
      where conname like '%body_%_path_check' order by conname`
  );
  return res.rows.map((row) => row.conname);
}

/** Names of the `prod_backfill_*` functions still present in `public`. */
export async function prodBackfillFunctions(db: PGlite): Promise<string[]> {
  const res = await db.query<{ proname: string }>(
    `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'prod_backfill%'
      order by p.proname`
  );
  return res.rows.map((row) => row.proname);
}

/** `true` when the column is nullable, `false` when it carries NOT NULL. */
export async function columnNullable(
  db: PGlite,
  table: string,
  column: string
): Promise<boolean> {
  const res = await db.query<{ is_nullable: string }>(
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column]
  );
  return res.rows[0]?.is_nullable === 'YES';
}

/** Rows of one table, newest id first. Used for "what actually landed" checks. */
export async function tableRows(
  db: PGlite,
  table: string
): Promise<Record<string, unknown>[]> {
  const res = await db.query<Record<string, unknown>>(
    `select * from public.${quoteIdentifier(table)} order by id`
  );
  return res.rows;
}

/** One row by id, or `null`. */
export async function rowById(
  db: PGlite,
  table: string,
  id: number
): Promise<Record<string, unknown> | null> {
  const res = await db.query<Record<string, unknown>>(
    `select * from public.${quoteIdentifier(table)} where id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

/** Clears content rows so each scenario starts from a known state. */
export async function resetContentRows(db: PGlite): Promise<void> {
  await db.exec(
    'truncate table public.blog_posts, public.portfolio_posts restart identity'
  );
}

/**
 * Inserts a row using only the columns that exist in this shape. A value for a
 * RETIRED column is dropped (that is what "this row predates the contraction"
 * means on the contracted shape); a value for any other missing column is a
 * fixture bug and throws.
 */
export async function insertExistingColumns(
  db: PGlite,
  table: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const columns = await tableColumns(db, table);
  const entries = Object.entries(values).filter(([column]) => {
    if (columns.includes(column)) return true;
    if ((RETIRED_BODY_COLUMNS as readonly string[]).includes(column)) {
      return false;
    }
    throw new Error(
      `[postgrest-fixture] column '${column}' does not exist on public.${table}`
    );
  });
  const params: unknown[] = [];
  const placeholders = entries.map(([, value]) => {
    params.push(jsonValue(value));
    const placeholder = `$${params.length}`;
    return isJsonValue(value) ? `${placeholder}::jsonb` : placeholder;
  });
  const res = await db.query<Record<string, unknown>>(
    `insert into public.${quoteIdentifier(table)}
       (${entries.map(([column]) => quoteIdentifier(column)).join(', ')})
     values (${placeholders.join(', ')}) returning *`,
    params
  );
  return res.rows[0];
}

function isJsonValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function jsonValue(value: unknown): unknown {
  return isJsonValue(value) ? JSON.stringify(value) : value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`[postgrest-fixture] unsafe identifier '${identifier}'`);
  }
  return `"${identifier}"`;
}

/** One statement the client executed, as the boundary observed it. */
export type PostgrestStatement = {
  table: string;
  mode: 'select' | 'insert' | 'update' | 'delete';
  /** Requested select/returning projection; `''` when no rows were requested. */
  projection: string;
  /**
   * Column names carried by an insert/update payload, exactly as the caller
   * named them (an `undefined` value is recorded even though the wire encoding
   * drops it, because naming a retired column is the thing under audit).
   */
  payloadColumns: string[];
  /** Filter columns, in the order the client applied them. */
  filterColumns: string[];
  /** Rows returned/affected; `-1` when the statement errored. */
  rows: number;
  /** PostgREST-shaped error code when the statement failed. */
  errorCode: string | null;
  /** Monotonic order across statements AND Storage calls, to prove sequencing. */
  at: number;
};

/** One bucket-scoped Storage call. */
export type StorageCall = {
  bucket: string;
  op: 'upload' | 'download' | 'remove' | 'list' | 'copy';
  path: string;
  /** Monotonic order across statements AND Storage calls. */
  at: number;
};

export type PostgrestFixtureState = {
  statements: PostgrestStatement[];
  storage: StorageCall[];
  /** Object bytes by `${bucket}/${path}`. */
  objects: Map<string, Uint8Array>;
};

export type PostgrestError = {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
};

/** Column names a projection names, exactly (`body_en_path` is not `body_en`). */
export function projectionColumns(projection: string): string[] {
  if (projection === '' || projection === '*') return [];
  return projection
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

export type RetiredColumnReference = {
  statement: PostgrestStatement;
  column: RetiredBodyColumn;
};

/**
 * Every reference to a retired column in a statement log — projections,
 * payloads and filters alike. Comparison is by exact column name, so the
 * surviving `body_<locale>_path` pointers never count as a hit and a real
 * `body_en` reference can never hide behind one.
 */
export function retiredColumnReferences(
  statements: readonly PostgrestStatement[]
): RetiredColumnReference[] {
  const references: RetiredColumnReference[] = [];
  for (const statement of statements) {
    const candidates = [
      ...projectionColumns(statement.projection),
      ...statement.payloadColumns,
      ...statement.filterColumns,
    ];
    for (const column of candidates) {
      if ((RETIRED_BODY_COLUMNS as readonly string[]).includes(column)) {
        references.push({ statement, column: column as RetiredBodyColumn });
      }
    }
  }
  return references;
}

/** Object keys (`path` only) currently held in one bucket. */
export function objectsInBucket(
  state: PostgrestFixtureState,
  bucket: string
): string[] {
  const prefix = `${bucket}/`;
  return [...state.objects.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

/** Storage calls made against one bucket. */
export function storageCallsIn(
  state: PostgrestFixtureState,
  bucket: string
): StorageCall[] {
  return state.storage.filter((call) => call.bucket === bucket);
}

// ── supabase-js-shaped query builder over PGlite ─────────────────────────

type QueryFilter = { column: string; operator: string; value: unknown };

type QueryMode = 'select' | 'insert' | 'update' | 'delete';

type QueryResult = { data: unknown; error: PostgrestError | null };

const FILTER_OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
};

class PgliteQueryBuilder implements PromiseLike<QueryResult> {
  private mode: QueryMode = 'select';
  private projection = '*';
  private payload: Record<string, unknown> | null = null;
  private filters: QueryFilter[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private cardinality: 'single' | 'maybeSingle' | null = null;
  private returning = false;

  constructor(
    private readonly db: PGlite,
    private readonly state: PostgrestFixtureState,
    private readonly table: string,
    private readonly stamp: () => number
  ) {}

  select(columns = '*'): this {
    this.projection = columns;
    this.returning = true;
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]): this {
    if (Array.isArray(payload)) {
      throw new Error(
        '[postgrest-fixture] multi-row inserts are not modelled; the rehearsal never uses one'
      );
    }
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'eq', value });
  }

  neq(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'neq', value });
  }

  gt(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'gt', value });
  }

  gte(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'gte', value });
  }

  lt(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'lt', value });
  }

  lte(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'lte', value });
  }

  like(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'like', value });
  }

  ilike(column: string, value: unknown): this {
    return this.addFilter({ column, operator: 'ilike', value });
  }

  /** PostgREST's `is`: identity against NULL/boolean, never a bound value. */
  is(column: string, value: null | boolean): this {
    return this.addFilter({ column, operator: 'is', value });
  }

  in(column: string, values: unknown[]): this {
    return this.addFilter({ column, operator: 'in', value: values });
  }

  filter(column: string, operator: string, value: unknown): this {
    return this.addFilter({ column, operator, value });
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orderBy = { column, ascending: options.ascending ?? true };
    return this;
  }

  limit(rows: number): this {
    this.rowLimit = rows;
    return this;
  }

  single(): this {
    this.cardinality = 'single';
    return this;
  }

  maybeSingle(): this {
    this.cardinality = 'maybeSingle';
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable by design.
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private addFilter(filter: QueryFilter): this {
    this.filters.push(filter);
    return this;
  }

  private async execute(): Promise<QueryResult> {
    const statement: PostgrestStatement = {
      table: this.table,
      mode: this.mode,
      projection: this.returning ? this.projection : '',
      payloadColumns: this.payload ? Object.keys(this.payload) : [],
      filterColumns: this.filters.map((filter) => filter.column),
      rows: -1,
      errorCode: null,
      at: this.stamp(),
    };
    this.state.statements.push(statement);

    try {
      const rows = await this.run();
      statement.rows = rows.length;
      if (this.cardinality === 'single' && rows.length !== 1) {
        statement.errorCode = 'PGRST116';
        return { data: null, error: objectRequestedError(rows.length) };
      }
      if (this.cardinality === 'maybeSingle' && rows.length === 0) {
        return { data: null, error: null };
      }
      if (this.cardinality) return { data: rows[0] ?? null, error: null };
      return { data: this.returning ? rows : null, error: null };
    } catch (error) {
      const shaped = toPostgrestError(
        error,
        this.table,
        statement.payloadColumns
      );
      statement.errorCode = shaped.code;
      return { data: null, error: shaped };
    }
  }

  private async run(): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [];
    const where = this.whereClause(params);
    const returning = this.returning ? this.projectionList() : 'id';

    if (this.mode === 'select') {
      const res = await this.db.query<Record<string, unknown>>(
        `select ${this.projectionList()} from public.${quoteIdentifier(this.table)}${where}${this.orderClause()}${this.limitClause()}`,
        params
      );
      return res.rows;
    }

    if (this.mode === 'insert') {
      // supabase-js sends the payload as JSON, so an `undefined` value never
      // reaches PostgREST and the column default applies. Mirror that exactly.
      const entries = Object.entries(this.payload ?? {}).filter(
        ([, value]) => value !== undefined
      );
      if (entries.length === 0) {
        throw new Error(
          '[postgrest-fixture] insert payload carries no defined column'
        );
      }
      const columns = entries
        .map(([column]) => quoteIdentifier(column))
        .join(', ');
      const values = entries
        .map(([, value]) => {
          params.push(jsonValue(value));
          const placeholder = `$${params.length}`;
          return isJsonValue(value) ? `${placeholder}::jsonb` : placeholder;
        })
        .join(', ');
      const res = await this.db.query<Record<string, unknown>>(
        `insert into public.${quoteIdentifier(this.table)} (${columns}) values (${values}) returning ${returning}`,
        params
      );
      return res.rows;
    }

    if (this.mode === 'update') {
      const entries = Object.entries(this.payload ?? {}).filter(
        ([, value]) => value !== undefined
      );
      if (entries.length === 0) {
        throw new Error(
          '[postgrest-fixture] update payload carries no defined column'
        );
      }
      const assignments = entries
        .map(([column, value]) => {
          params.push(jsonValue(value));
          const placeholder = `$${params.length}`;
          return `${quoteIdentifier(column)} = ${isJsonValue(value) ? `${placeholder}::jsonb` : placeholder}`;
        })
        .join(', ');
      const res = await this.db.query<Record<string, unknown>>(
        `update public.${quoteIdentifier(this.table)} set ${assignments}${where} returning ${returning}`,
        params
      );
      return res.rows;
    }

    const res = await this.db.query<Record<string, unknown>>(
      `delete from public.${quoteIdentifier(this.table)}${where} returning ${returning}`,
      params
    );
    return res.rows;
  }

  private projectionList(): string {
    if (this.projection === '*') return '*';
    return projectionColumns(this.projection).map(quoteIdentifier).join(', ');
  }

  private whereClause(params: unknown[]): string {
    if (this.filters.length === 0) return '';
    const clauses = this.filters.map((filter) => {
      const column = quoteIdentifier(filter.column);
      if (filter.operator === 'is') {
        if (filter.value === null) return `${column} is null`;
        if (filter.value === true) return `${column} is true`;
        if (filter.value === false) return `${column} is false`;
        throw new Error(
          `[postgrest-fixture] 'is' only supports null/boolean, got ${String(filter.value)}`
        );
      }
      if (filter.operator === 'in') {
        const values = filter.value as unknown[];
        if (values.length === 0) return 'false';
        const placeholders = values.map((value) => {
          params.push(jsonValue(value));
          return `$${params.length}`;
        });
        return `${column} in (${placeholders.join(', ')})`;
      }
      const operator = FILTER_OPERATORS[filter.operator];
      if (!operator) {
        throw new Error(
          `[postgrest-fixture] unsupported filter operator '${filter.operator}'`
        );
      }
      params.push(jsonValue(filter.value));
      return `${column} ${operator} $${params.length}`;
    });
    return ` where ${clauses.join(' and ')}`;
  }

  private orderClause(): string {
    if (!this.orderBy) return '';
    return ` order by ${quoteIdentifier(this.orderBy.column)} ${this.orderBy.ascending ? 'asc' : 'desc'}`;
  }

  private limitClause(): string {
    return this.rowLimit === null ? '' : ` limit ${this.rowLimit}`;
  }
}

function objectRequestedError(count: number): PostgrestError {
  return {
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
    details: `The result contains ${count} rows`,
    hint: null,
  };
}

/**
 * PostgREST-shaped error for a Postgres failure. PostgREST validates
 * insert/update payload columns against its schema cache and answers
 * `PGRST204`; Postgres reports the same absence as `42703` from the statement,
 * so the code is relabelled while everything else is passed through.
 */
function toPostgrestError(
  error: unknown,
  table: string,
  payloadColumns: readonly string[]
): PostgrestError {
  const pg = error as {
    message?: string;
    code?: string;
    detail?: string | null;
    hint?: string | null;
  };
  const message = pg.message ?? String(error);
  const payloadColumn = payloadColumns.find((column) =>
    message.includes(`"${column}" of relation`)
  );
  if (pg.code === '42703' && payloadColumn) {
    return {
      code: 'PGRST204',
      message: `Could not find the '${payloadColumn}' column of '${table}' in the schema cache`,
      details: null,
      hint: null,
    };
  }
  return {
    code: pg.code ?? 'PGRST000',
    message,
    details: pg.detail ?? null,
    hint: pg.hint ?? null,
  };
}

// ── in-memory Storage bucket, keyed the way the application addresses it ──

function createStorageApi(
  state: PostgrestFixtureState,
  bucket: string,
  stamp: () => number
) {
  const key = (path: string) => `${bucket}/${path}`;
  const record = (op: StorageCall['op'], path: string): void => {
    state.storage.push({ bucket, op, path, at: stamp() });
  };

  return {
    async upload(
      path: string,
      data: unknown,
      options?: { upsert?: boolean }
    ): Promise<{ data: unknown; error: unknown }> {
      record('upload', path);
      if (state.objects.has(key(path)) && !options?.upsert) {
        return {
          data: null,
          error: {
            message: 'The resource already exists',
            statusCode: '409',
            error: 'Duplicate',
          },
        };
      }
      state.objects.set(key(path), toBytes(data));
      return { data: { path }, error: null };
    },

    async download(path: string): Promise<{ data: unknown; error: unknown }> {
      record('download', path);
      const stored = state.objects.get(key(path));
      if (stored === undefined) {
        return { data: null, error: { message: 'Object not found' } };
      }
      // Supabase Storage resolves a Blob; mirror that exact shape so the
      // payload coercion in the read path is the production one. The part is
      // backed by a plain ArrayBuffer, which TS 7's BlobPart requires.
      return {
        data: new Blob([
          stored.buffer.slice(
            stored.byteOffset,
            stored.byteOffset + stored.byteLength
          ) as ArrayBuffer,
        ]),
        error: null,
      };
    },

    async remove(paths: string[]): Promise<{ data: unknown; error: unknown }> {
      for (const path of paths) {
        record('remove', path);
        state.objects.delete(key(path));
      }
      return { data: paths.map((path) => ({ name: path })), error: null };
    },

    async copy(
      fromPath: string,
      toPath: string
    ): Promise<{ data: unknown; error: unknown }> {
      record('copy', toPath);
      const from = state.objects.get(key(fromPath));
      if (from === undefined) {
        return { data: null, error: { message: 'Source object not found' } };
      }
      state.objects.set(key(toPath), from);
      return { data: { path: toPath }, error: null };
    },

    /** Children of a prefix, as the Storage list API reports them. */
    async list(
      prefix?: string,
      options?: { limit?: number; offset?: number }
    ): Promise<{ data: unknown; error: unknown }> {
      record('list', prefix ?? '');
      const base = prefix ? `${bucket}/${prefix}/` : `${bucket}/`;
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;
      const seen = new Map<string, { name: string; id: string | null }>();
      for (const full of state.objects.keys()) {
        if (!full.startsWith(base)) continue;
        const rest = full.slice(base.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash >= 0) {
          const folder = rest.slice(0, slash);
          if (!seen.has(folder)) seen.set(folder, { name: folder, id: null });
        } else {
          seen.set(rest, { name: rest, id: full });
        }
      }
      return {
        data: [...seen.values()].slice(offset, offset + limit),
        error: null,
      };
    },

    getPublicUrl(path: string): { data: { publicUrl: string } } {
      return {
        data: {
          publicUrl: `https://fixture.supabase.co/storage/v1/object/public/${bucket}/${path}`,
        },
      };
    },
  };
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('[postgrest-fixture] unsupported upload payload type');
}

export type PostgrestFixtureOptions = {
  /** Authenticated user `auth.getUser()` reports. */
  user?: { id: string; email: string } | null;
};

export type PostgrestFixture = {
  client: SupabaseClient;
  state: PostgrestFixtureState;
};

/**
 * A supabase-js-shaped client whose statements run as SQL against `db`.
 *
 * Every statement (projection, payload columns, filter columns, result count,
 * error code) and every Storage call is recorded in `state`, which is what the
 * rehearsal asserts over.
 */
export function createPostgrestFixture(
  db: PGlite,
  options: PostgrestFixtureOptions = {}
): PostgrestFixture {
  const state: PostgrestFixtureState = {
    statements: [],
    storage: [],
    objects: new Map(),
  };
  let nextStamp = 0;
  const stamp = () => nextStamp++;
  const user =
    options.user === undefined
      ? { id: 'user-1', email: 'admin@example.com' }
      : options.user;

  const client = {
    from: (table: string) => new PgliteQueryBuilder(db, state, table, stamp),
    storage: {
      from: (bucket: string) => createStorageApi(state, bucket, stamp),
    },
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
    },
  } as unknown as SupabaseClient;

  return { client, state };
}

export type { PGlite };

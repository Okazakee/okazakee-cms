/**
 * Isolated PostgreSQL fixture for the production Markdown backfill suites.
 *
 * It runs the REAL, REVIEW-ONLY production artifacts against a real Postgres
 * (PGlite, WASM) on a production-like starting schema, and adapts that database
 * to the exact interfaces the production tooling consumes:
 *
 *   - `ReadOnlyPostBodyClient`  — what the production planner reads through;
 *   - `CasRpcClient`            — what the real CAS client calls, so the SHARED
 *                                 `createBackfillCasApi` logic (local argument
 *                                 validation, RPC mapping, outcome decoding) is
 *                                 exercised end to end, not a stub;
 *   - `readCommittedBody` / `readCommittedPointer` — what the shared executor
 *                                 and rollback verify against.
 *
 * Nothing here touches the live project: it is an in-memory WASM database
 * seeded with SYNTHETIC rows shaped like the production baseline (6 blog rows,
 * 11 portfolio rows, both locales populated), plus metadata and a visibility
 * column so "nothing else changed" and "hidden versus visible" can be asserted
 * against whole-row snapshots.
 *
 * This module is a test helper (like `src/testing/unit/supabaseFake.ts`), not a
 * test: it exports no assertions.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type {
  BackfillEntryReport,
  BackfillExecutorDeps,
  RollbackDeps,
} from '@/libs/cms/storage/backfillApply';
import {
  type CasRpcClient,
  createBackfillCasApi,
} from '@/libs/cms/storage/backfillCas';
import { PROD_BACKFILL_ENVIRONMENT } from '@/libs/cms/storage/backfillEnvironment';
import {
  createPostBodyReader,
  type PostBodyReader,
  type ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';
import type {
  BodyContentKind,
  BodyContentLocale,
  BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';

/** The production CAS artifact, exactly as it would be promoted. */
export const PROD_CAS_SQL_PATH = fileURLToPath(
  new URL(
    '../../../supabase/review/prod_markdown_backfill_cas.sql',
    import.meta.url
  )
);

let cachedCasSql: string | null = null;

/** The production CAS artifact, read once from `supabase/review/`. */
export async function readProdCasSql(): Promise<string> {
  if (cachedCasSql === null) {
    cachedCasSql = await readFile(PROD_CAS_SQL_PATH, 'utf8');
  }
  return cachedCasSql;
}

export type FixtureSeedRow = {
  kind: BodyContentKind;
  id: number;
  bodyEn: string;
  bodyIt: string;
  /** Visibility, used to assert hidden content migrates identically. */
  published: boolean;
  /** Metadata that a "metadata-only edit" may change without affecting work. */
  titleEn: string;
};

/** 6 blog rows + 11 portfolio rows, both locales populated (17 posts / 34 bodies). */
export const FIXTURE_SEED: FixtureSeedRow[] = [
  {
    kind: 'blog',
    id: 1,
    bodyEn: '# Blog 1 EN 🎉\r\n\r\nünïcodé ✓\r\n',
    bodyIt: '# Blog 1 IT à\n\ncorpo\n',
    published: true,
    titleEn: 'blog-1',
  },
  {
    kind: 'blog',
    id: 8,
    bodyEn: '# Blog 8 EN\n\nsecond post\n',
    bodyIt: '# Blog 8 IT\n\nsecondo\n',
    published: true,
    titleEn: 'blog-8',
  },
  {
    kind: 'blog',
    id: 9,
    bodyEn: '# Blog 9 EN\n\nthird\n',
    bodyIt: '# Blog 9 IT\n\nterzo\n',
    published: false,
    titleEn: 'blog-9',
  },
  {
    kind: 'blog',
    id: 12,
    bodyEn: '# Blog 12 EN\n\nfourth\n',
    bodyIt: '# Blog 12 IT\n\nquarto\n',
    published: true,
    titleEn: 'blog-12',
  },
  {
    kind: 'blog',
    id: 18,
    bodyEn: '# Blog 18 EN\n\nfifth\n',
    bodyIt: '# Blog 18 IT\n\nquinto\n',
    published: false,
    titleEn: 'blog-18',
  },
  {
    kind: 'blog',
    id: 19,
    bodyEn: '# Blog 19 EN\n\nsixth\n',
    bodyIt: '# Blog 19 IT\n\nsesto\n',
    published: true,
    titleEn: 'blog-19',
  },
  {
    kind: 'portfolio',
    id: 1,
    bodyEn: '# Portfolio 1 EN\n\ncase study one\n',
    bodyIt: '# Portfolio 1 IT\n\ncaso uno\n',
    published: true,
    titleEn: 'portfolio-1',
  },
  {
    kind: 'portfolio',
    id: 2,
    bodyEn: '# Portfolio 2 EN\n\ntwo\n',
    bodyIt: '# Portfolio 2 IT\n\ndue\n',
    published: true,
    titleEn: 'portfolio-2',
  },
  {
    kind: 'portfolio',
    id: 3,
    bodyEn: '# Portfolio 3 EN\n\nthree\n',
    bodyIt: '# Portfolio 3 IT\n\ntre\n',
    published: true,
    titleEn: 'portfolio-3',
  },
  {
    kind: 'portfolio',
    id: 4,
    bodyEn: '# Portfolio 4 EN\n\nfour\n',
    bodyIt: '# Portfolio 4 IT\n\nquattro\n',
    published: false,
    titleEn: 'portfolio-4',
  },
  {
    kind: 'portfolio',
    id: 5,
    bodyEn: '# Portfolio 5 EN\n\nfive\n',
    bodyIt: '# Portfolio 5 IT\n\ncinque\n',
    published: true,
    titleEn: 'portfolio-5',
  },
  {
    kind: 'portfolio',
    id: 21,
    bodyEn: '# Portfolio 21 EN\n\ntwenty-one\n',
    bodyIt: '# Portfolio 21 IT\n\nventuno\n',
    published: true,
    titleEn: 'portfolio-21',
  },
  {
    kind: 'portfolio',
    id: 22,
    bodyEn: '# Portfolio 22 EN\n\ntwenty-two\n',
    bodyIt: '# Portfolio 22 IT\n\nventidue\n',
    published: true,
    titleEn: 'portfolio-22',
  },
  {
    kind: 'portfolio',
    id: 23,
    bodyEn: '# Portfolio 23 EN\n\ntwenty-three\n',
    bodyIt: '# Portfolio 23 IT\n\nventitre\n',
    published: true,
    titleEn: 'portfolio-23',
  },
  {
    kind: 'portfolio',
    id: 24,
    bodyEn: '# Portfolio 24 EN\n\ntwenty-four\n',
    bodyIt: '# Portfolio 24 IT\n\nventiquattro\n',
    published: false,
    titleEn: 'portfolio-24',
  },
  {
    kind: 'portfolio',
    id: 25,
    bodyEn: '# Portfolio 25 EN\n\ntwenty-five\n',
    bodyIt: '# Portfolio 25 IT\n\nventicinque\n',
    published: true,
    titleEn: 'portfolio-25',
  },
  {
    kind: 'portfolio',
    id: 26,
    bodyEn: '# Portfolio 26 EN\n\ntwenty-six\n',
    bodyIt: '# Portfolio 26 IT\n\nventisei\n',
    published: true,
    titleEn: 'portfolio-26',
  },
];

export const FIXTURE_TABLES: Record<BodyContentKind, string> = {
  blog: 'blog_posts',
  portfolio: 'portfolio_posts',
};

/** Postgres error shape the fixture surfaces the way PostgREST would. */
export type PostgrestishError = { message: string };

type QueryResult<T> = { rows: T[] };

export type PgliteLike = {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

/**
 * The production-like starting schema: the roles the artifact's GRANT block
 * references, the two content tables WITHOUT pointer columns, plus a metadata
 * and a visibility column so "only the pointer column changed" is provable.
 */
export const LEGACY_SCHEMA_SQL = `
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.blog_posts (
    id bigint primary key,
    body_en text not null,
    body_it text,
    title_en text not null default '',
    published boolean not null default true
  );
  create table public.portfolio_posts (
    id bigint primary key,
    body_en text not null,
    body_it text,
    title_en text not null default '',
    published boolean not null default true
  );
`;

/** Opens an isolated database on the pre-schema (legacy-only) shape. */
export async function openLegacyDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(LEGACY_SCHEMA_SQL);
  return db;
}

/** Installs the reviewed production artifact (columns, constraints, functions). */
export async function applyProdCasSql(db: PgliteLike): Promise<void> {
  await db.exec(await readProdCasSql());
}

export async function seedFixture(
  db: PgliteLike,
  rows: FixtureSeedRow[] = FIXTURE_SEED
): Promise<void> {
  for (const row of rows) {
    await db.query(
      `insert into public.${FIXTURE_TABLES[row.kind]}
         (id, body_en, body_it, title_en, published)
       values ($1, $2, $3, $4, $5)`,
      [row.id, row.bodyEn, row.bodyIt, row.titleEn, row.published]
    );
  }
}

/** Clears every pointer, leaving the legacy bodies exactly as they are. */
export async function resetPointers(db: PgliteLike): Promise<void> {
  await db.exec(
    'update public.blog_posts set body_en_path = null, body_it_path = null'
  );
  await db.exec(
    'update public.portfolio_posts set body_en_path = null, body_it_path = null'
  );
}

export type RowSnapshot = {
  id: number;
  body_en: string | null;
  body_it: string | null;
  body_en_path: string | null;
  body_it_path: string | null;
  title_en: string;
  published: boolean;
};

/** Whole-row snapshot, used to prove that only a pointer column ever changes. */
export async function snapshotRow(
  db: PgliteLike,
  kind: BodyContentKind,
  id: number
): Promise<RowSnapshot> {
  const res = await db.query<RowSnapshot>(
    `select id, body_en, body_it, body_en_path, body_it_path, title_en, published
       from public.${FIXTURE_TABLES[kind]} where id = $1`,
    [id]
  );
  return res.rows[0];
}

export async function snapshotAll(
  db: PgliteLike
): Promise<Record<string, RowSnapshot>> {
  const out: Record<string, RowSnapshot> = {};
  for (const row of FIXTURE_SEED) {
    out[`${row.kind}:${row.id}`] = await snapshotRow(db, row.kind, row.id);
  }
  return out;
}

export async function readPointer(
  db: PgliteLike,
  kind: BodyContentKind,
  id: number,
  locale: BodyContentLocale
): Promise<string | null> {
  const column = locale === 'en' ? 'body_en_path' : 'body_it_path';
  const res = await db.query<{ path: string | null }>(
    `select ${column} as path from public.${FIXTURE_TABLES[kind]} where id = $1`,
    [id]
  );
  return res.rows[0]?.path ?? null;
}

/* -------------------------------------------------------------------------- */
/* Adapters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The read-only client the production planner accepts. A missing column comes
 * back as a Postgrest-shaped error (not a throw), exactly like PostgREST, so the
 * pre-schema inventory can be exercised against a database that really lacks
 * the pointer columns.
 */
export function createPgliteReadOnlyClient(
  db: PgliteLike
): ReadOnlyPostBodyClient {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            async order(
              column: string,
              options?: { ascending?: boolean }
            ): Promise<{
              data: unknown[] | null;
              error: PostgrestishError | null;
            }> {
              const direction = options?.ascending === false ? 'desc' : 'asc';
              try {
                const res = await db.query(
                  `select ${columns} from public.${table} order by ${column} ${direction}`
                );
                return { data: res.rows, error: null };
              } catch (error) {
                return {
                  data: null,
                  error: {
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                };
              }
            },
          };
        },
      };
    },
  };
}

/** The pointer-aware production reader (bodies + committed pointers). */
export function createPglitePlanReader(
  db: PgliteLike,
  mode: 'inventory' | 'manifest' = 'manifest'
): PostBodyReader {
  return createPostBodyReader(createPgliteReadOnlyClient(db), {
    columns:
      mode === 'manifest'
        ? PROD_BACKFILL_ENVIRONMENT.projections.pointers
        : PROD_BACKFILL_ENVIRONMENT.projections.bodies,
    schema: PROD_BACKFILL_ENVIRONMENT.schema,
    label: 'prod-backfill-plan',
  });
}

type CasRow = { outcome: string; reason: string | null };

/** Every RPC the fixture saw, so "no CAS call on a refusal path" is assertable. */
export type CasCallLog = Array<{ fn: string; args: Record<string, unknown> }>;

/**
 * The real CAS client over the real SQL: `createBackfillCasApi` validates and
 * maps the arguments exactly as it does in production, and the SQL guard decides
 * the outcome.
 */
export function createPgliteCas(
  db: PgliteLike,
  spec = PROD_BACKFILL_ENVIRONMENT,
  calls: CasCallLog = []
) {
  const rpc: CasRpcClient = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      const forward = fn === spec.cas.forward;
      const rollback = fn === spec.cas.rollback;
      if (!forward && !rollback) {
        return { data: null, error: { message: `unknown function ${fn}` } };
      }
      // The two artifacts share the (kind, id, locale, hash, ..., path) shape;
      // only the middle argument differs (expected_previous vs installed_path).
      const params = forward
        ? [
            args.p_kind,
            args.p_post_id,
            args.p_locale,
            args.p_expected_sha256,
            args.p_expected_previous,
            args.p_new_path,
          ]
        : [
            args.p_kind,
            args.p_post_id,
            args.p_locale,
            args.p_installed_path,
            args.p_expected_sha256,
            args.p_previous_path,
          ];
      try {
        const res = await db.query<CasRow>(
          `select outcome, reason from public.${fn}($1, $2, $3, $4, $5, $6)`,
          params
        );
        return { data: res.rows, error: null };
      } catch (error) {
        return {
          data: null,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
  return { api: createBackfillCasApi(rpc, spec), calls };
}

/** Committed-body / committed-pointer readers over the fixture database. */
export function createPgliteReaders(db: PgliteLike): {
  readCommittedBody: BackfillExecutorDeps['readCommittedBody'];
  readCommittedPointer: BackfillExecutorDeps['readCommittedPointer'];
} {
  const read = async (
    kind: BodyContentKind,
    postId: number,
    column: 'body_en' | 'body_it' | 'body_en_path' | 'body_it_path'
  ): Promise<string | null> => {
    const res = await db.query<Record<string, string | null>>(
      `select ${column} from public.${FIXTURE_TABLES[kind]} where id = $1`,
      [postId]
    );
    const value = res.rows[0]?.[column];
    return typeof value === 'string' ? value : null;
  };
  return {
    readCommittedBody: (kind, postId, locale) =>
      read(kind, postId, `body_${locale}`),
    readCommittedPointer: (kind, postId, locale) =>
      read(kind, postId, `body_${locale}_path`),
  };
}

export type StorageCalls = {
  uploads: string[];
  downloads: string[];
  removes: string[];
  /** Paths whose upload/empty-response should fail, for failure injection. */
  failUpload?: (path: string) => string | null;
  failDownload?: (path: string) => string | null;
};

/**
 * The immutable, content-addressed Storage surface the shared executor expects,
 * backed by a Map so exact bytes and call history are assertable. `upsert:false`
 * semantics and the already-exists path mirror `uploadBodyContent`.
 */
export function createRecordingStorage(
  objects: Map<string, Buffer>,
  calls: StorageCalls
): BodyContentStorageApi {
  return {
    async upload(path, body, options) {
      calls.uploads.push(path);
      if (options?.upsert !== false) {
        return { data: null, error: { message: 'fixture refuses upsert' } };
      }
      const injected = calls.failUpload?.(path);
      if (injected) return { data: null, error: { message: injected } };
      if (objects.has(path)) {
        return {
          data: null,
          error: { code: 'ResourceAlreadyExists', message: 'already exists' },
        };
      }
      objects.set(path, Buffer.from(body as Buffer));
      return { data: { path }, error: null };
    },
    async download(path) {
      calls.downloads.push(path);
      const injected = calls.failDownload?.(path);
      if (injected) return { data: null, error: { message: injected } };
      const found = objects.get(path);
      return found
        ? { data: found, error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
    async remove(paths) {
      calls.removes.push(...paths);
      return { data: null, error: null };
    },
  };
}

export type InvalidationCalls = Array<{
  entity: string;
  operation: string;
  ids: number[];
}>;

/** Signed-invalidation stand-in, with a switchable answer and full call log. */
export function createRecordingInvalidation(
  calls: InvalidationCalls = [],
  status: () => 'sent' | 'failed' | 'skipped' = () => 'sent'
): RollbackDeps['invalidate'] {
  return async (args) => {
    calls.push({
      entity: args.entity,
      operation: args.operation,
      ids: [...args.ids],
    });
    return status();
  };
}

/** Outcome codes of the failed entries in a run report. */
export function failedOutcomes(entries: BackfillEntryReport[]) {
  return entries
    .filter(
      (entry) =>
        entry.outcome !== 'UPLOADED_AND_POINTED' &&
        entry.outcome !== 'ALREADY_CURRENT'
    )
    .map(
      (entry) =>
        `${entry.kind}:${entry.postId}:${entry.locale}=${entry.outcome}`
    );
}

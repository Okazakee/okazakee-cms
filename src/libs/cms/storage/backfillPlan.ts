/**
 * Phase 11A — READ-ONLY Markdown backfill planner (dev only).
 *
 * Plans the migration of the existing `dev_staging` Markdown columns
 * (`body_en` / `body_it`) into immutable content-addressed objects in the
 * private `website-content-dev` bucket, producing an auditable manifest before
 * any mutation is authorized.
 *
 * What this module deliberately is NOT:
 *   - it never uploads, downloads or deletes an object;
 *   - it never writes, updates or deletes a row;
 *   - it never touches `body_en` / `body_it` or an existing pointer;
 *   - it never normalizes Markdown (exact UTF-8 bytes are the identity).
 *
 * The only database surface it accepts is a structurally narrowed, read-only
 * client (`from(table).select(columns).order(column)`), so a mutation call is
 * not expressible through this module's dependency type at all. Hashing, byte
 * sizes, the 1 MiB limit and the canonical object key all come from the shared
 * `bodyContent` contract — nothing here re-implements them.
 */
import {
  bodyContentPath,
  prepareBodyContent,
  type BodyContentKind,
  type BodyContentLocale,
} from '@/libs/cms/storage/bodyContent';
import { CONTENT_BUCKET_DEV } from '@/libs/cms/storage/contentBucket';

/** CLI name (matches the `package.json` script). */
export const BACKFILL_PLAN_COMMAND = 'storage:content:dev:backfill:plan';

/** The only project this dev-only planner may ever run against. */
export const EXPECTED_DEV_PROJECT_REF = 'mtvwynyikouqzmhqespl';

/** The only schema and destination bucket this planner may read/plan for. */
export const BACKFILL_PLAN_SCHEMA = 'dev_staging';
export const BACKFILL_PLAN_BUCKET = CONTENT_BUCKET_DEV;

/** Explicit projection — the planner reads bodies and pointers, nothing else. */
export const BACKFILL_PLAN_COLUMNS =
  'id,body_en,body_it,body_en_path,body_it_path';

/** Stable manifest order: blog before portfolio, EN before IT. */
export const BACKFILL_PLAN_KINDS: BodyContentKind[] = ['blog', 'portfolio'];
export const BACKFILL_PLAN_LOCALES: BodyContentLocale[] = ['en', 'it'];

export const POST_BODY_TABLES: Record<BodyContentKind, string> = {
  blog: 'blog_posts',
  portfolio: 'portfolio_posts',
};

export type BackfillAction =
  | 'UPLOAD_AND_POINT'
  | 'ALREADY_CURRENT'
  | 'SKIP_EMPTY'
  | 'BLOCKED';

/** One planned unit of work: a single locale of a single post. */
export type BackfillPlanEntry = {
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  /** SHA-256 of the exact legacy UTF-8 bytes; null when there is no body. */
  sourceSha256: string | null;
  sizeBytes: number;
  /** Canonical destination key; null when nothing would be uploaded. */
  expectedPath: string | null;
  /** Pointer currently committed on the row (never modified by this plan). */
  currentPath: string | null;
  action: BackfillAction;
  blockers: string[];
};

/** A row as projected for the planner (legacy bodies + committed pointers). */
export type PostBodyRow = {
  id: number;
  body_en: string | null;
  body_it: string | null;
  body_en_path: string | null;
  body_it_path: string | null;
};

export type BackfillPlanSummary = {
  entries: number;
  byAction: Record<BackfillAction, number>;
  /** Objects an authorized apply would create. */
  plannedObjects: number;
  /** Bytes an authorized apply would upload. */
  plannedUploadBytes: number;
  /** Bytes of every non-empty legacy body in the plan (all locales). */
  totalSourceBytes: number;
  blockers: number;
  byEntity: Record<
    BodyContentKind,
    { rows: number; entries: number; plannedObjects: number; plannedUploadBytes: number }
  >;
};

export type BackfillPlanReport = {
  command: typeof BACKFILL_PLAN_COMMAND;
  appEnv: string;
  schema: string;
  projectRef: string;
  bucket: string;
  ok: boolean;
  summary: BackfillPlanSummary;
  manifest: BackfillPlanEntry[];
};

/** Environment the planner requires; every field is validated before any read. */
export type BackfillPlanEnv = {
  appEnv: string;
  schema: string;
  supabaseUrl: string;
  hasServerSecret: boolean;
};

/** `https://<ref>.supabase.co` -> `<ref>`; null when the URL is not usable. */
export function projectRefFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const match = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(url.hostname);
  return match ? match[1] : null;
}

/**
 * Fail-closed environment gate: this planner is dev-only and project-bound.
 *
 * It runs before the first database read, refuses production and any schema
 * other than `dev_staging`, requires a parseable project URL whose reference
 * matches `EXPECTED_DEV_PROJECT_REF`, and requires the exact destination bucket
 * plus a server-side secret. There is no fallback to `public` and no override.
 */
export function assertBackfillPlanAllowed(env: BackfillPlanEnv): void {
  if (env.appEnv === 'production') {
    throw new Error(
      `[backfill-plan] refusing to run in production (APP_ENV=${env.appEnv}): this planner is dev-only`
    );
  }
  if (env.schema !== BACKFILL_PLAN_SCHEMA) {
    throw new Error(
      `[backfill-plan] refusing to run: NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be '${BACKFILL_PLAN_SCHEMA}', got '${env.schema}'`
    );
  }
  if (!env.supabaseUrl) {
    throw new Error('[backfill-plan] missing NEXT_PUBLIC_SUPABASE_URL');
  }
  const ref = projectRefFromUrl(env.supabaseUrl);
  if (!ref) {
    throw new Error(
      `[backfill-plan] NEXT_PUBLIC_SUPABASE_URL '${env.supabaseUrl}' is not a usable https://<ref>.supabase.co URL`
    );
  }
  if (ref !== EXPECTED_DEV_PROJECT_REF) {
    throw new Error(
      `[backfill-plan] project mismatch: configured URL targets '${ref}' but this planner only operates on '${EXPECTED_DEV_PROJECT_REF}'`
    );
  }
  if (BACKFILL_PLAN_BUCKET !== CONTENT_BUCKET_DEV) {
    throw new Error(
      `[backfill-plan] refusing to run: destination bucket must be exactly '${CONTENT_BUCKET_DEV}'`
    );
  }
  if (!env.hasServerSecret) {
    throw new Error('[backfill-plan] missing SUPABASE_SECRET_KEY (server-side credentials required)');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SHA-256 embedded in an existing pointer, or null when the pointer is not
 * the canonical key for this exact entity/id/locale.
 *
 * Ownership is proven by round-tripping the extracted hash back through
 * `prepareBodyContent`'s canonical key builder: a pointer that names another
 * post, another locale or a non-canonical file name fails here instead of
 * silently taking over another post's content.
 */
export function pointerHashFor(
  kind: BodyContentKind,
  postId: number,
  locale: BodyContentLocale,
  path: string
): string | null {
  const prefix = `${kind}/${postId}/${locale}/`;
  if (!path.startsWith(prefix)) return null;
  const file = path.slice(prefix.length);
  if (!/^[0-9a-f]{64}\.md$/.test(file)) return null;
  const hash = file.slice(0, -'.md'.length);
  try {
    // Ownership is proven by rebuilding the canonical key for the extracted
    // hash and requiring exact equality, so a pointer that names another post,
    // another locale or a non-canonical file name can never be adopted.
    return bodyContentPath(kind, postId, locale, hash) === path ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Plans one locale of one post. Pure: it reads no clock, no environment and no
 * storage, and it never mutates its inputs.
 *
 * - empty/NULL legacy body      -> SKIP_EMPTY (no object is invented)
 * - empty body + pointer set    -> BLOCKED (a pointer to content that is gone)
 * - no pointer                  -> UPLOAD_AND_POINT
 * - pointer == body hash        -> ALREADY_CURRENT
 * - pointer owned by this entity but another hash -> BLOCKED (body changed
 *   since the pointer was written; never silently overwritten)
 * - pointer owned by another entity/locale/not canonical -> BLOCKED
 * - body over the 1 MiB limit   -> BLOCKED (limit comes from `bodyContent`)
 */
export function planEntry(
  kind: BodyContentKind,
  postId: number,
  locale: BodyContentLocale,
  legacyBody: string | null,
  currentPath: string | null
): BackfillPlanEntry {
  const base = { kind, postId, locale, currentPath: currentPath ?? null };
  if (!Number.isInteger(postId) || postId <= 0) {
    return {
      ...base,
      sourceSha256: null,
      sizeBytes: 0,
      expectedPath: null,
      action: 'BLOCKED',
      blockers: [`invalid post id '${String(postId)}' (expected a positive integer)`],
    };
  }

  const body = legacyBody ?? null;
  if (body === null || body === '') {
    if (currentPath) {
      return {
        ...base,
        sourceSha256: null,
        sizeBytes: 0,
        expectedPath: null,
        action: 'BLOCKED',
        blockers: ['legacy body is empty but a pointer is set — refusing to guess'],
      };
    }
    return {
      ...base,
      sourceSha256: null,
      sizeBytes: 0,
      expectedPath: null,
      action: 'SKIP_EMPTY',
      blockers: [],
    };
  }

  let prepared: ReturnType<typeof prepareBodyContent>;
  try {
    prepared = prepareBodyContent(kind, postId, locale, body);
  } catch (error) {
    return {
      ...base,
      sourceSha256: null,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
      expectedPath: null,
      action: 'BLOCKED',
      blockers: [messageOf(error)],
    };
  }

  const head = {
    sourceSha256: prepared.hash,
    sizeBytes: prepared.size,
    expectedPath: prepared.path,
  };

  if (!currentPath) {
    return { ...base, ...head, action: 'UPLOAD_AND_POINT', blockers: [] };
  }

  const pointerHash = pointerHashFor(kind, postId, locale, currentPath);
  if (pointerHash === null) {
    return {
      ...base,
      ...head,
      action: 'BLOCKED',
      blockers: [
        `pointer '${currentPath}' is not a canonical ${kind}/${postId}/${locale}/<sha256>.md key`,
      ],
    };
  }
  if (pointerHash !== prepared.hash) {
    return {
      ...base,
      ...head,
      action: 'BLOCKED',
      blockers: [
        `pointer/body disagreement: pointer hash ${pointerHash} does not match the legacy body hash ${prepared.hash}`,
      ],
    };
  }
  return { ...base, ...head, action: 'ALREADY_CURRENT', blockers: [] };
}

/** Deterministic manifest key for duplicate detection. */
function entryKey(entry: Pick<BackfillPlanEntry, 'kind' | 'postId' | 'locale'>): string {
  return `${entry.kind}:${entry.postId}:${entry.locale}`;
}

/** Flags every entry of a duplicated (kind, postId, locale) key as BLOCKED. */
function markDuplicates(entries: BackfillPlanEntry[]): BackfillPlanEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.map((entry) => {
    const key = entryKey(entry);
    if ((counts.get(key) ?? 0) < 2) return entry;
    const blocker = `duplicate record for ${key}: refusing to plan an ambiguous migration`;
    return {
      ...entry,
      action: 'BLOCKED',
      blockers: entry.blockers.includes(blocker)
        ? entry.blockers
        : [...entry.blockers, blocker],
    };
  });
}

/**
 * Builds the full manifest in a stable order: kind (blog, portfolio), then
 * numeric post id ascending, then locale (EN, IT). Duplicate or unexpected rows
 * are surfaced as blockers rather than silently collapsed.
 */
export function buildBackfillPlan(rows: {
  blog?: PostBodyRow[];
  portfolio?: PostBodyRow[];
}): BackfillPlanEntry[] {
  const entries: BackfillPlanEntry[] = [];
  for (const kind of BACKFILL_PLAN_KINDS) {
    const list = [...(rows[kind] ?? [])].sort(
      (a, b) => Number(a.id) - Number(b.id)
    );
    for (const row of list) {
      for (const locale of BACKFILL_PLAN_LOCALES) {
        const body = locale === 'en' ? row.body_en : row.body_it;
        const path = locale === 'en' ? row.body_en_path : row.body_it_path;
        entries.push(
          planEntry(kind, Number(row.id), locale, body ?? null, path ?? null)
        );
      }
    }
  }
  return markDuplicates(entries);
}

/** Compact, machine-readable roll-up of a manifest. */
export function summarizePlan(entries: BackfillPlanEntry[]): BackfillPlanSummary {
  const byAction: Record<BackfillAction, number> = {
    UPLOAD_AND_POINT: 0,
    ALREADY_CURRENT: 0,
    SKIP_EMPTY: 0,
    BLOCKED: 0,
  };
  const byEntity: BackfillPlanSummary['byEntity'] = {
    blog: { rows: 0, entries: 0, plannedObjects: 0, plannedUploadBytes: 0 },
    portfolio: { rows: 0, entries: 0, plannedObjects: 0, plannedUploadBytes: 0 },
  };
  const rowIds: Record<BodyContentKind, Set<number>> = {
    blog: new Set(),
    portfolio: new Set(),
  };

  let plannedObjects = 0;
  let plannedUploadBytes = 0;
  let totalSourceBytes = 0;
  let blockers = 0;

  for (const entry of entries) {
    byAction[entry.action] += 1;
    byEntity[entry.kind].entries += 1;
    rowIds[entry.kind].add(entry.postId);
    blockers += entry.blockers.length;
    if (entry.action !== 'SKIP_EMPTY') totalSourceBytes += entry.sizeBytes;
    if (entry.action === 'UPLOAD_AND_POINT') {
      plannedObjects += 1;
      plannedUploadBytes += entry.sizeBytes;
      byEntity[entry.kind].plannedObjects += 1;
      byEntity[entry.kind].plannedUploadBytes += entry.sizeBytes;
    }
  }

  for (const kind of BACKFILL_PLAN_KINDS) {
    byEntity[kind].rows = rowIds[kind].size;
  }

  return {
    entries: entries.length,
    byAction,
    plannedObjects,
    plannedUploadBytes,
    totalSourceBytes,
    blockers,
    byEntity,
  };
}

/** Assembles the report the CLI prints. Deterministic: no clock, no ordering drift. */
export function buildBackfillPlanReport(
  entries: BackfillPlanEntry[],
  meta: { appEnv: string; schema: string; projectRef: string; bucket: string }
): BackfillPlanReport {
  const summary = summarizePlan(entries);
  return {
    command: BACKFILL_PLAN_COMMAND,
    appEnv: meta.appEnv,
    schema: meta.schema,
    projectRef: meta.projectRef,
    bucket: meta.bucket,
    ok: summary.blockers === 0,
    summary,
    manifest: entries,
  };
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

export type BackfillArgParse =
  | { ok: true }
  | { ok: false; error: string; args: string[] };

/**
 * The planner takes no arguments. Anything on the command line — including the
 * not-yet-existing `--apply`, `--rollback` and `--cleanup` — is rejected rather
 * than ignored, so a mutation flag can never be silently accepted as a dry run.
 */
export function parseBackfillPlanArgs(argv: string[]): BackfillArgParse {
  if (argv.length === 0) return { ok: true };
  return {
    ok: false,
    error: `unexpected argument(s): ${argv.join(' ')}`,
    args: [...argv],
  };
}

/* -------------------------------------------------------------------------- */
/* Read-only data access                                                       */
/* -------------------------------------------------------------------------- */

export type PostBodySelectResult = {
  data: unknown[] | null;
  error: { message: string } | null;
};

/**
 * The ONLY database surface the planner accepts: a select with an order clause.
 * There is no insert/update/delete/upsert/remove/upload in this type, so a
 * mutating call cannot be expressed through it. `SupabaseClient` satisfies it
 * structurally (its builders are thenable).
 */
export type ReadOnlyPostBodyClient = {
  from(table: string): {
    select(columns: string): {
      order(
        column: string,
        options?: { ascending?: boolean }
      ): PromiseLike<PostBodySelectResult>;
    };
  };
};

export type PostBodyReader = {
  listPostBodies(kind: BodyContentKind): Promise<PostBodyRow[]>;
};

function toNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`[backfill-plan] unexpected ${field} type in projection`);
  }
  return value;
}

/** Runtime shape check: a malformed row must fail loudly, never plan blindly. */
function toPostBodyRow(row: unknown): PostBodyRow {
  if (typeof row !== 'object' || row === null) {
    throw new Error('[backfill-plan] unexpected projection row shape');
  }
  const record = row as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[backfill-plan] unexpected id '${String(record.id)}' (expected a positive integer)`
    );
  }
  return {
    id,
    body_en: toNullableString(record.body_en, 'body_en'),
    body_it: toNullableString(record.body_it, 'body_it'),
    body_en_path: toNullableString(record.body_en_path, 'body_en_path'),
    body_it_path: toNullableString(record.body_it_path, 'body_it_path'),
  };
}

/**
 * Wraps a read-only client into the planner's reader. Every call is a plain
 * `select(...).order('id')` on an explicit projection; a Postgrest error is
 * rethrown with its message.
 */
export function createPostBodyReader(client: ReadOnlyPostBodyClient): PostBodyReader {
  return {
    async listPostBodies(kind) {
      const table = POST_BODY_TABLES[kind];
      if (!table) {
        throw new Error(`[backfill-plan] unknown entity '${String(kind)}'`);
      }
      const result = await client
        .from(table)
        .select(BACKFILL_PLAN_COLUMNS)
        .order('id', { ascending: true });
      if (result.error) {
        throw new Error(
          `[backfill-plan] reading ${BACKFILL_PLAN_SCHEMA}.${table} failed: ${result.error.message}`
        );
      }
      return (result.data ?? []).map(toPostBodyRow);
    },
  };
}

export type BackfillPlanRun = {
  report: BackfillPlanReport;
  /** 0 = no blockers, 1 = blockers present. */
  exitCode: number;
};

/**
 * The whole dry run: gate -> read -> plan -> summarize. It receives an existing
 * reader (never a client it could write with) and performs no mutation of any
 * kind, on any path.
 */
export async function runBackfillPlan(deps: {
  env: BackfillPlanEnv;
  reader: PostBodyReader;
}): Promise<BackfillPlanRun> {
  assertBackfillPlanAllowed(deps.env);
  const [blog, portfolio] = await Promise.all([
    deps.reader.listPostBodies('blog'),
    deps.reader.listPostBodies('portfolio'),
  ]);
  const entries = buildBackfillPlan({ blog, portfolio });
  const report = buildBackfillPlanReport(entries, {
    appEnv: deps.env.appEnv,
    schema: deps.env.schema,
    projectRef: projectRefFromUrl(deps.env.supabaseUrl) ?? '',
    bucket: BACKFILL_PLAN_BUCKET,
  });
  return { report, exitCode: report.ok ? 0 : 1 };
}

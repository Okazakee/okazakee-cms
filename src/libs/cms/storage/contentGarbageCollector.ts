/**
 * Production Markdown garbage collector (legacy-retirement §4).
 *
 * `website-content` is content-addressed and immutable: re-saving a post
 * uploads a NEW `<sha256>.md` object and repoints `body_en_path`/`body_it_path`,
 * so the previous version survives as an unreferenced object; deleting a post
 * leaves its objects behind too. Nothing in the CMS removes either, so the
 * bucket accumulates superseded versions and orphans until an operator
 * collects them deliberately. This module is that operator: it enumerates the
 * bucket through the Storage API, enumerates the live references from both
 * production post tables, and reports (or, behind an explicit acknowledgement,
 * deletes) the objects no table references any more.
 *
 * The design is fail-closed at every step:
 *  - dry run by default; a deletion needs BOTH `--apply` and the production
 *    acknowledgement variable (mirroring `prodStorageSetup.ts`, with a
 *    different variable name AND value from every other command);
 *  - the environment gate runs BEFORE the first read: APP_ENV=production,
 *    schema=public, the exact production project ref, server secret present;
 *  - only objects matching the canonical key
 *    `<kind>/<postId>/<locale>/<sha256>.md` can ever be a candidate, and only
 *    while no live pointer names them. Anything else in the bucket (staging
 *    uploads, covers, avatars) is reported and never touched;
 *  - an object younger than the retention period is deferred, so a version that
 *    was just superseded — or a body that was just uploaded and whose pointer
 *    has not committed yet — is never collected;
 *  - references are re-read immediately before every delete call, and a
 *    candidate named by the fresh snapshot is skipped;
 *  - deletion goes through the Storage API only (`from(bucket).remove`), never
 *    through SQL against `storage.objects`.
 *
 * Everything here is pure/injectable: the module reads no environment, builds
 * no client and runs nothing on import, so the whole decision path is
 * unit-testable against a fake Storage API and a fake row reader.
 */

import {
  PROD_BACKFILL_ENVIRONMENT,
  projectRefFromUrl,
} from '@/libs/cms/storage/backfillEnvironment';
import {
  BACKFILL_PLAN_KINDS,
  type PostBodyReader,
  type PostBodyRow,
} from '@/libs/cms/storage/backfillPlan';
import type {
  BodyContentKind,
  BodyContentLocale,
} from '@/libs/cms/storage/bodyContent';

/** CLI name (matches the `package.json` script, which the parent owns). */
export const CONTENT_GC_COMMAND = 'storage:content:prod:gc';

/**
 * The pinned production target. Every value comes from the shared environment
 * descriptor, so the collector cannot drift from the backfill/cutover tooling:
 * a single project hosts both environments, production is `public` +
 * `website-content`, and the URL must name exactly this reference.
 */
export const GC_APP_ENV = PROD_BACKFILL_ENVIRONMENT.appEnv;
export const GC_SCHEMA = PROD_BACKFILL_ENVIRONMENT.schema;
export const GC_PROJECT_REF = PROD_BACKFILL_ENVIRONMENT.projectRef;
/** The only bucket this module may enumerate or delete from. */
export const GC_BUCKET = PROD_BACKFILL_ENVIRONMENT.bucket;

/**
 * Explicit projection, and the reason the collector requires the post-cutover
 * schema: the legacy bodies are irrelevant here, so only the two pointer
 * columns are read (17 rows of Markdown per table would be pure waste).
 */
export const GC_POINTER_COLUMNS = 'id,body_en_path,body_it_path';

/**
 * Production acknowledgement for deletions. Both the variable name and the
 * value differ from the bucket-provisioning and backfill acknowledgements, so
 * no acknowledgement an operator already exports can arm a delete by accident.
 */
export const GC_APPLY_ACK_ENV = 'CMS_PROD_STORAGE_GC_APPLY_ACK';
export const GC_APPLY_ACK_VALUE = 'yes-delete-production-content';

/** Grace period applied when `--retention-days` is not given. */
export const DEFAULT_RETENTION_DAYS = 14;

/**
 * Hard floor for a run that deletes: an apply may never use a shorter grace
 * period than this. A DRY RUN may use 0 — it deletes nothing, and the
 * unbounded window is how an operator inspects the full collectable set (for
 * example to prove the collector finds exactly the two known orphans).
 */
export const MIN_RETENTION_DAYS = 1;

export const MS_PER_DAY = 86_400_000;

/** Storage `list` page size and `remove` batch size. */
export const GC_LIST_PAGE_SIZE = 100;
export const GC_DELETE_BATCH_SIZE = 100;

/**
 * Enumeration guards. A bucket that grew beyond these bounds is not something
 * this command should reason about: it fails loudly instead of deleting from a
 * partial picture.
 */
export const GC_MAX_OBJECTS = 10_000;
export const GC_MAX_DEPTH = 8;

/* -------------------------------------------------------------------------- */
/* Storage and row surfaces                                                    */
/* -------------------------------------------------------------------------- */

export type StorageError = { message: string };

/** A `list()` entry: a file, or a pseudo-entry standing for a folder. */
export type ContentObjectRow = {
  name: string;
  /** null/absent for a folder entry; a real object id otherwise. */
  id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: { size?: number | null } | null;
};

/**
 * The Storage surface this module needs, bucket-scoped and narrowed to one
 * read and one delete. `supabase.storage.from(bucket)` satisfies it
 * structurally. There is no SQL, no `storage.objects` access and no bucket
 * method here: the only mutation this type can express is a Storage `remove`.
 */
export type ContentObjectApi = {
  list(
    path: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ data: ContentObjectRow[] | null; error: StorageError | null }>;
  remove(
    paths: string[]
  ): Promise<{ data: unknown; error: StorageError | null }>;
};

/** What the process actually observed; validated before any read. */
export type ContentGcEnv = {
  appEnv: string;
  schema: string;
  supabaseUrl: string;
  hasServerSecret: boolean;
};

/* -------------------------------------------------------------------------- */
/* Canonical keys                                                              */
/* -------------------------------------------------------------------------- */

export type ParsedContentKey = {
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  hash: string;
};

/** The canonical body key, exactly as `bodyContentPath` builds it. */
const CONTENT_KEY_PATTERN =
  /^(blog|portfolio)\/([1-9]\d*)\/(en|it)\/([0-9a-f]{64})\.md$/;

/** Parses a canonical body key; null for anything this collector does not own. */
export function parseContentObjectKey(path: string): ParsedContentKey | null {
  const match = CONTENT_KEY_PATTERN.exec(path);
  if (!match) return null;
  const postId = Number(match[2]);
  if (!Number.isSafeInteger(postId)) return null;
  return {
    kind: match[1] as BodyContentKind,
    postId,
    locale: match[3] as BodyContentLocale,
    hash: match[4],
  };
}

/**
 * Last line of defence before a `remove` call: only a canonical body key may
 * ever be submitted, so a future refactor that widened the candidate set
 * would throw here instead of deleting something unrelated.
 */
export function assertRemovableContentPath(path: string): void {
  if (!parseContentObjectKey(path)) {
    throw new Error(
      `[content-gc] refusing to delete '${path}': not a canonical <kind>/<postId>/<locale>/<sha256>.md key`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Enumeration (Storage API)                                                   */
/* -------------------------------------------------------------------------- */

export type ContentObjectEntry = {
  path: string;
  /** null when Storage reported no usable size. */
  sizeBytes: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * Age of the most recent known write at enumeration time, in ms; null when
   * Storage reported no parseable timestamp. A future timestamp reads as 0
   * (just written), so clock skew can only ever defer a deletion.
   */
  ageMs: number | null;
};

function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toObjectEntry(
  path: string,
  row: ContentObjectRow,
  now: number
): ContentObjectEntry {
  const created = parseInstant(row.created_at);
  const updated = parseInstant(row.updated_at);
  const latest = Math.max(
    created ?? Number.NEGATIVE_INFINITY,
    updated ?? Number.NEGATIVE_INFINITY
  );
  const size = row.metadata?.size;
  return {
    path,
    sizeBytes: typeof size === 'number' && Number.isFinite(size) ? size : null,
    createdAt: created === null ? null : (row.created_at ?? null),
    updatedAt: updated === null ? null : (row.updated_at ?? null),
    ageMs: Number.isFinite(latest) ? Math.max(0, now - latest) : null,
  };
}

async function listPrefixPage(
  storage: ContentObjectApi,
  prefix: string,
  label: string
): Promise<ContentObjectRow[]> {
  const rows: ContentObjectRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await storage.list(prefix, {
      limit: GC_LIST_PAGE_SIZE,
      offset,
    });
    if (error) {
      throw new Error(
        `[${label}] listing '${prefix === '' ? '/' : prefix}' failed: ${error.message}`
      );
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < GC_LIST_PAGE_SIZE) return rows;
    offset += GC_LIST_PAGE_SIZE;
  }
}

/**
 * Every object in the bucket, depth-first, through the official Storage list
 * API. Folders are the entries Storage reports with a null id — the same shape
 * the CMS upload helpers rely on — and the listing is sorted by path so two
 * runs against the same bucket produce the same report.
 */
export async function listContentObjects(
  storage: ContentObjectApi,
  options: { now: number; label?: string }
): Promise<ContentObjectEntry[]> {
  const label = options.label ?? CONTENT_GC_COMMAND;
  const entries: ContentObjectEntry[] = [];

  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > GC_MAX_DEPTH) {
      throw new Error(
        `[${label}] bucket nesting deeper than ${GC_MAX_DEPTH} levels at '${prefix}': refusing to enumerate`
      );
    }
    for (const row of await listPrefixPage(storage, prefix, label)) {
      const name = row.name;
      if (!name) continue;
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (row.id === null || row.id === undefined) {
        await walk(path, depth + 1);
        continue;
      }
      if (entries.length >= GC_MAX_OBJECTS) {
        throw new Error(
          `[${label}] bucket holds more than ${GC_MAX_OBJECTS} objects: refusing to enumerate`
        );
      }
      entries.push(toObjectEntry(path, row, options.now));
    }
  };

  await walk('', 0);
  return entries.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/* -------------------------------------------------------------------------- */
/* References (post tables)                                                    */
/* -------------------------------------------------------------------------- */

/** The committed pointers of one post row, per locale. */
export type ContentGcRowPointers = { en: string | null; it: string | null };

export type ContentReferenceSnapshot = {
  /** Every non-empty pointer currently committed by a post row. */
  paths: Set<string>;
  /** kind -> postId -> committed pointers, for parent-row and locale lookups. */
  byKind: Map<BodyContentKind, Map<number, ContentGcRowPointers>>;
  rowCounts: Record<BodyContentKind, number>;
  /** Non-empty pointer values seen (one per locale of every populated row). */
  pointerCount: number;
  distinctPointerCount: number;
};

/** Pure: turns the two tables' pointer projections into the reference set. */
export function referencesFromRows(rows: {
  blog: PostBodyRow[];
  portfolio: PostBodyRow[];
}): ContentReferenceSnapshot {
  const paths = new Set<string>();
  const byKind = new Map<BodyContentKind, Map<number, ContentGcRowPointers>>();
  const rowCounts: Record<BodyContentKind, number> = {
    blog: 0,
    portfolio: 0,
  };
  let pointerCount = 0;

  for (const kind of BACKFILL_PLAN_KINDS) {
    const kindRows = rows[kind] ?? [];
    const rowsById = new Map<number, ContentGcRowPointers>();
    for (const row of kindRows) {
      rowsById.set(row.id, {
        en: row.body_en_path,
        it: row.body_it_path,
      });
      for (const pointer of [row.body_en_path, row.body_it_path]) {
        if (!pointer) continue;
        pointerCount += 1;
        paths.add(pointer);
      }
    }
    byKind.set(kind, rowsById);
    rowCounts[kind] = kindRows.length;
  }

  return {
    paths,
    byKind,
    rowCounts,
    pointerCount,
    distinctPointerCount: paths.size,
  };
}

/**
 * Reads the live references from both production post tables. Called once to
 * plan, and again immediately before each delete call.
 */
export async function readContentReferences(
  reader: PostBodyReader
): Promise<ContentReferenceSnapshot> {
  const [blog, portfolio] = await Promise.all([
    reader.listPostBodies('blog'),
    reader.listPostBodies('portfolio'),
  ]);
  return referencesFromRows({ blog, portfolio });
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

export type ContentGcClassification =
  /** A live pointer names this exact object — never touched. */
  | 'referenced'
  /** Canonical key, parent row gone, no pointer names it. */
  | 'orphan'
  /** Canonical key, parent row alive, another version is the current pointer. */
  | 'superseded'
  /** Not a canonical body key: reported, never touched. */
  | 'unmanaged';

export type ContentGcDisposition = 'candidate' | 'deferred' | 'protected';

/** Why an object is not a candidate; null when it is one. */
export type ContentGcHold =
  | 'referenced'
  | 'unmanaged'
  | 'grace-period'
  | 'unknown-age';

export type ContentGcObject = {
  path: string;
  disposition: ContentGcDisposition;
  classification: ContentGcClassification;
  key: ParsedContentKey | null;
  sizeBytes: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  ageMs: number | null;
  hold: ContentGcHold | null;
  /** Time left before the grace period elapses; null otherwise. */
  retentionRemainingMs: number | null;
};

function classifyContentObject(
  entry: ContentObjectEntry,
  references: ContentReferenceSnapshot,
  retentionMs: number
): ContentGcObject {
  const base = {
    path: entry.path,
    sizeBytes: entry.sizeBytes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ageMs: entry.ageMs,
  };
  const key = parseContentObjectKey(entry.path);
  if (!key) {
    return {
      ...base,
      key: null,
      disposition: 'protected',
      classification: 'unmanaged',
      hold: 'unmanaged',
      retentionRemainingMs: null,
    };
  }
  if (references.paths.has(entry.path)) {
    return {
      ...base,
      key,
      disposition: 'protected',
      classification: 'referenced',
      hold: 'referenced',
      retentionRemainingMs: null,
    };
  }
  // The live row (if any) does not name this object — the reference check
  // above already returned. A row that still exists makes it a superseded
  // version, whether its pointer moved to another hash or was cleared to NULL;
  // a vanished row makes it an orphan of a deleted post.
  const classification: ContentGcClassification =
    references.byKind.get(key.kind)?.has(key.postId) === true
      ? 'superseded'
      : 'orphan';
  if (entry.ageMs === null) {
    return {
      ...base,
      key,
      disposition: 'deferred',
      classification,
      hold: 'unknown-age',
      retentionRemainingMs: null,
    };
  }
  if (entry.ageMs < retentionMs) {
    return {
      ...base,
      key,
      disposition: 'deferred',
      classification,
      hold: 'grace-period',
      retentionRemainingMs: retentionMs - entry.ageMs,
    };
  }
  return {
    ...base,
    key,
    disposition: 'candidate',
    classification,
    hold: null,
    retentionRemainingMs: null,
  };
}

export type ContentGcInventory = {
  objects: number;
  bytes: number;
  /** Objects whose size Storage did not report. */
  unsizedObjects: number;
};

export type ContentGcPlan = {
  now: number;
  retentionMs: number;
  inventory: ContentGcInventory;
  references: {
    rows: Record<BodyContentKind, number>;
    pointers: number;
    distinctPointers: number;
    /** Pointers naming an object the bucket does not hold (a data fault). */
    missing: string[];
  };
  objects: ContentGcObject[];
  /** Collectable now, in stable path order. */
  candidates: ContentGcObject[];
  /** Unreferenced canonical objects still inside the grace period. */
  deferred: ContentGcObject[];
  /** Live pointers' objects. */
  protectedPaths: string[];
  unmanaged: string[];
  missingReferences: string[];
};

/** Pure: inventory + references -> candidates, deferred objects and holds. */
export function planContentGc(input: {
  objects: ContentObjectEntry[];
  references: ContentReferenceSnapshot;
  retentionMs: number;
  now: number;
}): ContentGcPlan {
  const objects = input.objects.map((entry) =>
    classifyContentObject(entry, input.references, input.retentionMs)
  );
  const byPath = (left: ContentGcObject, right: ContentGcObject): number =>
    left.path < right.path ? -1 : 1;
  const inventoryPaths = new Set(input.objects.map((entry) => entry.path));
  const missingReferences = [...input.references.paths]
    .filter((path) => !inventoryPaths.has(path))
    .sort();

  let bytes = 0;
  let unsizedObjects = 0;
  for (const entry of input.objects) {
    if (entry.sizeBytes === null) unsizedObjects += 1;
    else bytes += entry.sizeBytes;
  }

  return {
    now: input.now,
    retentionMs: input.retentionMs,
    inventory: {
      objects: input.objects.length,
      bytes,
      unsizedObjects,
    },
    references: {
      rows: {
        blog: input.references.rowCounts.blog,
        portfolio: input.references.rowCounts.portfolio,
      },
      pointers: input.references.pointerCount,
      distinctPointers: input.references.distinctPointerCount,
      missing: missingReferences,
    },
    objects,
    candidates: objects
      .filter((object) => object.disposition === 'candidate')
      .sort(byPath),
    deferred: objects
      .filter((object) => object.disposition === 'deferred')
      .sort(byPath),
    protectedPaths: objects
      .filter((object) => object.classification === 'referenced')
      .map((object) => object.path)
      .sort(),
    unmanaged: objects
      .filter((object) => object.classification === 'unmanaged')
      .map((object) => object.path)
      .sort(),
    missingReferences,
  };
}

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Fail-closed environment gate, in the spirit of `prodStorageSetup.ts` and
 * `backfillEnvironment.ts`: it runs BEFORE the first Storage or database call,
 * and every value must be explicit. Production is required (so DEV, staging
 * and unset are all refused), the schema must be `public`, and the URL must
 * parse as `https://<ref>.supabase.co` naming exactly the pinned production
 * reference — so a dev clone can never be collected from.
 */
export function assertContentGcAllowed(env: ContentGcEnv): void {
  if (env.appEnv !== GC_APP_ENV) {
    throw new Error(
      `[content-gc] refusing to run: APP_ENV must be exactly '${GC_APP_ENV}', got '${env.appEnv}'`
    );
  }
  if (env.schema !== GC_SCHEMA) {
    throw new Error(
      `[content-gc] refusing to run: NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be '${GC_SCHEMA}', got '${env.schema}'`
    );
  }
  if (!env.supabaseUrl) {
    throw new Error('[content-gc] missing NEXT_PUBLIC_SUPABASE_URL');
  }
  const ref = projectRefFromUrl(env.supabaseUrl);
  if (!ref) {
    throw new Error(
      `[content-gc] NEXT_PUBLIC_SUPABASE_URL '${env.supabaseUrl}' is not a usable https://<ref>.supabase.co URL`
    );
  }
  if (ref !== GC_PROJECT_REF) {
    throw new Error(
      `[content-gc] project mismatch: configured URL targets '${ref}' but this command only operates on '${GC_PROJECT_REF}'`
    );
  }
  if (!env.hasServerSecret) {
    throw new Error(
      '[content-gc] missing SUPABASE_SECRET_KEY (server-side credentials required)'
    );
  }
}

/**
 * Apply gate: without the exact production acknowledgement there is no delete
 * path. Called by the CLI (to map the exit code) and again by `runContentGc`,
 * so a direct caller cannot skip it either.
 */
export function assertContentGcApplyAcknowledged(
  ack: string | undefined
): void {
  if (ack !== GC_APPLY_ACK_VALUE) {
    throw new Error(
      `[content-gc] refusing to delete: set ${GC_APPLY_ACK_ENV}=${GC_APPLY_ACK_VALUE} to acknowledge deleting production Storage objects`
    );
  }
}

/**
 * The acknowledgement value the environment carries, if any. Takes a plain
 * string map rather than `process.env` so callers (and tests) inject an exact
 * environment instead of mutating global state.
 */
export function readContentGcApplyAck(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env[GC_APPLY_ACK_ENV];
}

/** The message to report for an invalid grace period, or null when it is fine. */
export function validateGcRetention(
  days: number,
  apply: boolean
): string | null {
  if (!Number.isSafeInteger(days) || days < 0) {
    return `--retention-days must be a non-negative integer, got '${String(days)}'`;
  }
  if (apply && days < MIN_RETENTION_DAYS) {
    return `refusing --apply with --retention-days=${days}: a deletion run keeps at least ${MIN_RETENTION_DAYS} day(s) of grace (a dry run may use 0 to list every collectable object)`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

export const PROD_STORAGE_GC_USAGE = [
  'usage:',
  `  bun run ${CONTENT_GC_COMMAND} [--retention-days=N] [--json]  # read-only report`,
  `  bun run ${CONTENT_GC_COMMAND} --apply [--retention-days=N]    # delete candidates`,
  '',
  `--apply additionally requires ${GC_APPLY_ACK_ENV}=${GC_APPLY_ACK_VALUE},`,
  `APP_ENV=${GC_APP_ENV}, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=${GC_SCHEMA} and`,
  `NEXT_PUBLIC_SUPABASE_URL=https://${GC_PROJECT_REF}.supabase.co.`,
  `--retention-days defaults to ${DEFAULT_RETENTION_DAYS}; an apply refuses fewer than`,
  `${MIN_RETENTION_DAYS} day(s), while a dry run may use 0 to show every collectable`,
  'object. Only canonical <kind>/<postId>/<locale>/<sha256>.md objects that no',
  'post row references are ever collected; everything else is reported, untouched.',
].join('\n');

export type ContentGcArgs =
  | { mode: 'dry-run'; retentionDays: number; json: boolean }
  | { mode: 'apply'; retentionDays: number; json: boolean }
  | { mode: 'help' }
  | { mode: 'invalid'; error: string };

/**
 * Strict flag parsing: silence is read-only, every unknown argument is refused
 * rather than ignored (so a typo can never be mistaken for a deletion request),
 * and the retention floor is validated here as well as in `runContentGc`.
 */
export function parseContentGcArgs(argv: string[]): ContentGcArgs {
  let apply = false;
  let json = false;
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let retentionSeen = false;
  let applySeen = false;
  let jsonSeen = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { mode: 'help' };
    if (arg === '--apply') {
      if (applySeen) return { mode: 'invalid', error: 'duplicate --apply' };
      applySeen = true;
      apply = true;
      continue;
    }
    if (arg === '--json') {
      if (jsonSeen) return { mode: 'invalid', error: 'duplicate --json' };
      jsonSeen = true;
      json = true;
      continue;
    }
    const retention = /^--retention-days=(\d+)$/.exec(arg);
    if (retention) {
      if (retentionSeen) {
        return { mode: 'invalid', error: 'duplicate --retention-days' };
      }
      retentionSeen = true;
      retentionDays = Number(retention[1]);
      continue;
    }
    return { mode: 'invalid', error: `unexpected argument: ${arg}` };
  }

  const invalid = validateGcRetention(retentionDays, apply);
  if (invalid) return { mode: 'invalid', error: invalid };
  return { mode: apply ? 'apply' : 'dry-run', retentionDays, json };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

export type ContentGcOptions = {
  /** Explicit `--apply`; a missing flag is always a read-only dry run. */
  apply: boolean;
  /** Value of `GC_APPLY_ACK_ENV`; ignored unless `apply` is true. */
  ack: string | undefined;
  retentionDays: number;
};

export type ContentGcDeletionOutcome = 'deleted' | 'failed' | 'skipped';

/** One line of the audit trail: what happened to one candidate. */
export type ContentGcDeletion = {
  path: string;
  outcome: ContentGcDeletionOutcome;
  /** `referenced-on-recheck`, or the Storage error message for a failure. */
  reason: string | null;
  at: string;
};

/** A failed `remove` call, with the exact paths it covered. */
export type ContentGcFailure = { paths: string[]; message: string };

export type ContentGcReport = {
  command: typeof CONTENT_GC_COMMAND;
  mode: 'dry-run' | 'apply';
  appEnv: string;
  schema: string;
  projectRef: string;
  bucket: string;
  retentionDays: number;
  /** True when the run settled: a clean dry run, or a complete deletion pass. */
  ok: boolean;
  generatedAt: string;
  inventory: ContentGcInventory;
  references: ContentGcPlan['references'];
  summary: {
    candidates: number;
    deferred: number;
    referenced: number;
    unmanaged: number;
    deleted: number;
    failed: number;
    skipped: number;
    /** `remove` calls issued; always 0 in a dry run. */
    mutations: number;
    /** Reference re-reads performed immediately before the deletion calls. */
    recheckReads: number;
  };
  candidates: ContentGcObject[];
  deferred: ContentGcObject[];
  protectedPaths: string[];
  unmanaged: string[];
  missingReferences: string[];
  deletions: ContentGcDeletion[];
  failures: ContentGcFailure[];
};

export type ContentGcRun = {
  report: ContentGcReport;
  /** 0 = settled, 1 = attention required (candidates awaiting apply, or a failed delete). */
  exitCode: number;
};

function isoOf(now: number): string {
  return new Date(now).toISOString();
}

/** Assembles the report. Deterministic for a fixed clock and input. */
export function buildContentGcReport(input: {
  mode: 'dry-run' | 'apply';
  env: ContentGcEnv;
  plan: ContentGcPlan;
  retentionDays: number;
  now: number;
  deletions: ContentGcDeletion[];
  failures: ContentGcFailure[];
  mutations: number;
  recheckReads: number;
}): ContentGcReport {
  const deleted = input.deletions.filter(
    (deletion) => deletion.outcome === 'deleted'
  ).length;
  const failed = input.deletions.filter(
    (deletion) => deletion.outcome === 'failed'
  ).length;
  const skipped = input.deletions.filter(
    (deletion) => deletion.outcome === 'skipped'
  ).length;
  const settled =
    input.mode === 'dry-run'
      ? input.plan.candidates.length === 0
      : failed === 0 && skipped === 0;

  return {
    command: CONTENT_GC_COMMAND,
    mode: input.mode,
    appEnv: input.env.appEnv,
    schema: input.env.schema,
    projectRef: projectRefFromUrl(input.env.supabaseUrl) ?? '',
    bucket: GC_BUCKET,
    retentionDays: input.retentionDays,
    ok: settled,
    generatedAt: isoOf(input.now),
    inventory: input.plan.inventory,
    references: input.plan.references,
    summary: {
      candidates: input.plan.candidates.length,
      deferred: input.plan.deferred.length,
      referenced: input.plan.protectedPaths.length,
      unmanaged: input.plan.unmanaged.length,
      deleted,
      failed,
      skipped,
      mutations: input.mutations,
      recheckReads: input.recheckReads,
    },
    candidates: input.plan.candidates,
    deferred: input.plan.deferred,
    protectedPaths: input.plan.protectedPaths,
    unmanaged: input.plan.unmanaged,
    missingReferences: input.plan.missingReferences,
    deletions: input.deletions,
    failures: input.failures,
  };
}

/** 0 = settled, 1 = attention required. */
export function contentGcExitCode(report: ContentGcReport): number {
  return report.ok ? 0 : 1;
}

/**
 * The whole run: gate -> enumerate -> read references -> plan -> report and,
 * when armed, delete.
 *
 * A dry run performs exactly the read calls of the plan and then stops: it
 * issues no `remove`, so its mutation count is 0 on every path.
 *
 * A deletion pass processes candidates in stable path order in batches, and
 * re-reads the references immediately before every `remove` call: a candidate
 * the fresh snapshot names is skipped, never deleted. The re-check narrows the
 * race with a concurrent editor to the window between that read and the
 * Storage call — the delete and the launcher's pointer write cannot be made
 * atomic through the Storage API, which is exactly why the grace period and
 * the acknowledgement exist. A `remove` failure is recorded per path and never
 * aborts the remaining batches, so the report always accounts for every
 * candidate.
 */
export async function runContentGc(deps: {
  env: ContentGcEnv;
  storage: ContentObjectApi;
  reader: PostBodyReader;
  options: ContentGcOptions;
  now?: () => number;
}): Promise<ContentGcRun> {
  assertContentGcAllowed(deps.env);
  const invalidRetention = validateGcRetention(
    deps.options.retentionDays,
    deps.options.apply
  );
  if (invalidRetention) {
    throw new Error(`[content-gc] ${invalidRetention}`);
  }
  if (deps.options.apply) {
    assertContentGcApplyAcknowledged(deps.options.ack);
  }

  const now = deps.now ?? (() => Date.now());
  const plannedAt = now();
  const retentionMs = deps.options.retentionDays * MS_PER_DAY;
  const objects = await listContentObjects(deps.storage, {
    now: plannedAt,
  });
  const references = await readContentReferences(deps.reader);
  const plan = planContentGc({
    objects,
    references,
    retentionMs,
    now: plannedAt,
  });

  const deletions: ContentGcDeletion[] = [];
  const failures: ContentGcFailure[] = [];
  let mutations = 0;
  let recheckReads = 0;

  if (deps.options.apply) {
    for (
      let start = 0;
      start < plan.candidates.length;
      start += GC_DELETE_BATCH_SIZE
    ) {
      const chunk = plan.candidates.slice(start, start + GC_DELETE_BATCH_SIZE);
      // The re-check: the last read before the delete, so an object that
      // became referenced while this run was planning is skipped.
      recheckReads += 1;
      const fresh = await readContentReferences(deps.reader);
      const removable: string[] = [];
      for (const candidate of chunk) {
        const at = isoOf(now());
        if (fresh.paths.has(candidate.path)) {
          deletions.push({
            path: candidate.path,
            outcome: 'skipped',
            reason: 'referenced-on-recheck',
            at,
          });
          continue;
        }
        assertRemovableContentPath(candidate.path);
        removable.push(candidate.path);
      }
      if (removable.length === 0) continue;
      const removed = await deps.storage.remove(removable);
      mutations += 1;
      const at = isoOf(now());
      if (removed.error) {
        failures.push({
          paths: [...removable],
          message: removed.error.message,
        });
        for (const path of removable) {
          deletions.push({
            path,
            outcome: 'failed',
            reason: removed.error.message,
            at,
          });
        }
        continue;
      }
      // The Storage API reports one error for the whole call and no per-path
      // channel, so a call that returned no error is recorded as deleting
      // exactly the paths it was given.
      for (const path of removable) {
        deletions.push({ path, outcome: 'deleted', reason: null, at });
      }
    }
  }

  const report = buildContentGcReport({
    mode: deps.options.apply ? 'apply' : 'dry-run',
    env: deps.env,
    plan,
    retentionDays: deps.options.retentionDays,
    now: now(),
    deletions,
    failures,
    mutations,
    recheckReads,
  });
  return { report, exitCode: contentGcExitCode(report) };
}

/* -------------------------------------------------------------------------- */
/* Human-readable audit                                                        */
/* -------------------------------------------------------------------------- */

/** One line per candidate, so the audit names every object it reports. */
export function humanContentGcLines(report: ContentGcReport): string[] {
  const lines: string[] = [
    `command=${report.command} mode=${report.mode} bucket=${report.bucket} project=${report.projectRef} retentionDays=${report.retentionDays}`,
    `inventory: objects=${report.inventory.objects} bytes=${report.inventory.bytes} references: rows=${report.references.rows.blog + report.references.rows.portfolio} pointers=${report.references.pointers} distinct=${report.references.distinctPointers}`,
    `summary: candidates=${report.summary.candidates} deferred=${report.summary.deferred} referenced=${report.summary.referenced} unmanaged=${report.summary.unmanaged} deleted=${report.summary.deleted} failed=${report.summary.failed} skipped=${report.summary.skipped} mutations=${report.summary.mutations}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `candidate ${candidate.classification} ${candidate.path} (${candidate.sizeBytes === null ? 'size unknown' : `${candidate.sizeBytes} bytes`}, age ${candidate.ageMs === null ? 'unknown' : `${Math.floor(candidate.ageMs / MS_PER_DAY)}d`})`
    );
  }
  for (const deferred of report.deferred) {
    const remaining =
      deferred.retentionRemainingMs === null
        ? (deferred.hold ?? 'held')
        : `${Math.ceil(deferred.retentionRemainingMs / MS_PER_DAY)}d of grace left`;
    lines.push(
      `deferred ${deferred.classification} ${deferred.path} (${remaining})`
    );
  }
  for (const path of report.unmanaged) {
    lines.push(`unmanaged (never touched) ${path}`);
  }
  for (const path of report.missingReferences) {
    lines.push(`missing reference (no such object) ${path}`);
  }
  for (const deletion of report.deletions) {
    lines.push(
      `deletion ${deletion.outcome} ${deletion.path}${deletion.reason ? ` (${deletion.reason})` : ''}`
    );
  }
  if (report.mode === 'dry-run') {
    lines.push(
      report.candidates.length === 0
        ? 'dry run: no collectable object; nothing to delete.'
        : `dry run: no mutation was performed; re-run with --apply and ${GC_APPLY_ACK_ENV}=${GC_APPLY_ACK_VALUE} to delete the ${report.candidates.length} candidate object(s).`
    );
  } else if (report.summary.failed > 0 || report.summary.skipped > 0) {
    lines.push(
      `apply incomplete: deleted=${report.summary.deleted} failed=${report.summary.failed} skipped=${report.summary.skipped}; re-run to retry.`
    );
  }
  return lines;
}

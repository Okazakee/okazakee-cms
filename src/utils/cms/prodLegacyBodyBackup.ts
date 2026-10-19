#!/usr/bin/env node
/**
 * Production legacy-body backup & restore command (legacy-retirement §3).
 *
 *   bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir>
 *     # read-only dry run: reads production, writes nothing anywhere
 *   CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
 *     bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply
 *     # write the baseline artifact (rows + Storage bytes + manifest + sums)
 *   bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<dir>
 *     # offline: re-hash every on-disk file against the manifest
 *   CMS_BACKUP_RESTORE_ACK=yes-restore-to-scratch-target \
 *     bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<dir> --apply
 *     # restore the artifact into a SCRATCH target (never a live content table)
 *
 * WHY THIS EXISTS
 *   Before `supabase/review/prod_legacy_body_retirement.sql` drops `body_en`
 *   and `body_it` from `public.blog_posts` / `public.portfolio_posts`, those
 *   column values have exactly ONE copy. A server-side
 *   `copy (…) to '/tmp/prod-bodies-before-contraction.jsonl'` runs inside the
 *   database host: it writes into the project's filesystem, it cannot be
 *   re-hashed by the operator, and it cannot be restored independently. This
 *   command is the operator's baseline instead:
 *
 *   - it reads production exclusively over PostgREST (post rows) and the
 *     Storage API (object bytes). There is no SQL in this module, no `COPY`,
 *     no `storage.objects` access, and nothing is ever written into the
 *     project — not a row, not an object, not a bucket;
 *   - it captures every post's id/kind/visibility, the legacy `body_en` /
 *     `body_it` values, the committed canonical pointers, and the
 *     authoritative Storage bytes for every referenced pointer, each with its
 *     SHA-256 and byte length;
 *   - it writes a fresh, timestamped, append-only run directory (0700) with
 *     0600 files OUTSIDE both repositories, plus `manifest.json` (every
 *     recorded hash) and a `SHA256SUMS` file the operator retains out of band;
 *   - `--verify` re-hashes the on-disk files against the manifest, offline;
 *   - `--restore` replays the artifact into a scratch table or a scratch
 *     project, and refuses any live production content table.
 *
 * TIMING — THE BASELINE MUST PRECEDE THE SHIM DEPLOYMENT
 *   `src/libs/cms/legacyBodyEnShim.ts` keeps `body_en` NOT NULL until the
 *   contraction by writing the placeholder `[content moved to object storage]`
 *   into it on every create/update. A post saved by the shim-enabled CMS has
 *   already LOST its legacy English body, and the loss is not recoverable from
 *   Postgres afterwards. The baseline export must therefore be taken BEFORE
 *   that revision reaches production; a captured body equal to the placeholder
 *   is reported as an error (`legacy-body-placeholder`) and marks the artifact
 *   incomplete, so a too-late run can never be mistaken for a baseline. The
 *   full ordering and the restore procedure live in
 *   `docs/PRODUCTION_BACKUP_RESTORE.md`.
 *
 * Everything below is pure/injectable: the module reads no environment, builds
 * no client and runs nothing on import, so the whole gate → read → capture →
 * write → verify → restore path is unit-testable against fake clients and a
 * fake filesystem. Client and writer factories are called only after their
 * gates, so a refused run builds nothing at all.
 *
 * Exit codes (the convention documented for the other maintenance commands):
 *   0  settled (clean dry run, artifact written complete, artifact intact, or
 *      every restore write applied)
 *   1  attention required (incomplete capture, verification mismatch, findings,
 *      or a failed restore write)
 *   2  invalid usage
 *   3  refused by a fail-closed gate (environment, project, restore target or
 *      artifact completeness)
 *   4  read/execution failure
 *   5  refused by the apply gate (the acknowledgement is missing)
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { supabaseServerSecret, supabaseUrl } from '@/config/shared';
import {
  PROD_BACKFILL_ENVIRONMENT,
  projectRefFromUrl,
} from '@/libs/cms/storage/backfillEnvironment';
import {
  POST_BODY_TABLES,
  pointerHashFor,
} from '@/libs/cms/storage/backfillPlan';
import {
  BODY_CONTENT_TYPE,
  type BodyContentKind,
  type BodyContentLocale,
  type BodyContentStorageApi,
  type PreparedBodyContent,
  readBodyContentBytes,
  sha256Hex,
  uploadBodyContent,
} from '@/libs/cms/storage/bodyContent';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { isDirectInvocation } from '@/utils/cms/prodStorageSetup';

/* -------------------------------------------------------------------------- */
/* Identity and the pinned production target                                   */
/* -------------------------------------------------------------------------- */

/** CLI name (matches the `package.json` script, which the parent owns). */
export const LEGACY_BODY_BACKUP_COMMAND = 'backup:content:prod:legacy-bodies';

/**
 * The pinned production descriptor. Every value comes from the shared
 * environment descriptor, so this command cannot drift from the
 * backfill/cutover/GC tooling: one project hosts both environments, production
 * is `APP_ENV=production` + schema `public`, and the URL must name exactly this
 * reference.
 */
export const BACKUP_APP_ENV = PROD_BACKFILL_ENVIRONMENT.appEnv;
export const BACKUP_SCHEMA = PROD_BACKFILL_ENVIRONMENT.schema;
export const BACKUP_PROJECT_REF = PROD_BACKFILL_ENVIRONMENT.projectRef;

/**
 * The only bucket this command may download from, pinned as a literal and
 * checked against the shared descriptor at run time (`assertLegacyBodyBackupEnvAllowed`)
 * so the facade can never address the dev sibling or an asset bucket.
 */
export const BACKUP_BUCKET = 'website-content';

/** Explicit projection: legacy bodies, visibility and the committed pointers. */
export const BACKUP_ROW_COLUMNS =
  'id,hidden,body_en,body_it,body_en_path,body_it_path';

/** PostgREST page size for the row read. */
export const BACKUP_PAGE_SIZE = 500;

/**
 * Enumeration guard: a project that grew beyond this bound is not something
 * this command should capture blindly. It fails loudly instead of writing a
 * partial artifact in silence.
 */
export const BACKUP_MAX_ROWS = 100_000;

/**
 * Export acknowledgement. Both the variable name and the value differ from
 * every other acknowledgement in this repository (bucket provisioning, dev
 * backfill, production backfill, GC), so no acknowledgement an operator already
 * exports can arm an artifact write by accident.
 */
export const BACKUP_APPLY_ACK_ENV = 'CMS_PROD_BACKUP_APPLY_ACK';
export const BACKUP_APPLY_ACK_VALUE = 'yes-export-production-bodies';

/**
 * Restore acknowledgement. Named for the scratch target and different from the
 * export pair, so the flag that arms a production read can never arm a write.
 */
export const BACKUP_RESTORE_ACK_ENV = 'CMS_BACKUP_RESTORE_ACK';
export const BACKUP_RESTORE_ACK_VALUE = 'yes-restore-to-scratch-target';

/** Restore target credentials (a scratch project, or the project that hosts a scratch table). */
export const RESTORE_URL_ENV = 'CMS_BACKUP_RESTORE_URL';
export const RESTORE_KEY_ENV = 'CMS_BACKUP_RESTORE_KEY';

export const DEFAULT_RESTORE_SCHEMA = 'public';
export const DEFAULT_RESTORE_TABLE = 'legacy_body_backup_restore';

/**
 * Live content tables. A restore may never address one of these on the pinned
 * production project: rewriting them is the destructive operation this backup
 * exists to survive, and it stays a reviewed manual SQL step.
 */
export const LIVE_POST_TABLES: readonly string[] =
  Object.values(POST_BODY_TABLES);

/** Composite key the restore upserts on, so re-running a restore is idempotent. */
export const RESTORE_CONFLICT_TARGET = 'run_id,kind,post_id';

/** Rows per `upsert` call (PostgREST request-size sanity, not a data limit). */
export const RESTORE_BATCH_SIZE = 100;

/** Artifact format identity, recorded in every manifest. */
export const BACKUP_FORMAT = 'okazakee-cms/prod-legacy-body-backup';
export const BACKUP_FORMAT_VERSION = 1;

export const MANIFEST_FILE = 'manifest.json';
export const ROWS_FILE = 'rows.jsonl';
export const SUMS_FILE = 'SHA256SUMS';
export const OBJECTS_DIR = 'objects';

/** Permissions of the run directory and of every file in it. */
export const RUN_DIRECTORY_MODE = 0o700;
export const ARTIFACT_FILE_MODE = 0o600;

/**
 * The value `legacyBodyEnShim.ts` writes into `body_en` while the NOT NULL
 * column still exists. Kept as a literal rather than an import because the shim
 * is deleted with the columns, while this baseline artifact stays readable
 * afterwards; `prodLegacyBodyBackup.test.ts` pins the two to each other.
 */
export const LEGACY_BODY_EN_PLACEHOLDER = '[content moved to object storage]';

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

/** What the process actually observed; validated before the first read. */
export type LegacyBodyBackupEnv = {
  appEnv: string;
  schema: string;
  supabaseUrl: string;
  hasServerSecret: boolean;
};

/**
 * Fail-closed environment gate, in the spirit of
 * `src/libs/cms/storage/prodStorageGc.ts`: it runs BEFORE the first database or
 * Storage call, and every value must be explicit.
 *
 * `APP_ENV` is read verbatim by the CLI (no `NODE_ENV` fallback), so an
 * undeclared environment refuses here rather than resolving by accident; the
 * schema must be `public`; the URL must parse as
 * `https://<ref>.supabase.co` naming exactly `BACKUP_PROJECT_REF`; and a
 * server-side secret must be present.
 */
export function assertLegacyBodyBackupEnvAllowed(
  env: LegacyBodyBackupEnv
): void {
  if (env.appEnv !== BACKUP_APP_ENV) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to run: APP_ENV must be exactly '${BACKUP_APP_ENV}', got '${env.appEnv}'`
    );
  }
  if (env.schema !== BACKUP_SCHEMA) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to run: NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be '${BACKUP_SCHEMA}', got '${env.schema}'`
    );
  }
  if (!env.supabaseUrl) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] missing NEXT_PUBLIC_SUPABASE_URL`
    );
  }
  const ref = projectRefFromUrl(env.supabaseUrl);
  if (!ref) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] NEXT_PUBLIC_SUPABASE_URL '${env.supabaseUrl}' is not a usable https://<ref>.supabase.co URL`
    );
  }
  if (ref !== BACKUP_PROJECT_REF) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] project mismatch: configured URL targets '${ref}' but this command only operates on '${BACKUP_PROJECT_REF}'`
    );
  }
  // The bucket is a compile-time constant distinct from the dev sibling and the
  // asset buckets; a future edit that desynchronised it would otherwise reach a
  // bucket this command does not own.
  if (BACKUP_BUCKET !== PROD_BACKFILL_ENVIRONMENT.bucket) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to run: bucket must be exactly '${PROD_BACKFILL_ENVIRONMENT.bucket}', got '${BACKUP_BUCKET}'`
    );
  }
  if (!env.hasServerSecret) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] missing SUPABASE_SECRET_KEY (server-side credentials required)`
    );
  }
}

/**
 * Apply gate: without the exact production acknowledgement there is no artifact
 * write. Called by the CLI (to map the exit code) and again by the export core,
 * so a direct caller cannot skip it either.
 */
export function assertBackupApplyAcknowledged(ack: string | undefined): void {
  if (ack !== BACKUP_APPLY_ACK_VALUE) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to write the artifact: set ${BACKUP_APPLY_ACK_ENV}=${BACKUP_APPLY_ACK_VALUE} to acknowledge exporting production content`
    );
  }
}

/** Apply gate for `--restore`: a scratch write still needs an explicit ack. */
export function assertBackupRestoreAcknowledged(ack: string | undefined): void {
  if (ack !== BACKUP_RESTORE_ACK_VALUE) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to restore: set ${BACKUP_RESTORE_ACK_ENV}=${BACKUP_RESTORE_ACK_VALUE} to acknowledge restoring into a scratch target`
    );
  }
}

/** Acknowledgement values the environment carries, if any. */
export function readBackupApplyAck(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env[BACKUP_APPLY_ACK_ENV];
}

export function readBackupRestoreAck(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return env[BACKUP_RESTORE_ACK_ENV];
}

/**
 * The nearest directory at or above `start` that holds a `.git` entry, or null.
 * Used only to locate this module's own checkout, so no path is hard-coded.
 */
function nearestRepositoryRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The two checkouts a recovery artifact must never live inside: the CMS
 * repository this module ships in (found by walking up to the nearest `.git`)
 * and the WS sibling of the same workspace. A work tree that merely *contains*
 * the workspace — a dotfiles checkout spanning `$HOME`, for example — is
 * deliberately NOT forbidden: the rule is the two repositories, not every git
 * checkout on the machine.
 */
export function backupRepositoriesForModule(moduleUrl: string): string[] {
  const root = nearestRepositoryRoot(dirname(fileURLToPath(moduleUrl)));
  if (root === null) return [];
  return [root, join(dirname(root), 'okazakee-ws')];
}

/**
 * The artifact must live outside both repositories, so any `--out-dir` at or
 * under either repository root is refused, as is the filesystem root itself
 * (where a run directory would be a surprise for everyone).
 */
export function assertBackupOutDirAllowed(
  outDir: string,
  repositories: readonly string[]
): void {
  const resolved = resolve(outDir);
  if (resolved === dirname(resolved)) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing --out-dir '${resolved}': the recovery artifact must live outside both repositories, not at the filesystem root`
    );
  }
  for (const repository of repositories) {
    const root = resolve(repository);
    if (resolved === root || resolved.startsWith(`${root}${sep}`)) {
      throw new Error(
        `[${LEGACY_BODY_BACKUP_COMMAND}] refusing --out-dir '${resolved}': it is inside the '${root}' repository, and the recovery artifact must live outside both repositories`
      );
    }
  }
}

/** The restore target, resolved from the flags and the environment. */
export type RestoreTarget = {
  url: string;
  /** Project reference parsed from `url`; '' when it is not parseable. */
  ref: string;
  schema: string;
  table: string;
  /** Bucket for object restoration; null restores rows only. */
  bucket: string | null;
};

/** Restore credentials as declared by the environment. */
export function readRestoreCredentials(
  env: Readonly<Record<string, string | undefined>>
): { url: string; key: string } {
  return {
    url: env[RESTORE_URL_ENV] ?? '',
    key: env[RESTORE_KEY_ENV] ?? '',
  };
}

/**
 * Fail-closed restore gate. The restore runs against a SCRATCH target, so this
 * is deliberately the opposite of the export gate: it refuses a live production
 * content table (that is the destructive edit this artifact exists to survive)
 * and it refuses an unusable URL or a missing credential. Nothing derived from
 * the credential is ever reported.
 */
export function assertRestoreTargetAllowed(target: RestoreTarget): void {
  if (!target.url) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to restore: ${RESTORE_URL_ENV} is not configured (point it at the scratch project, or at the project hosting the scratch table)`
    );
  }
  if (!target.ref) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to restore: ${RESTORE_URL_ENV} is not a usable https://<ref>.supabase.co URL`
    );
  }
  if (
    target.ref === BACKUP_PROJECT_REF &&
    target.schema === BACKUP_SCHEMA &&
    LIVE_POST_TABLES.includes(target.table)
  ) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to restore into ${target.schema}.${target.table} of the production project '${target.ref}': that is a live content table — restore into a scratch table or a scratch project instead`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Row access (PostgREST, read-only)                                           */
/* -------------------------------------------------------------------------- */

/** One post row exactly as projected from a post table. */
export type LegacyBodyRow = {
  id: number;
  /** `hidden` is the visibility column of both post tables (true = draft). */
  hidden: boolean | null;
  body_en: string | null;
  body_it: string | null;
  body_en_path: string | null;
  body_it_path: string | null;
};

export type LegacyBodyReader = {
  listLegacyBodies(kind: BodyContentKind): Promise<LegacyBodyRow[]>;
};

/**
 * The ONLY database surface the export accepts: a projected `select` with an
 * `order` and a `range`. There is no insert/update/delete/upsert in this type,
 * so a mutating call is not expressible through it and "the export wrote
 * nothing" is a property of the type, not of a code review. `SupabaseClient`
 * satisfies it structurally (its builders are thenable).
 */
export type ReadOnlyLegacyBodyClient = {
  from(table: string): {
    select(columns: string): {
      order(
        column: string,
        options?: { ascending?: boolean }
      ): {
        range(
          from: number,
          to: number
        ): PromiseLike<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

function nullableString(
  value: unknown,
  field: string,
  label: string
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`[${label}] unexpected ${field} type in projection`);
  }
  return value;
}

/** Runtime shape check: a malformed row must fail loudly, never capture blindly. */
function toLegacyBodyRow(row: unknown, label: string): LegacyBodyRow {
  if (typeof row !== 'object' || row === null) {
    throw new Error(`[${label}] unexpected projection row shape`);
  }
  const record = row as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[${label}] unexpected id '${String(record.id)}' (expected a positive integer)`
    );
  }
  const hidden = record.hidden ?? null;
  if (hidden !== null && typeof hidden !== 'boolean') {
    throw new Error(`[${label}] unexpected hidden value '${String(hidden)}'`);
  }
  return {
    id,
    hidden,
    body_en: nullableString(record.body_en, 'body_en', label),
    body_it: nullableString(record.body_it, 'body_it', label),
    body_en_path: nullableString(record.body_en_path, 'body_en_path', label),
    body_it_path: nullableString(record.body_it_path, 'body_it_path', label),
  };
}

/**
 * Wraps a read-only client into the export's reader: one projected
 * `select(...).order('id').range(...)` per page, so a projection longer than
 * the PostgREST page limit is still captured completely.
 */
export function createLegacyBodyReader(
  client: ReadOnlyLegacyBodyClient,
  options: {
    columns?: string;
    schema?: string;
    label?: string;
    pageSize?: number;
  } = {}
): LegacyBodyReader {
  const columns = options.columns ?? BACKUP_ROW_COLUMNS;
  const schema = options.schema ?? BACKUP_SCHEMA;
  const label = options.label ?? LEGACY_BODY_BACKUP_COMMAND;
  const pageSize = options.pageSize ?? BACKUP_PAGE_SIZE;
  return {
    async listLegacyBodies(kind) {
      const table = POST_BODY_TABLES[kind];
      if (!table) {
        throw new Error(`[${label}] unknown entity '${String(kind)}'`);
      }
      const rows: LegacyBodyRow[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const result = await client
          .from(table)
          .select(columns)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (result.error) {
          throw new Error(
            `[${label}] reading ${schema}.${table} failed: ${result.error.message}`
          );
        }
        const page = result.data ?? [];
        for (const row of page) rows.push(toLegacyBodyRow(row, label));
        if (rows.length > BACKUP_MAX_ROWS) {
          throw new Error(
            `[${label}] ${schema}.${table} returns more than ${BACKUP_MAX_ROWS} rows: refusing to capture a partial picture`
          );
        }
        if (page.length < pageSize) return rows;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export type BackupFindingCode =
  /** The pointer names an object Storage does not have. */
  | 'object-missing'
  /** The object exists but could not be read. */
  | 'object-unreadable'
  /** The stored bytes do not hash to the hash embedded in their own key. */
  | 'object-hash-mismatch'
  /** A non-empty legacy body whose pointer was never committed. */
  | 'body-without-pointer'
  /** A pointer whose legacy body is NULL/empty — the pre-contraction anomaly. */
  | 'body-missing-with-pointer'
  /** A pointer that is not the canonical key for its own kind/id/locale. */
  | 'unaddressable-pointer'
  /** The captured `body_en` is the shim placeholder — the run is too late. */
  | 'legacy-body-placeholder'
  /** The legacy column and the canonical object disagree (shim, or an edit). */
  | 'body-object-mismatch'
  /** `hidden` is NULL, so visibility had to be recorded as unknown. */
  | 'visibility-unknown'
  /** Two owners reference the same object key (impossible for canonical keys). */
  | 'duplicate-pointer';

export type BackupFinding = {
  code: BackupFindingCode;
  /** `error` marks the artifact incomplete; `warning` is recorded only. */
  severity: 'error' | 'warning';
  kind: BodyContentKind | null;
  id: number | null;
  locale: BodyContentLocale | null;
  pointer: string | null;
  message: string;
};

/** One locale of one post, as captured. */
export type CapturedBody = {
  locale: BodyContentLocale;
  /** Exact legacy column value; null when the column is NULL. */
  body: string | null;
  bodySha256: string | null;
  bodyBytes: number;
  pointer: string | null;
  /** Hash parsed out of `pointer`, or null when it is not canonical. */
  pointerHash: string | null;
};

export type CapturedRow = {
  kind: BodyContentKind;
  id: number;
  hidden: boolean | null;
  en: CapturedBody;
  it: CapturedBody;
};

/**
 * One referenced object. `data` is the exact Storage payload and is never
 * serialized: it exists only to be written to disk (and to be hashed).
 */
export type CapturedObject = {
  path: string;
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  captured: boolean;
  sha256: string | null;
  bytes: number | null;
  error: string | null;
  data: Buffer | null;
};

export type BackupCapture = {
  rows: CapturedRow[];
  objects: CapturedObject[];
  findings: BackupFinding[];
  counts: BackupCounts;
};

export type BackupCounts = {
  rows: number;
  blog: number;
  portfolio: number;
  hidden: number;
  visible: number;
  /** Non-empty legacy body values captured (both locales). */
  bodies: number;
  bodyBytes: number;
  /** Distinct referenced pointers. */
  pointers: number;
  /** Objects captured byte-for-byte. */
  objects: number;
  objectsMissing: number;
  objectBytes: number;
  errors: number;
  warnings: number;
};

const BODY_LOCALES: readonly BodyContentLocale[] = ['en', 'it'];

/** The legacy columns of each locale: the body, and its committed pointer. */
const BODY_COLUMNS: Record<
  BodyContentLocale,
  { body: 'body_en' | 'body_it'; pointer: 'body_en_path' | 'body_it_path' }
> = {
  en: { body: 'body_en', pointer: 'body_en_path' },
  it: { body: 'body_it', pointer: 'body_it_path' },
};

/**
 * Captures one locale of one row: the legacy value, its hash/length, the
 * committed pointer and (via `pointerHashFor`) proof that the pointer names
 * this exact kind/id/locale. Pure; it reads no clock and no storage.
 */
function captureBody(
  kind: BodyContentKind,
  id: number,
  locale: BodyContentLocale,
  row: LegacyBodyRow,
  findings: BackupFinding[]
): CapturedBody {
  const columns = BODY_COLUMNS[locale];
  const body = row[columns.body] ?? null;
  const pointer = row[columns.pointer] ?? null;
  const bodyBytes = body === null ? 0 : Buffer.byteLength(body, 'utf8');
  const bodySha256 =
    body === null ? null : sha256Hex(Buffer.from(body, 'utf8'));
  const pointerHash =
    pointer === null ? null : pointerHashFor(kind, id, locale, pointer);

  const where = `${kind}/${id}/${locale}`;
  if (pointer !== null && pointerHash === null) {
    findings.push({
      code: 'unaddressable-pointer',
      severity: 'error',
      kind,
      id,
      locale,
      pointer,
      message: `${where}: pointer '${pointer}' is not the canonical ${kind}/${id}/${locale}/<sha256>.md key`,
    });
  }
  if (body === null || body === '') {
    if (pointer !== null) {
      findings.push({
        code: 'body-missing-with-pointer',
        severity: 'warning',
        kind,
        id,
        locale,
        pointer,
        message: `${where}: legacy ${columns.body} is ${body === null ? 'NULL' : 'empty'} but a pointer is committed; the object bytes are the only copy of this body`,
      });
    }
  } else if (pointer === null) {
    findings.push({
      code: 'body-without-pointer',
      severity: 'error',
      kind,
      id,
      locale,
      pointer: null,
      message: `${where}: legacy ${columns.body} holds ${bodyBytes} bytes with no committed pointer; no canonical object exists for them`,
    });
  }
  if (body === LEGACY_BODY_EN_PLACEHOLDER) {
    findings.push({
      code: 'legacy-body-placeholder',
      severity: 'error',
      kind,
      id,
      locale,
      pointer,
      message: `${where}: legacy ${columns.body} holds the post-migration placeholder — this artifact is NOT a baseline (the shim-enabled CMS already deployed)`,
    });
  }

  return { locale, body, bodySha256, bodyBytes, pointer, pointerHash };
}

/**
 * Reads every post of both kinds and every referenced object, and records every
 * anomaly as a finding instead of skipping it. Read-only on both surfaces: the
 * row client cannot express a mutation, and the object surface is only ever
 * `download`ed.
 */
export async function captureLegacyBodies(deps: {
  reader: LegacyBodyReader;
  objects: BodyContentStorageApi;
}): Promise<BackupCapture> {
  const findings: BackupFinding[] = [];
  const rows: CapturedRow[] = [];

  for (const kind of ['blog', 'portfolio'] as const) {
    const list = await deps.reader.listLegacyBodies(kind);
    const sorted = [...list].sort((left, right) => left.id - right.id);
    const seen = new Set<number>();
    for (const row of sorted) {
      if (seen.has(row.id)) {
        throw new Error(
          `[${LEGACY_BODY_BACKUP_COMMAND}] ${kind} row ${row.id} was returned twice: refusing to capture an ambiguous picture`
        );
      }
      seen.add(row.id);
      if (row.hidden === null) {
        findings.push({
          code: 'visibility-unknown',
          severity: 'warning',
          kind,
          id: row.id,
          locale: null,
          pointer: null,
          message: `${kind}/${row.id}: hidden is NULL, so visibility is recorded as unknown`,
        });
      }
      rows.push({
        kind,
        id: row.id,
        hidden: row.hidden,
        en: captureBody(kind, row.id, 'en', row, findings),
        it: captureBody(kind, row.id, 'it', row, findings),
      });
    }
  }

  // Distinct referenced pointers, in a stable order. A canonical key already
  // embeds its owner, so a repeated key means two owners claim one object.
  const owners = new Map<
    string,
    { kind: BodyContentKind; id: number; locale: BodyContentLocale }
  >();
  for (const row of rows) {
    for (const locale of BODY_LOCALES) {
      const body = locale === 'en' ? row.en : row.it;
      if (body.pointer === null || body.pointerHash === null) continue;
      const owner = owners.get(body.pointer);
      if (owner) {
        findings.push({
          code: 'duplicate-pointer',
          severity: 'error',
          kind: row.kind,
          id: row.id,
          locale,
          pointer: body.pointer,
          message: `${row.kind}/${row.id}/${locale}: object '${body.pointer}' is also referenced by ${owner.kind}/${owner.id}/${owner.locale}`,
        });
        continue;
      }
      owners.set(body.pointer, { kind: row.kind, id: row.id, locale });
    }
  }

  const objects: CapturedObject[] = [];
  for (const path of [...owners.keys()].sort()) {
    const owner = owners.get(path) as {
      kind: BodyContentKind;
      id: number;
      locale: BodyContentLocale;
    };
    try {
      const bytes = await readBodyContentBytes(deps.objects, path);
      const sha256 = sha256Hex(bytes);
      objects.push({
        path,
        kind: owner.kind,
        postId: owner.id,
        locale: owner.locale,
        captured: true,
        sha256,
        bytes: bytes.length,
        error: null,
        data: bytes,
      });
    } catch (error) {
      objects.push({
        path,
        kind: owner.kind,
        postId: owner.id,
        locale: owner.locale,
        captured: false,
        sha256: null,
        bytes: null,
        error: messageOf(error),
        data: null,
      });
    }
  }

  // Cross-check every pair once the object bytes are known: the capture is only
  // meaningful if the two copies are known to agree or to disagree.
  const objectByPath = new Map(objects.map((object) => [object.path, object]));
  for (const row of rows) {
    for (const locale of BODY_LOCALES) {
      const body = locale === 'en' ? row.en : row.it;
      if (body.pointer === null || body.pointerHash === null) continue;
      const object = objectByPath.get(body.pointer);
      if (!object) continue;
      if (!object.captured) {
        findings.push({
          code: /not found|does not exist|404/i.test(object.error ?? '')
            ? 'object-missing'
            : 'object-unreadable',
          severity: 'error',
          kind: row.kind,
          id: row.id,
          locale,
          pointer: body.pointer,
          message: `${row.kind}/${row.id}/${locale}: referenced object '${body.pointer}' was not captured (${object.error ?? 'unknown error'})`,
        });
        continue;
      }
      if (object.sha256 !== body.pointerHash) {
        findings.push({
          code: 'object-hash-mismatch',
          severity: 'error',
          kind: row.kind,
          id: row.id,
          locale,
          pointer: body.pointer,
          message: `${row.kind}/${row.id}/${locale}: object '${body.pointer}' hashes to ${object.sha256}, not to the hash in its own key`,
        });
      }
      if (body.bodySha256 !== null && body.bodySha256 !== object.sha256) {
        findings.push({
          code: 'body-object-mismatch',
          severity: 'warning',
          kind: row.kind,
          id: row.id,
          locale,
          pointer: body.pointer,
          message: `${row.kind}/${row.id}/${locale}: legacy ${BODY_COLUMNS[locale].body} (${body.bodySha256}) differs from the canonical object (${object.sha256}); take the baseline before the shim-enabled CMS deploys`,
        });
      }
    }
  }

  return {
    rows,
    objects,
    findings,
    counts: countCapture(rows, objects, findings),
  };
}

function countCapture(
  rows: CapturedRow[],
  objects: CapturedObject[],
  findings: BackupFinding[]
): BackupCounts {
  let hidden = 0;
  let bodies = 0;
  let bodyBytes = 0;
  for (const row of rows) {
    if (row.hidden === true) hidden += 1;
    for (const locale of BODY_LOCALES) {
      const body = locale === 'en' ? row.en : row.it;
      if (body.body !== null && body.body !== '') {
        bodies += 1;
        bodyBytes += body.bodyBytes;
      }
    }
  }
  return {
    rows: rows.length,
    blog: rows.filter((row) => row.kind === 'blog').length,
    portfolio: rows.filter((row) => row.kind === 'portfolio').length,
    hidden,
    visible: rows.length - hidden,
    bodies,
    bodyBytes,
    pointers: objects.length,
    objects: objects.filter((object) => object.captured).length,
    objectsMissing: objects.filter((object) => !object.captured).length,
    objectBytes: objects.reduce(
      (total, object) => total + (object.captured ? (object.bytes ?? 0) : 0),
      0
    ),
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning')
      .length,
  };
}

/* -------------------------------------------------------------------------- */
/* Artifact                                                                    */
/* -------------------------------------------------------------------------- */

/** One line of `rows.jsonl`: the values a restore replays, and nothing else. */
export type BackupRowPayload = {
  kind: BodyContentKind;
  id: number;
  hidden: boolean | null;
  body_en: string | null;
  body_it: string | null;
  body_en_path: string | null;
  body_it_path: string | null;
};

export type BackupManifestBody = {
  locale: BodyContentLocale;
  /** True when the column was NULL (as opposed to an empty string). */
  bodyNull: boolean;
  bodySha256: string | null;
  bodyBytes: number;
  pointer: string | null;
  pointerHash: string | null;
  objectPath: string | null;
  objectSha256: string | null;
  objectBytes: number | null;
  objectFile: string | null;
  objectCaptured: boolean;
  /** null when either side is missing. */
  objectMatchesBody: boolean | null;
};

export type BackupManifestRow = {
  kind: BodyContentKind;
  id: number;
  hidden: boolean | null;
  en: BackupManifestBody;
  it: BackupManifestBody;
};

export type BackupManifestObject = {
  path: string;
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  captured: boolean;
  sha256: string | null;
  bytes: number | null;
  file: string | null;
  error: string | null;
};

export type BackupManifestFile = {
  path: string;
  sha256: string;
  bytes: number;
};

/** Exact contents of `manifest.json`: every recorded hash, no payload bytes. */
export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  command: typeof LEGACY_BODY_BACKUP_COMMAND;
  runId: string;
  runDirectory: string;
  generatedAt: string;
  appEnv: string;
  schema: string;
  projectRef: string;
  bucket: string;
  complete: boolean;
  counts: BackupCounts;
  rowsFile: string;
  objectsDir: string;
  rows: BackupManifestRow[];
  objects: BackupManifestObject[];
  files: BackupManifestFile[];
  findings: BackupFinding[];
};

export type BackupArtifact = {
  manifest: BackupManifest;
  manifestBytes: Buffer;
  rowsJsonl: Buffer;
  objectFiles: Array<{ file: string; bytes: Buffer }>;
  sumsBytes: Buffer;
  sumsSha256: string;
  files: BackupManifestFile[];
};

function toRowPayload(row: CapturedRow): BackupRowPayload {
  return {
    kind: row.kind,
    id: row.id,
    hidden: row.hidden,
    body_en: row.en.body,
    body_it: row.it.body,
    body_en_path: row.en.pointer,
    body_it_path: row.it.pointer,
  };
}

function toManifestBody(
  body: CapturedBody,
  object: CapturedObject | undefined
): BackupManifestBody {
  return {
    locale: body.locale,
    bodyNull: body.body === null,
    bodySha256: body.bodySha256,
    bodyBytes: body.bodyBytes,
    pointer: body.pointer,
    pointerHash: body.pointerHash,
    objectPath: object ? object.path : null,
    objectSha256: object ? object.sha256 : null,
    objectBytes: object ? object.bytes : null,
    objectFile: object?.captured ? `${OBJECTS_DIR}/${object.path}` : null,
    objectCaptured: object?.captured ?? false,
    objectMatchesBody:
      object?.captured && body.bodySha256 !== null
        ? object.sha256 === body.bodySha256
        : null,
  };
}

/** `<sha256>  <path>` lines, GNU `sha256sum -c` compatible. */
function buildSums(files: BackupManifestFile[]): string {
  return `${[...files]
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    .map((file) => `${file.sha256}  ${file.path}`)
    .join('\n')}\n`;
}

/**
 * Turns a capture into the exact bytes of the artifact. Pure and deterministic
 * for a fixed clock/run id: the object files, `rows.jsonl`, the manifest and
 * `SHA256SUMS` are all derived here, and the manifest carries the SHA-256 and
 * byte length of every one of them (its own hash is only knowable after it is
 * serialized, so that one lives in `SHA256SUMS`).
 */
export function buildBackupArtifact(
  capture: BackupCapture,
  meta: {
    runId: string;
    runDirectory: string;
    generatedAt: string;
    appEnv: string;
    schema: string;
    projectRef: string;
    bucket: string;
  }
): BackupArtifact {
  const rowsJsonl = Buffer.from(
    capture.rows
      .map((row) => `${JSON.stringify(toRowPayload(row))}\n`)
      .join(''),
    'utf8'
  );
  const files: BackupManifestFile[] = [
    { path: ROWS_FILE, sha256: sha256Hex(rowsJsonl), bytes: rowsJsonl.length },
  ];
  const objectFiles: Array<{ file: string; bytes: Buffer }> = [];
  const objects: BackupManifestObject[] = [];

  for (const object of [...capture.objects].sort((left, right) =>
    left.path < right.path ? -1 : 1
  )) {
    const file =
      object.captured && object.data ? `${OBJECTS_DIR}/${object.path}` : null;
    if (file && object.data && object.sha256 !== null) {
      files.push({
        path: file,
        sha256: object.sha256,
        bytes: object.data.length,
      });
      objectFiles.push({ file, bytes: object.data });
    }
    objects.push({
      path: object.path,
      kind: object.kind,
      postId: object.postId,
      locale: object.locale,
      captured: object.captured,
      sha256: object.sha256,
      bytes: object.bytes,
      file,
      error: object.error,
    });
  }

  const objectByPath = new Map(capture.objects.map((o) => [o.path, o]));
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    command: LEGACY_BODY_BACKUP_COMMAND,
    runId: meta.runId,
    runDirectory: meta.runDirectory,
    generatedAt: meta.generatedAt,
    appEnv: meta.appEnv,
    schema: meta.schema,
    projectRef: meta.projectRef,
    bucket: meta.bucket,
    complete: capture.counts.errors === 0,
    counts: capture.counts,
    rowsFile: ROWS_FILE,
    objectsDir: OBJECTS_DIR,
    rows: capture.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      hidden: row.hidden,
      en: toManifestBody(
        row.en,
        row.en.pointer ? objectByPath.get(row.en.pointer) : undefined
      ),
      it: toManifestBody(
        row.it,
        row.it.pointer ? objectByPath.get(row.it.pointer) : undefined
      ),
    })),
    objects,
    files,
    findings: capture.findings,
  };

  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  const sumsBytes = Buffer.from(
    buildSums([
      {
        path: MANIFEST_FILE,
        sha256: sha256Hex(manifestBytes),
        bytes: manifestBytes.length,
      },
      ...files,
    ]),
    'utf8'
  );

  return {
    manifest,
    manifestBytes,
    rowsJsonl,
    objectFiles,
    sumsBytes,
    sumsSha256: sha256Hex(sumsBytes),
    files,
  };
}

/* -------------------------------------------------------------------------- */
/* Artifact filesystem                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The write surface of one run directory. A fresh run is created with a
 * non-recursive `mkdir` (so an existing directory is an error, never a
 * merge/overwrite) and every file is written `wx` with mode 0600: the naming
 * scheme is timestamped and append-only by construction.
 */
export type BackupWriter = {
  createRun(): Promise<void>;
  writeFile(relativePath: string, bytes: Buffer): Promise<void>;
};

export type BackupReader = {
  readFile(relativePath: string): Promise<Buffer>;
  /** Every file under the run directory, relative, `/`-separated, sorted. */
  listFiles(): Promise<string[]>;
};

function assertSafeRelativePath(relativePath: string): void {
  const segments = relativePath.split('/');
  if (
    relativePath === '' ||
    relativePath.startsWith('/') ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing path '${relativePath}': must be a plain relative path inside the run directory`
    );
  }
}

/** Real filesystem writer: 0700 run directory, 0600 files, never overwriting. */
export function createFsBackupWriter(runDirectory: string): BackupWriter {
  const root = resolve(runDirectory);
  return {
    async createRun(): Promise<void> {
      await mkdir(dirname(root), {
        recursive: true,
        mode: RUN_DIRECTORY_MODE,
      });
      // Non-recursive on purpose: an existing run directory is an operator
      // error (the scheme is append-only), not something to write into.
      await mkdir(root, { mode: RUN_DIRECTORY_MODE });
      await chmod(root, RUN_DIRECTORY_MODE);
    },
    async writeFile(relativePath, bytes): Promise<void> {
      assertSafeRelativePath(relativePath);
      const target = join(root, relativePath);
      await mkdir(dirname(target), {
        recursive: true,
        mode: RUN_DIRECTORY_MODE,
      });
      await writeFile(target, bytes, {
        mode: ARTIFACT_FILE_MODE,
        flag: 'wx',
      });
      await chmod(target, ARTIFACT_FILE_MODE);
    },
  };
}

/** Real filesystem reader for `--verify` and `--restore`. */
export function createFsBackupReader(runDirectory: string): BackupReader {
  const root = resolve(runDirectory);
  const walk = async (prefix: string, entries: string[]): Promise<string[]> => {
    const dirents = await readdir(join(root, prefix), {
      withFileTypes: true,
    });
    for (const dirent of dirents) {
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(relative, entries);
        continue;
      }
      entries.push(relative);
    }
    return entries;
  };
  return {
    async readFile(relativePath): Promise<Buffer> {
      assertSafeRelativePath(relativePath);
      return readFile(join(root, relativePath));
    },
    async listFiles(): Promise<string[]> {
      return (await walk('', [])).sort();
    },
  };
}

/** Writes a whole artifact: objects, rows, manifest, then `SHA256SUMS`. */
export async function writeBackupArtifact(
  writer: BackupWriter,
  artifact: BackupArtifact
): Promise<void> {
  await writer.createRun();
  for (const object of artifact.objectFiles) {
    await writer.writeFile(object.file, object.bytes);
  }
  await writer.writeFile(ROWS_FILE, artifact.rowsJsonl);
  await writer.writeFile(MANIFEST_FILE, artifact.manifestBytes);
  // Last: it pins the manifest's own bytes, which only exist now.
  await writer.writeFile(SUMS_FILE, artifact.sumsBytes);
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

export type VerifyFileStatus = 'ok' | 'mismatch' | 'missing' | 'unexpected';

export type VerifyFile = {
  path: string;
  recordedSha256: string | null;
  actualSha256: string | null;
  recordedBytes: number | null;
  actualBytes: number | null;
  status: VerifyFileStatus;
};

export type VerifyBody = {
  kind: BodyContentKind;
  id: number;
  locale: BodyContentLocale;
  expectedSha256: string | null;
  expectedBytes: number;
  actualSha256: string | null;
  actualBytes: number;
  status: 'ok' | 'mismatch' | 'missing';
};

export type VerifyProblem = {
  code: string;
  path: string | null;
  message: string;
};

export type VerifyReport = {
  command: typeof LEGACY_BODY_BACKUP_COMMAND;
  mode: 'verify';
  backupDir: string;
  runId: string | null;
  generatedAt: string;
  ok: boolean;
  manifestSha256: string | null;
  /** Retain this out of band: it is the root of the artifact's hash chain. */
  sumsSha256: string | null;
  counts: {
    files: number;
    filesOk: number;
    filesMismatched: number;
    filesMissing: number;
    filesUnexpected: number;
    rows: number;
    bodies: number;
    bodiesMismatched: number;
    objects: number;
    objectsMismatched: number;
  };
  files: VerifyFile[];
  bodies: VerifyBody[];
  problems: VerifyProblem[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readIfPresent(
  reader: BackupReader,
  relativePath: string
): Promise<Buffer | null> {
  try {
    return await reader.readFile(relativePath);
  } catch {
    return null;
  }
}

/** Parses a `SHA256SUMS` body into `path -> sha256`. */
export function parseSums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64}) {1,2}(.+)$/.exec(line);
    if (!match) continue;
    entries.set(match[2], match[1]);
  }
  return entries;
}

/** Parses `rows.jsonl`, refusing anything that is not a capture row. */
export function parseRowsJsonl(
  bytes: Buffer,
  label: string
): BackupRowPayload[] {
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    const where = `${label} line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`[${where}] not valid JSON: ${messageOf(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`[${where}] expected a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== 'blog' && kind !== 'portfolio') {
      throw new Error(`[${where}] unexpected kind '${String(kind)}'`);
    }
    const id = Number(record.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`[${where}] unexpected id '${String(record.id)}'`);
    }
    const hidden = record.hidden ?? null;
    if (hidden !== null && typeof hidden !== 'boolean') {
      throw new Error(`[${where}] unexpected hidden '${String(hidden)}'`);
    }
    return {
      kind,
      id,
      hidden,
      body_en: nullableString(record.body_en, 'body_en', where),
      body_it: nullableString(record.body_it, 'body_it', where),
      body_en_path: nullableString(record.body_en_path, 'body_en_path', where),
      body_it_path: nullableString(record.body_it_path, 'body_it_path', where),
    };
  });
}

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.format === BACKUP_FORMAT &&
    record.version === BACKUP_FORMAT_VERSION &&
    typeof record.runId === 'string' &&
    Array.isArray(record.rows) &&
    Array.isArray(record.objects) &&
    Array.isArray(record.files)
  );
}

export type LoadedManifest =
  | { ok: true; manifest: BackupManifest; bytes: Buffer }
  | { ok: false; error: string };

/** Reads and validates `manifest.json`; never throws on a damaged artifact. */
export async function loadBackupManifest(
  reader: BackupReader
): Promise<LoadedManifest> {
  const bytes = await readIfPresent(reader, MANIFEST_FILE);
  if (!bytes) {
    return { ok: false, error: `${MANIFEST_FILE} is missing` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      error: `${MANIFEST_FILE} is not valid JSON: ${messageOf(error)}`,
    };
  }
  if (!isManifest(parsed)) {
    return {
      ok: false,
      error: `${MANIFEST_FILE} is not a ${BACKUP_FORMAT} v${BACKUP_FORMAT_VERSION} manifest`,
    };
  }
  return { ok: true, manifest: parsed, bytes };
}

/**
 * Re-hashes the whole artifact against its manifest, offline.
 *
 * Three independent chains are checked, because an artifact is only as good as
 * the weakest one: the SHA-256 of every file against `SHA256SUMS` (which also
 * pins `manifest.json` itself), the file set against the manifest (a missing
 * file and an extra file are both reported), and the semantic level — every
 * captured body re-hashed from `rows.jsonl`, and every object re-hashed against
 * both the manifest and the hash embedded in its own canonical key.
 */
export async function verifyBackupArtifact(
  reader: BackupReader,
  options: { backupDir: string; now: number }
): Promise<VerifyReport> {
  const problems: VerifyProblem[] = [];
  const files: VerifyFile[] = [];
  const bodies: VerifyBody[] = [];

  const sumsBytes = await readIfPresent(reader, SUMS_FILE);
  const loaded = await loadBackupManifest(reader);
  if (!loaded.ok) {
    problems.push({
      code: 'manifest-unreadable',
      path: MANIFEST_FILE,
      message: loaded.error,
    });
  }
  const manifest = loaded.ok ? loaded.manifest : null;

  // 1. SHA256SUMS -> every file it lists (including the manifest itself).
  const sums = sumsBytes ? parseSums(sumsBytes.toString('utf8')) : null;
  if (!sumsBytes) {
    problems.push({
      code: 'sums-missing',
      path: SUMS_FILE,
      message: `${SUMS_FILE} is missing, so the manifest's own bytes cannot be pinned`,
    });
  }

  const onDisk = await reader.listFiles();
  const onDiskSet = new Set(onDisk);

  const recorded = new Map<string, { sha256: string; bytes: number | null }>();
  if (manifest) {
    for (const file of manifest.files) {
      recorded.set(file.path, { sha256: file.sha256, bytes: file.bytes });
    }
  }

  const checked = new Set<string>();
  const checkFile = async (
    path: string,
    expectedSha256: string | null,
    expectedBytes: number | null
  ): Promise<void> => {
    if (checked.has(path)) return;
    checked.add(path);
    if (!onDiskSet.has(path)) {
      files.push({
        path,
        recordedSha256: expectedSha256,
        actualSha256: null,
        recordedBytes: expectedBytes,
        actualBytes: null,
        status: 'missing',
      });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await reader.readFile(path);
    } catch (error) {
      problems.push({
        code: 'file-unreadable',
        path,
        message: `reading '${path}' failed: ${messageOf(error)}`,
      });
      return;
    }
    const actualSha256 = sha256Hex(bytes);
    files.push({
      path,
      recordedSha256: expectedSha256,
      actualSha256,
      recordedBytes: expectedBytes,
      actualBytes: bytes.length,
      status:
        expectedSha256 === null || expectedSha256 === actualSha256
          ? 'ok'
          : 'mismatch',
    });
  };

  for (const [path, sha256] of sums ?? []) {
    // The manifest cannot record its own hash, so its SHA256SUMS entry has no
    // manifest counterpart to agree with; it is still hashed against the sums.
    if (path !== MANIFEST_FILE) {
      const fromManifest = recorded.get(path);
      if (!fromManifest) {
        problems.push({
          code: 'sums-untracked',
          path,
          message: `${SUMS_FILE} lists '${path}', which the manifest does not`,
        });
      } else if (fromManifest.sha256 !== sha256) {
        problems.push({
          code: 'sums-disagreement',
          path,
          message: `${SUMS_FILE} records ${sha256} for '${path}' but the manifest records ${fromManifest.sha256}`,
        });
      }
    }
    const expectedBytes = recorded.get(path)?.bytes ?? null;
    await checkFile(path, sha256, expectedBytes);
  }
  for (const [path, entry] of recorded) {
    await checkFile(path, entry.sha256, entry.bytes);
  }

  // 2. Anything else in the run directory is tampering or debris.
  for (const path of onDisk) {
    if (path === SUMS_FILE || path === MANIFEST_FILE) continue;
    if (!checked.has(path)) {
      files.push({
        path,
        recordedSha256: null,
        actualSha256: null,
        recordedBytes: null,
        actualBytes: null,
        status: 'unexpected',
      });
    }
  }

  // 3. Every captured body, re-hashed from rows.jsonl.
  let rowCount = 0;
  let payloads: BackupRowPayload[] = [];
  if (manifest) {
    const rowsBytes = await readIfPresent(
      reader,
      manifest.rowsFile ?? ROWS_FILE
    );
    if (!rowsBytes) {
      problems.push({
        code: 'rows-missing',
        path: manifest.rowsFile ?? ROWS_FILE,
        message: `${manifest.rowsFile ?? ROWS_FILE} is missing`,
      });
    } else {
      const rowsFileOk = files.find(
        (file) => file.path === (manifest.rowsFile ?? ROWS_FILE)
      );
      if (rowsFileOk && rowsFileOk.status !== 'ok') {
        problems.push({
          code: 'rows-mismatch',
          path: rowsFileOk.path,
          message: `${rowsFileOk.path} does not match the hash recorded for it`,
        });
      }
      try {
        payloads = parseRowsJsonl(
          rowsBytes,
          `${options.backupDir}/${manifest.rowsFile ?? ROWS_FILE}`
        );
        rowCount = payloads.length;
      } catch (error) {
        problems.push({
          code: 'rows-unreadable',
          path: manifest.rowsFile ?? ROWS_FILE,
          message: messageOf(error),
        });
      }
    }

    const byKey = new Map(
      payloads.map((payload) => [`${payload.kind}:${payload.id}`, payload])
    );
    for (const row of manifest.rows) {
      const payload = byKey.get(`${row.kind}:${row.id}`);
      for (const locale of BODY_LOCALES) {
        const body = locale === 'en' ? row.en : row.it;
        const value =
          payload === undefined
            ? undefined
            : locale === 'en'
              ? payload.body_en
              : payload.body_it;
        if (value === undefined) {
          bodies.push({
            kind: row.kind,
            id: row.id,
            locale,
            expectedSha256: body.bodySha256,
            expectedBytes: body.bodyBytes,
            actualSha256: null,
            actualBytes: 0,
            status: 'missing',
          });
          continue;
        }
        const actualSha256 =
          value === null ? null : sha256Hex(Buffer.from(value, 'utf8'));
        const actualBytes =
          value === null ? 0 : Buffer.byteLength(value, 'utf8');
        bodies.push({
          kind: row.kind,
          id: row.id,
          locale,
          expectedSha256: body.bodySha256,
          expectedBytes: body.bodyBytes,
          actualSha256,
          actualBytes,
          status:
            actualSha256 === body.bodySha256 && actualBytes === body.bodyBytes
              ? 'ok'
              : 'mismatch',
        });
      }
    }

    // 4. Every object, re-hashed against the manifest AND its own key.
    for (const object of manifest.objects) {
      if (!object.captured) continue;
      if (!object.file) {
        problems.push({
          code: 'object-file-unrecorded',
          path: null,
          message: `object '${object.path}' is recorded as captured but names no file`,
        });
        continue;
      }
      const record = files.find((file) => file.path === object.file);
      const onDiskBytes = onDiskSet.has(object.file);
      if (!onDiskBytes) continue;
      if (record && record.status !== 'ok') continue;
      if (
        object.sha256 !== null &&
        pointerHashFor(
          object.kind,
          object.postId,
          object.locale,
          object.path
        ) !== object.sha256
      ) {
        problems.push({
          code: 'object-key-mismatch',
          path: object.file,
          message: `object '${object.path}' is not the canonical key for its own hash ${object.sha256}`,
        });
      }
    }
  }

  for (const file of files) {
    if (file.status === 'mismatch') {
      problems.push({
        code: 'file-mismatch',
        path: file.path,
        message: `'${file.path}' hashes to ${file.actualSha256}, not to the recorded ${file.recordedSha256}`,
      });
    }
    if (file.status === 'missing') {
      problems.push({
        code: 'file-missing',
        path: file.path,
        message: `'${file.path}' is recorded in the artifact but missing on disk`,
      });
    }
    if (file.status === 'unexpected') {
      problems.push({
        code: 'file-unexpected',
        path: file.path,
        message: `'${file.path}' is present on disk but recorded nowhere in the artifact`,
      });
    }
  }
  for (const body of bodies) {
    if (body.status === 'mismatch') {
      problems.push({
        code: 'body-mismatch',
        path: null,
        message: `${body.kind}/${body.id}/${body.locale}: captured legacy value hashes to ${body.actualSha256}/${body.actualBytes} bytes, not to the recorded ${body.expectedSha256}/${body.expectedBytes} bytes`,
      });
    }
    if (body.status === 'missing') {
      problems.push({
        code: 'body-missing',
        path: null,
        message: `${body.kind}/${body.id}/${body.locale}: captured in the manifest but absent from rows.jsonl`,
      });
    }
  }
  if (manifest && rowCount !== manifest.rows.length) {
    problems.push({
      code: 'rows-count-mismatch',
      path: manifest.rowsFile ?? ROWS_FILE,
      message: `${options.backupDir}: ${rowCount} payload row(s) vs ${manifest.rows.length} manifest row(s)`,
    });
  }

  const counts: VerifyReport['counts'] = {
    files: files.length,
    filesOk: files.filter((file) => file.status === 'ok').length,
    filesMismatched: files.filter((file) => file.status === 'mismatch').length,
    filesMissing: files.filter((file) => file.status === 'missing').length,
    filesUnexpected: files.filter((file) => file.status === 'unexpected')
      .length,
    rows: rowCount,
    bodies: bodies.length,
    bodiesMismatched: bodies.filter((body) => body.status !== 'ok').length,
    objects: manifest
      ? manifest.objects.filter((object) => object.captured).length
      : 0,
    objectsMismatched: problems.filter((problem) =>
      problem.code.startsWith('object')
    ).length,
  };

  return {
    command: LEGACY_BODY_BACKUP_COMMAND,
    mode: 'verify',
    backupDir: resolve(options.backupDir),
    runId: manifest ? manifest.runId : null,
    generatedAt: new Date(options.now).toISOString(),
    ok: problems.length === 0,
    manifestSha256: loaded.ok ? sha256Hex(loaded.bytes) : null,
    sumsSha256: sumsBytes ? sha256Hex(sumsBytes) : null,
    counts,
    files,
    bodies,
    problems,
  };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY database surface the restore accepts: one `upsert` per batch. There
 * is no select/update/delete, so a restore cannot read production through this
 * handle and cannot touch a row it did not submit.
 */
export type RestoreRowClient = {
  from(table: string): {
    upsert(
      rows: Record<string, unknown>[],
      options: { onConflict: string }
    ): PromiseLike<{ error: { message: string } | null }>;
  };
};

export type RestoreFailure = {
  scope: 'rows' | 'objects';
  /** Object path, or the batch' row key range, for the failure. */
  target: string;
  message: string;
};

export type RestoreReport = {
  command: typeof LEGACY_BODY_BACKUP_COMMAND;
  mode: 'restore';
  apply: boolean;
  backupDir: string;
  runId: string | null;
  generatedAt: string;
  ok: boolean;
  target: {
    ref: string;
    schema: string;
    table: string;
    bucket: string | null;
  } | null;
  verification: { ok: boolean; problems: number } | null;
  /** Set when a gate or the artifact stopped the restore before any write. */
  blocked: string | null;
  counts: {
    rowsPlanned: number;
    rowsRestored: number;
    rowBatches: number;
    objectsPlanned: number;
    objectsRestored: number;
    upserts: number;
    uploads: number;
    failures: number;
  };
  findings: BackupFinding[];
  failures: RestoreFailure[];
};

/** The row payload a restore submits, including the hashes it can be checked with. */
export function restoreRowRecord(
  runId: string,
  payload: BackupRowPayload
): Record<string, unknown> {
  return {
    run_id: runId,
    kind: payload.kind,
    post_id: payload.id,
    hidden: payload.hidden,
    body_en: payload.body_en,
    body_it: payload.body_it,
    body_en_path: payload.body_en_path,
    body_it_path: payload.body_it_path,
    body_en_sha256:
      payload.body_en === null
        ? null
        : sha256Hex(Buffer.from(payload.body_en, 'utf8')),
    body_it_sha256:
      payload.body_it === null
        ? null
        : sha256Hex(Buffer.from(payload.body_it, 'utf8')),
    body_en_bytes:
      payload.body_en === null ? 0 : Buffer.byteLength(payload.body_en, 'utf8'),
    body_it_bytes:
      payload.body_it === null ? 0 : Buffer.byteLength(payload.body_it, 'utf8'),
  };
}

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

export type RestorePlan = {
  runId: string;
  rows: BackupRowPayload[];
  /** Objects whose bytes are in the artifact, with their file and hash. */
  objects: Array<{
    path: string;
    kind: BodyContentKind;
    postId: number;
    locale: BodyContentLocale;
    sha256: string;
    file: string;
  }>;
  /** Referenced objects whose bytes could not be captured (never restorable). */
  uncaptured: string[];
  findings: BackupFinding[];
};

/** Builds the restore plan from a verified manifest + its payload rows. */
export function buildRestorePlan(
  manifest: BackupManifest,
  rows: BackupRowPayload[]
): RestorePlan {
  const objects = manifest.objects
    .filter(
      (
        object
      ): object is BackupManifestObject & { sha256: string; file: string } =>
        object.captured && object.sha256 !== null && object.file !== null
    )
    .map((object) => ({
      path: object.path,
      kind: object.kind,
      postId: object.postId,
      locale: object.locale,
      sha256: object.sha256,
      file: object.file,
    }));
  return {
    runId: manifest.runId,
    rows,
    objects,
    uncaptured: manifest.objects
      .filter((object) => !object.captured)
      .map((object) => object.path),
    findings: manifest.findings,
  };
}

/**
 * Replays a verified artifact into the scratch target: rows through one
 * `upsert` per batch, objects through immutable uploads that are read back and
 * proved byte-for-byte. Every failure is recorded per target and never aborts
 * the remaining work, so the report always accounts for everything.
 */
export async function restoreBackupArtifact(deps: {
  target: RestoreTarget;
  plan: RestorePlan;
  reader: BackupReader;
  rows: RestoreRowClient;
  objects: BodyContentStorageApi | null;
}): Promise<{
  counts: RestoreReport['counts'];
  failures: RestoreFailure[];
}> {
  const failures: RestoreFailure[] = [];
  const counts: RestoreReport['counts'] = {
    rowsPlanned: deps.plan.rows.length,
    rowsRestored: 0,
    rowBatches: 0,
    objectsPlanned: deps.target.bucket ? deps.plan.objects.length : 0,
    objectsRestored: 0,
    upserts: 0,
    uploads: 0,
    failures: 0,
  };

  for (const rows of batch(deps.plan.rows, RESTORE_BATCH_SIZE)) {
    counts.rowBatches += 1;
    const records = rows.map((row) => restoreRowRecord(deps.plan.runId, row));
    counts.upserts += 1;
    const result = await deps.rows
      .from(deps.target.table)
      .upsert(records, { onConflict: RESTORE_CONFLICT_TARGET });
    if (result.error) {
      failures.push({
        scope: 'rows',
        target: `${deps.target.schema}.${deps.target.table} rows ${rows[0].kind}/${rows[0].id}..${rows[rows.length - 1].id}`,
        message: result.error.message,
      });
      continue;
    }
    counts.rowsRestored += rows.length;
  }

  if (deps.target.bucket && deps.objects) {
    const storage = deps.objects;
    for (const object of deps.plan.objects) {
      try {
        const bytes = await deps.reader.readFile(object.file);
        const prepared: PreparedBodyContent = {
          kind: object.kind,
          postId: object.postId,
          locale: object.locale,
          hash: object.sha256,
          path: object.path,
          bytes,
          size: bytes.length,
          contentType: BODY_CONTENT_TYPE,
        };
        counts.uploads += 1;
        const uploaded = await uploadBodyContent(storage, prepared);
        if (uploaded.status === 'uploaded') {
          const stored = await readBodyContentBytes(storage, object.path);
          if (sha256Hex(stored) !== object.sha256) {
            throw new Error(
              `read-back hash mismatch: stored ${sha256Hex(stored)} bytes, expected ${object.sha256}`
            );
          }
        }
        counts.objectsRestored += 1;
      } catch (error) {
        failures.push({
          scope: 'objects',
          target: `${deps.target.bucket}/${object.path}`,
          message: messageOf(error),
        });
      }
    }
  }

  counts.failures = failures.length;
  return { counts, failures };
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUCKET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const LEGACY_BODY_BACKUP_USAGE = [
  'usage:',
  `  bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir>`,
  '      read-only dry run: reads production, writes nothing',
  `  CMS_PROD_BACKUP_APPLY_ACK=${BACKUP_APPLY_ACK_VALUE} \\`,
  `    bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply`,
  '      write the baseline artifact (needs the acknowledgement)',
  `  bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<dir>`,
  '      offline: re-hash the on-disk files against the manifest',
  `  CMS_BACKUP_RESTORE_ACK=${BACKUP_RESTORE_ACK_VALUE} \\`,
  '    bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<dir> \\',
  `      [--restore-schema=${DEFAULT_RESTORE_SCHEMA}] [--restore-table=${DEFAULT_RESTORE_TABLE}] \\`,
  '      [--restore-bucket=<bucket>] --apply',
  '      restore into a SCRATCH target (needs the acknowledgement)',
  '',
  `--apply additionally requires APP_ENV=${BACKUP_APP_ENV},`,
  `NEXT_PUBLIC_SUPABASE_DB_SCHEMA=${BACKUP_SCHEMA} and`,
  `NEXT_PUBLIC_SUPABASE_URL=https://${BACKUP_PROJECT_REF}.supabase.co.`,
  `--restore additionally requires ${RESTORE_URL_ENV} and ${RESTORE_KEY_ENV}`,
  'and never targets a live production content table.',
  'Silence is read-only everywhere: without --apply nothing is written, on any',
  'surface, ever. The artifact lands outside both repositories.',
  `A package.json script named ${LEGACY_BODY_BACKUP_COMMAND} is the parent's.`,
].join('\n');

export type LegacyBodyBackupArgs =
  | { mode: 'export'; outDir: string | null; apply: boolean; json: boolean }
  | { mode: 'verify'; backupDir: string; json: boolean }
  | {
      mode: 'restore';
      backupDir: string;
      apply: boolean;
      json: boolean;
      schema: string;
      table: string;
      bucket: string | null;
    }
  | { mode: 'help' }
  | { mode: 'invalid'; error: string };

type ParsedFlags = {
  outDir: string | null;
  backupDir: string | null;
  restoreSchema: string | null;
  restoreTable: string | null;
  restoreBucket: string | null;
  verify: boolean;
  restore: boolean;
  apply: boolean;
  json: boolean;
};

/**
 * Strict flag parsing: silence is a read-only export dry run, every unknown or
 * duplicated argument is refused rather than ignored (so a typo can never be
 * mistaken for a write), and every flag is only legal in the mode that uses it.
 */
export function parseLegacyBodyBackupArgs(
  argv: string[]
): LegacyBodyBackupArgs {
  const flags: ParsedFlags = {
    outDir: null,
    backupDir: null,
    restoreSchema: null,
    restoreTable: null,
    restoreBucket: null,
    verify: false,
    restore: false,
    apply: false,
    json: false,
  };
  const seen = new Set<string>();

  const assign = (name: string, value: string): string | null => {
    if (seen.has(name)) return `duplicate --${name}`;
    seen.add(name);
    if (value === '') return `--${name} requires a value`;
    return null;
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { mode: 'help' };
    if (arg === '--apply') {
      if (flags.apply) return { mode: 'invalid', error: 'duplicate --apply' };
      flags.apply = true;
      continue;
    }
    if (arg === '--json') {
      if (flags.json) return { mode: 'invalid', error: 'duplicate --json' };
      flags.json = true;
      continue;
    }
    if (arg === '--verify') {
      if (flags.verify) return { mode: 'invalid', error: 'duplicate --verify' };
      flags.verify = true;
      continue;
    }
    if (arg === '--restore') {
      if (flags.restore)
        return { mode: 'invalid', error: 'duplicate --restore' };
      flags.restore = true;
      continue;
    }
    const assignment = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!assignment) {
      return { mode: 'invalid', error: `unexpected argument: ${arg}` };
    }
    const [, name, value] = assignment;
    if (
      name !== 'out-dir' &&
      name !== 'backup-dir' &&
      name !== 'restore-schema' &&
      name !== 'restore-table' &&
      name !== 'restore-bucket'
    ) {
      return { mode: 'invalid', error: `unexpected argument: ${arg}` };
    }
    const problem = assign(name, value);
    if (problem) return { mode: 'invalid', error: problem };
    if (name === 'out-dir') flags.outDir = value;
    if (name === 'backup-dir') flags.backupDir = value;
    if (name === 'restore-schema') flags.restoreSchema = value;
    if (name === 'restore-table') flags.restoreTable = value;
    if (name === 'restore-bucket') flags.restoreBucket = value;
  }

  if (flags.verify && flags.restore) {
    return {
      mode: 'invalid',
      error: '--verify and --restore are mutually exclusive',
    };
  }
  if (flags.restore && flags.outDir) {
    return { mode: 'invalid', error: '--out-dir is only valid for an export' };
  }
  if (
    (flags.verify || !flags.restore) &&
    (flags.restoreSchema || flags.restoreTable || flags.restoreBucket)
  ) {
    return {
      mode: 'invalid',
      error: 'the --restore-* flags are only valid with --restore',
    };
  }
  if (flags.verify && flags.apply) {
    return {
      mode: 'invalid',
      error: '--verify never writes, so --apply is not accepted with it',
    };
  }

  if (flags.verify) {
    if (!flags.backupDir) {
      return { mode: 'invalid', error: '--verify requires --backup-dir=<dir>' };
    }
    return { mode: 'verify', backupDir: flags.backupDir, json: flags.json };
  }

  if (flags.restore) {
    if (!flags.backupDir) {
      return {
        mode: 'invalid',
        error: '--restore requires --backup-dir=<dir>',
      };
    }
    const schema = flags.restoreSchema ?? DEFAULT_RESTORE_SCHEMA;
    if (!IDENTIFIER_PATTERN.test(schema)) {
      return {
        mode: 'invalid',
        error: `--restore-schema '${schema}' is not a plain SQL identifier`,
      };
    }
    const table = flags.restoreTable ?? DEFAULT_RESTORE_TABLE;
    if (!IDENTIFIER_PATTERN.test(table)) {
      return {
        mode: 'invalid',
        error: `--restore-table '${table}' is not a plain SQL identifier`,
      };
    }
    if (
      flags.restoreBucket !== null &&
      !BUCKET_PATTERN.test(flags.restoreBucket)
    ) {
      return {
        mode: 'invalid',
        error: `--restore-bucket '${flags.restoreBucket}' is not a bucket name`,
      };
    }
    return {
      mode: 'restore',
      backupDir: flags.backupDir,
      apply: flags.apply,
      json: flags.json,
      schema,
      table,
      bucket: flags.restoreBucket,
    };
  }

  if (flags.backupDir) {
    return {
      mode: 'invalid',
      error:
        '--backup-dir is only valid with --verify or --restore; an export names --out-dir',
    };
  }
  if (flags.apply && !flags.outDir) {
    return {
      mode: 'invalid',
      error: `--apply requires --out-dir=<dir>: the artifact must be written outside both repositories`,
    };
  }
  return {
    mode: 'export',
    outDir: flags.outDir,
    apply: flags.apply,
    json: flags.json,
  };
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/** `2026-10-19T14-15-30-123Z` — sortable, filesystem-safe, no colons. */
export function compactTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** Timestamped, append-only run directory name (timestamp + random run id). */
export function runDirectoryName(now: number, runId: string): string {
  return `prod-legacy-bodies-${compactTimestamp(now)}-${runId}`;
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

export type BackupReport = {
  command: typeof LEGACY_BODY_BACKUP_COMMAND;
  mode: 'dry-run' | 'apply';
  appEnv: string;
  schema: string;
  projectRef: string;
  bucket: string;
  generatedAt: string;
  runId: string;
  /**
   * The run directory: the one that was written (`artifact` non-null) or the
   * one an `--apply` run would create. Null only when `--out-dir` is absent.
   */
  runDirectory: string | null;
  complete: boolean;
  counts: BackupCounts;
  rows: BackupManifestRow[];
  objects: BackupManifestObject[];
  findings: BackupFinding[];
  artifact: {
    manifestSha256: string;
    rowsSha256: string;
    sumsSha256: string;
    files: number;
    objectFiles: number;
  } | null;
};

/** Human-readable audit of an export, one line per recorded fact. */
export function humanBackupLines(report: BackupReport): string[] {
  const lines = [
    `command=${report.command} mode=${report.mode} appEnv=${report.appEnv} schema=${report.schema} project=${report.projectRef} bucket=${report.bucket}`,
    `rows: total=${report.counts.rows} blog=${report.counts.blog} portfolio=${report.counts.portfolio} hidden=${report.counts.hidden} visible=${report.counts.visible}`,
    `bodies: captured=${report.counts.bodies} bytes=${report.counts.bodyBytes}`,
    `objects: referenced=${report.counts.pointers} captured=${report.counts.objects} bytes=${report.counts.objectBytes} missing=${report.counts.objectsMissing}`,
    `findings: errors=${report.counts.errors} warnings=${report.counts.warnings} complete=${report.complete}`,
  ];
  for (const finding of report.findings) {
    lines.push(
      `finding ${finding.severity} ${finding.code} ${finding.message}`
    );
  }
  if (report.mode === 'dry-run') {
    lines.push(
      report.runDirectory
        ? `dry run: nothing was written; re-run with --apply and ${BACKUP_APPLY_ACK_ENV}=${BACKUP_APPLY_ACK_VALUE} to write ${report.runDirectory}`
        : `dry run: nothing was written; pass --out-dir=<dir> as well to see the run directory an --apply run would create`
    );
    return lines;
  }
  lines.push(`artifact ${report.runDirectory}`);
  if (report.artifact) {
    lines.push(`manifest-sha256 ${report.artifact.manifestSha256}`);
    lines.push(
      `sha256sums-sha256 ${report.artifact.sumsSha256}  # record this out of band`
    );
    lines.push(
      `files: recorded=${report.artifact.files} objects=${report.artifact.objectFiles}`
    );
  }
  return lines;
}

export function humanVerifyLines(report: VerifyReport): string[] {
  const lines = [
    `command=${report.command} mode=verify dir=${report.backupDir} runId=${report.runId ?? 'unknown'} intact=${report.ok}`,
    `sha256sums-sha256 ${report.sumsSha256 ?? 'missing'}  # compare with the value retained out of band`,
    `manifest-sha256 ${report.manifestSha256 ?? 'missing'}`,
    `files: checked=${report.counts.files} ok=${report.counts.filesOk} mismatched=${report.counts.filesMismatched} missing=${report.counts.filesMissing} unexpected=${report.counts.filesUnexpected}`,
    `rows=${report.counts.rows} bodies=${report.counts.bodies} bodiesMismatched=${report.counts.bodiesMismatched} objects=${report.counts.objects}`,
  ];
  for (const file of report.files) {
    if (file.status === 'ok') continue;
    lines.push(`file ${file.status} ${file.path}`);
  }
  for (const problem of report.problems) {
    lines.push(`problem ${problem.code} ${problem.message}`);
  }
  lines.push(
    report.ok
      ? 'verified: every recorded hash matches the bytes on disk.'
      : 'NOT verified: the artifact above does not match its manifest; retain the original and do not restore from it.'
  );
  return lines;
}

export function humanRestoreLines(report: RestoreReport): string[] {
  const target = report.target;
  const lines = [
    `command=${report.command} mode=restore apply=${report.apply} dir=${report.backupDir} runId=${report.runId ?? 'unknown'}`,
    target
      ? `target: ${target.schema}.${target.table} project=${target.ref} bucket=${target.bucket ?? '(rows only)'}`
      : 'target: none',
    report.verification
      ? `artifact: verified=${report.verification.ok} problems=${report.verification.problems}`
      : 'artifact: not verified',
    `rows: planned=${report.counts.rowsPlanned} restored=${report.counts.rowsRestored} batches=${report.counts.rowBatches} upserts=${report.counts.upserts}`,
    `objects: planned=${report.counts.objectsPlanned} restored=${report.counts.objectsRestored} uploads=${report.counts.uploads}`,
    `failures=${report.counts.failures}`,
  ];
  if (report.blocked) lines.push(`blocked: ${report.blocked}`);
  for (const finding of report.findings) {
    lines.push(
      `finding ${finding.severity} ${finding.code} ${finding.message}`
    );
  }
  for (const failure of report.failures) {
    lines.push(
      `failure ${failure.scope} ${failure.target}: ${failure.message}`
    );
  }
  if (!report.apply) {
    lines.push(
      report.blocked
        ? 'dry run: nothing was written.'
        : `dry run: nothing was written; re-run with --apply and ${BACKUP_RESTORE_ACK_ENV}=${BACKUP_RESTORE_ACK_VALUE} to write ${report.counts.rowsPlanned} row(s) and ${report.counts.objectsPlanned} object(s).`
    );
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

export type LegacyBodyBackupCliDeps = {
  argv: string[];
  observed: LegacyBodyBackupEnv;
  env: Readonly<Record<string, string | undefined>>;
  /** The checkouts an `--out-dir` may not live inside. */
  repositories: readonly string[];
  /** Called only after the export gates pass. */
  openRowReader(): LegacyBodyReader;
  openObjects(): BodyContentStorageApi;
  /** Called only for an armed export, after every gate. */
  openWriter(runDirectory: string): BackupWriter;
  /** Called by `--verify` and `--restore` (local files only). */
  openReader(runDirectory: string): BackupReader;
  /** Called only for an armed restore, after every gate and the verification. */
  openRestoreRows(target: RestoreTarget): RestoreRowClient;
  openRestoreObjects(
    target: RestoreTarget,
    bucket: string
  ): BodyContentStorageApi;
  now?(): number;
  runId?(): string;
};

export type LegacyBodyBackupCliOutcome = {
  exitCode: number;
  report: BackupReport | VerifyReport | RestoreReport | null;
  lines: string[];
  error: string | null;
};

function refusal(exitCode: number, error: unknown): LegacyBodyBackupCliOutcome {
  return { exitCode, report: null, lines: [], error: messageOf(error) };
}

/**
 * The whole command, with every dependency injected. Gate order is explicit and
 * identical in spirit to `prodStorageGc.ts`: usage → environment → apply
 * acknowledgement → (restore) target → artifact verification. Every client,
 * writer and reader factory runs only after the gate that authorises it, so a
 * refused run builds nothing and a dry run cannot write.
 */
export async function runLegacyBodyBackupCli(
  deps: LegacyBodyBackupCliDeps
): Promise<LegacyBodyBackupCliOutcome> {
  const args = parseLegacyBodyBackupArgs(deps.argv);
  if (args.mode === 'invalid') {
    return {
      exitCode: 2,
      report: null,
      lines: [],
      error: `${args.error}\n${LEGACY_BODY_BACKUP_USAGE}`,
    };
  }
  if (args.mode === 'help') {
    return {
      exitCode: 0,
      report: null,
      lines: [LEGACY_BODY_BACKUP_USAGE],
      error: null,
    };
  }

  const now = deps.now ?? (() => Date.now());
  const newRunId = deps.runId ?? (() => randomBytes(6).toString('hex'));

  if (args.mode === 'verify') {
    try {
      const report = await verifyBackupArtifact(
        deps.openReader(args.backupDir),
        {
          backupDir: args.backupDir,
          now: now(),
        }
      );
      return {
        exitCode: report.ok ? 0 : 1,
        report,
        lines: args.json ? [] : humanVerifyLines(report),
        error: null,
      };
    } catch (error) {
      return refusal(4, error);
    }
  }

  if (args.mode === 'restore') {
    return runRestoreCli(deps, args, now);
  }

  return runExportCli(deps, args, now, newRunId);
}

/** Export (dry run or armed write). */
async function runExportCli(
  deps: LegacyBodyBackupCliDeps,
  args: Extract<LegacyBodyBackupArgs, { mode: 'export' }>,
  now: () => number,
  newRunId: () => string
): Promise<LegacyBodyBackupCliOutcome> {
  try {
    assertLegacyBodyBackupEnvAllowed(deps.observed);
  } catch (error) {
    return refusal(3, error);
  }
  if (args.apply) {
    try {
      assertBackupApplyAcknowledged(readBackupApplyAck(deps.env));
    } catch (error) {
      return refusal(5, error);
    }
  }
  if (args.outDir) {
    try {
      assertBackupOutDirAllowed(args.outDir, deps.repositories);
    } catch (error) {
      return refusal(3, error);
    }
  }

  const runId = newRunId();
  const at = now();
  const runDirectory =
    args.outDir === null
      ? null
      : join(resolve(args.outDir), runDirectoryName(at, runId));

  try {
    const capture = await captureLegacyBodies({
      reader: deps.openRowReader(),
      objects: deps.openObjects(),
    });
    // Built exactly once, whether or not it is written: the report and the
    // artifact must never be two different descriptions of the same capture.
    const artifact = buildBackupArtifact(capture, {
      runId,
      runDirectory: runDirectory ?? '',
      generatedAt: new Date(at).toISOString(),
      appEnv: deps.observed.appEnv,
      schema: deps.observed.schema,
      projectRef: projectRefFromUrl(deps.observed.supabaseUrl) ?? '',
      bucket: BACKUP_BUCKET,
    });
    const armed = args.apply && runDirectory !== null;
    if (armed && runDirectory !== null) {
      await writeBackupArtifact(deps.openWriter(runDirectory), artifact);
    }
    const report: BackupReport = {
      command: LEGACY_BODY_BACKUP_COMMAND,
      mode: armed ? 'apply' : 'dry-run',
      appEnv: deps.observed.appEnv,
      schema: deps.observed.schema,
      projectRef: projectRefFromUrl(deps.observed.supabaseUrl) ?? '',
      bucket: BACKUP_BUCKET,
      generatedAt: new Date(at).toISOString(),
      runId,
      runDirectory,
      complete: artifact.manifest.complete,
      counts: artifact.manifest.counts,
      rows: artifact.manifest.rows,
      objects: artifact.manifest.objects,
      findings: artifact.manifest.findings,
      artifact: armed
        ? {
            manifestSha256: sha256Hex(artifact.manifestBytes),
            rowsSha256: sha256Hex(artifact.rowsJsonl),
            sumsSha256: artifact.sumsSha256,
            files: artifact.files.length + 1,
            objectFiles: artifact.objectFiles.length,
          }
        : null,
    };
    return {
      exitCode: artifact.manifest.complete ? 0 : 1,
      report,
      lines: args.json ? [] : humanBackupLines(report),
      error: null,
    };
  } catch (error) {
    return refusal(4, error);
  }
}

/** Restore (dry run or armed write into the scratch target). */
async function runRestoreCli(
  deps: LegacyBodyBackupCliDeps,
  args: Extract<LegacyBodyBackupArgs, { mode: 'restore' }>,
  now: () => number
): Promise<LegacyBodyBackupCliOutcome> {
  const credentials = readRestoreCredentials(deps.env);
  const target: RestoreTarget = {
    url: credentials.url,
    ref: projectRefFromUrl(credentials.url) ?? '',
    schema: args.schema,
    table: args.table,
    bucket: args.bucket,
  };
  try {
    assertRestoreTargetAllowed(target);
  } catch (error) {
    return refusal(3, error);
  }
  if (!credentials.key) {
    return refusal(
      3,
      new Error(
        `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to restore: ${RESTORE_KEY_ENV} is not configured (the target's server-side key; it is never printed)`
      )
    );
  }
  if (args.apply) {
    try {
      assertBackupRestoreAcknowledged(readBackupRestoreAck(deps.env));
    } catch (error) {
      return refusal(5, error);
    }
  }
  if (target.bucket !== null && target.bucket === BACKUP_BUCKET) {
    return refusal(
      3,
      new Error(
        `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to restore objects into '${BACKUP_BUCKET}': a restore target must not be the production content bucket`
      )
    );
  }

  try {
    const reader = deps.openReader(args.backupDir);
    const verification = await verifyBackupArtifact(reader, {
      backupDir: args.backupDir,
      now: now(),
    });
    const loaded = await loadBackupManifest(reader);

    const counts = {
      rowsPlanned: 0,
      rowsRestored: 0,
      rowBatches: 0,
      objectsPlanned: 0,
      objectsRestored: 0,
      upserts: 0,
      uploads: 0,
      failures: 0,
    };
    const base: RestoreReport = {
      command: LEGACY_BODY_BACKUP_COMMAND,
      mode: 'restore',
      apply: args.apply,
      backupDir: resolve(args.backupDir),
      runId: loaded.ok ? loaded.manifest.runId : null,
      generatedAt: new Date(now()).toISOString(),
      ok: false,
      target: {
        ref: target.ref,
        schema: target.schema,
        table: target.table,
        bucket: target.bucket,
      },
      verification: {
        ok: verification.ok,
        problems: verification.problems.length,
      },
      blocked: null,
      counts,
      findings: loaded.ok ? loaded.manifest.findings : [],
      failures: [],
    };

    if (!verification.ok || !loaded.ok) {
      const blocked = `the artifact failed verification (${verification.problems.length} problem(s)); refusing to restore from ${resolve(args.backupDir)}`;
      const report = { ...base, blocked, ok: false };
      return {
        exitCode: 1,
        report,
        lines: args.json ? [] : humanRestoreLines(report),
        error: null,
      };
    }

    const rowsBytes = await reader.readFile(loaded.manifest.rowsFile);
    const payloads = parseRowsJsonl(
      rowsBytes,
      `${args.backupDir}/${ROWS_FILE}`
    );
    const plan = buildRestorePlan(loaded.manifest, payloads);

    if (target.bucket !== null && plan.uncaptured.length > 0) {
      const blocked = `object restore requested but ${plan.uncaptured.length} referenced object(s) were never captured: ${plan.uncaptured.join(', ')}`;
      const report = { ...base, blocked, ok: false };
      return {
        exitCode: 3,
        report,
        lines: args.json ? [] : humanRestoreLines(report),
        error: blocked,
      };
    }

    if (!args.apply) {
      const report: RestoreReport = {
        ...base,
        ok: verification.ok,
        counts: {
          ...counts,
          rowsPlanned: plan.rows.length,
          objectsPlanned: target.bucket === null ? 0 : plan.objects.length,
        },
      };
      return {
        exitCode: verification.ok ? 0 : 1,
        report,
        lines: args.json ? [] : humanRestoreLines(report),
        error: null,
      };
    }

    const outcome = await restoreBackupArtifact({
      target,
      plan,
      reader,
      rows: deps.openRestoreRows(target),
      objects:
        target.bucket === null
          ? null
          : deps.openRestoreObjects(target, target.bucket),
    });
    const report: RestoreReport = {
      ...base,
      ok: outcome.failures.length === 0,
      counts: outcome.counts,
      failures: outcome.failures,
    };
    return {
      exitCode: outcome.failures.length === 0 ? 0 : 1,
      report,
      lines: args.json ? [] : humanRestoreLines(report),
      error: null,
    };
  } catch (error) {
    return refusal(4, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Production facades                                                          */
/* -------------------------------------------------------------------------- */

/** Read-only row reader bound to the pinned production project. */
function openProductionRowReader(): LegacyBodyReader {
  return createLegacyBodyReader(getCmsAdminClient(), {
    columns: BACKUP_ROW_COLUMNS,
    schema: BACKUP_SCHEMA,
    label: LEGACY_BODY_BACKUP_COMMAND,
  });
}

/** Storage facade bound to the production content bucket, and to nothing else. */
function openProductionObjects(): BodyContentStorageApi {
  if (BACKUP_BUCKET !== PROD_BACKFILL_ENVIRONMENT.bucket) {
    throw new Error(
      `[${LEGACY_BODY_BACKUP_COMMAND}] refusing to run: storage facade targets '${BACKUP_BUCKET}' but the descriptor owns '${PROD_BACKFILL_ENVIRONMENT.bucket}'`
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServerSecret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabase.storage.from(BACKUP_BUCKET);
}

async function main(): Promise<void> {
  const outcome = await runLegacyBodyBackupCli({
    argv: process.argv.slice(2),
    observed: {
      // Read verbatim, with no NODE_ENV fallback: production must be declared.
      appEnv: process.env.APP_ENV ?? '',
      schema: process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ?? '',
      supabaseUrl,
      hasServerSecret: supabaseServerSecret !== '',
    },
    env: process.env,
    repositories: backupRepositoriesForModule(import.meta.url),
    openRowReader: openProductionRowReader,
    openObjects: openProductionObjects,
    openWriter: createFsBackupWriter,
    openReader: createFsBackupReader,
    openRestoreRows: (target) => {
      const credentials = readRestoreCredentials(process.env);
      return createClient(credentials.url, credentials.key, {
        db: { schema: target.schema },
        auth: { autoRefreshToken: false, persistSession: false },
      });
    },
    openRestoreObjects: (target, bucket) => {
      const credentials = readRestoreCredentials(process.env);
      const supabase = createClient(credentials.url, credentials.key, {
        db: { schema: target.schema },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      return supabase.storage.from(bucket);
    },
  });

  if (outcome.report) console.log(JSON.stringify(outcome.report, null, 2));
  for (const line of outcome.lines) console.log(line);
  if (outcome.error) {
    console.error(`${LEGACY_BODY_BACKUP_COMMAND}: ${outcome.error}`);
  }
  process.exit(outcome.exitCode);
}

if (isDirectInvocation(process.argv, import.meta.url)) {
  await main();
}

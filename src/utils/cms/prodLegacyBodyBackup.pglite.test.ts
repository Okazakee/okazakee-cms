import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type BodyContentKind,
  type BodyContentStorageApi,
  prepareBodyContent,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  type BackupManifest,
  type BackupReader,
  type BackupRowPayload,
  createFsBackupReader,
  createFsBackupWriter,
  DEFAULT_RESTORE_TABLE,
  type LegacyBodyBackupCliDeps,
  type LegacyBodyBackupCliOutcome,
  type LegacyBodyRow,
  loadBackupManifest,
  parseRowsJsonl,
  RESTORE_CONFLICT_TARGET,
  type RestoreRowClient,
  runLegacyBodyBackupCli,
  verifyBackupArtifact,
} from '@/utils/cms/prodLegacyBodyBackup';

/**
 * Real-Postgres restore rehearsal.
 *
 * The unit suites drive the restore against a fake row client that records
 * `upsert` calls. This suite closes the remaining gap: the REAL restore path
 * (`runLegacyBodyBackupCli --restore --apply`) writes into a REAL PostgreSQL
 * database (PGlite, WASM) whose scratch table is created from the SQL block in
 * `docs/PRODUCTION_BACKUP_RESTORE.md` itself — so the documented DDL is
 * executed, not just quoted.
 *
 * Only one seam is substituted: the PostgREST-shaped `RestoreRowClient` is
 * implemented over `jsonb_to_recordset` + `INSERT … ON CONFLICT`, i.e. the same
 * statement a PostgREST upsert compiles to. Everything else is the production
 * code path: artifact verification, manifest parsing, payload construction,
 * batching, per-batch error accounting, and the report.
 *
 * The cross-check is deliberately independent of that payload builder: counts,
 * per-body SHA-256 (`encode(sha256(convert_to(…,'UTF8')),'hex')`, the same
 * expression the doc gives the operator), byte lengths, visibility and the
 * pointer columns are all read back with plain SQL and compared with the
 * artifact's own manifest and `rows.jsonl`.
 *
 * `LEGACY_BODY_BACKUP_REHEARSAL_DIR=<run dir>` additionally rehearses the REAL
 * production artifact (the one under
 * `~/Desktop/Projects/okazakee-prod-backups/`) through the same path; the
 * describe block is skipped when the variable is unset.
 */
const REHEARSAL_DIR = process.env.LEGACY_BODY_BACKUP_REHEARSAL_DIR ?? '';

const DOC_PATH = fileURLToPath(
  new URL('../../../docs/PRODUCTION_BACKUP_RESTORE.md', import.meta.url)
);

/** The scratch-table DDL, exactly as documented (single source of truth). */
async function scratchTableDdl(): Promise<string> {
  const doc = await readFile(DOC_PATH, 'utf8');
  const section = doc.indexOf('### 1. Scratch table in the existing project');
  if (section < 0) {
    throw new Error('the doc has no scratch-table section');
  }
  const block = /```sql\n([\s\S]*?)```/.exec(doc.slice(section));
  if (!block) {
    throw new Error('the scratch-table section has no SQL block');
  }
  return block[1];
}

/* -------------------------------------------------------------------------- */
/* PostgREST-shaped upsert over real SQL                                       */
/* -------------------------------------------------------------------------- */

const RESTORE_COLUMNS = [
  'run_id',
  'kind',
  'post_id',
  'hidden',
  'body_en',
  'body_it',
  'body_en_path',
  'body_it_path',
  'body_en_sha256',
  'body_it_sha256',
  'body_en_bytes',
  'body_it_bytes',
] as const;

const RECORDSET_TYPES = `${RESTORE_COLUMNS.map((column) => `${column} ${column === 'post_id' || column === 'body_en_bytes' || column === 'body_it_bytes' ? 'bigint' : column === 'hidden' ? 'boolean' : 'text'}`).join(', ')}`;

/**
 * The PostgREST upsert, as SQL: `insert … select … from jsonb_to_recordset(…) on
 * conflict … do update`. The conflict target and the row shape are validated
 * against the contract the CLI actually uses; an unknown table is left to
 * PostgreSQL, exactly as a real PostgREST request would fail server-side.
 */
function pgliteRestoreClient(db: PGlite): RestoreRowClient {
  return {
    from(table) {
      return {
        async upsert(rows: Record<string, unknown>[], options) {
          if (options.onConflict !== RESTORE_CONFLICT_TARGET) {
            throw new Error(
              `unexpected conflict target '${options.onConflict}'`
            );
          }
          for (const row of rows) {
            const keys = Object.keys(row).sort().join(',');
            if (keys !== [...RESTORE_COLUMNS].sort().join(',')) {
              return {
                error: { message: `unexpected row shape: ${keys}` },
              };
            }
          }
          try {
            await db.query(
              `insert into public.${table} (${RESTORE_COLUMNS.join(', ')})
                 select ${RESTORE_COLUMNS.join(', ')}
                   from jsonb_to_recordset($1::jsonb) as record(${RECORDSET_TYPES})
                on conflict (run_id, kind, post_id) do update set
                  hidden = excluded.hidden,
                  body_en = excluded.body_en,
                  body_it = excluded.body_it,
                  body_en_path = excluded.body_en_path,
                  body_it_path = excluded.body_it_path,
                  body_en_sha256 = excluded.body_en_sha256,
                  body_it_sha256 = excluded.body_it_sha256,
                  body_en_bytes = excluded.body_en_bytes,
                  body_it_bytes = excluded.body_it_bytes`,
              [JSON.stringify(rows)]
            );
            return { error: null };
          } catch (error) {
            return {
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            };
          }
        },
      };
    },
  };
}

/** The scratch table, created from the documented DDL. */
async function scratchDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(await scratchTableDdl());
  return db;
}

type ScratchRow = {
  kind: string;
  post_id: number | string | bigint;
  hidden: boolean | null;
  body_en: string | null;
  body_it: string | null;
  body_en_path: string | null;
  body_it_path: string | null;
  body_en_sha256: string | null;
  body_it_sha256: string | null;
  body_en_bytes: number | string | bigint;
  body_it_bytes: number | string | bigint;
};

async function scratchRows(db: PGlite, runId: string): Promise<ScratchRow[]> {
  const result = await db.query<ScratchRow>(
    `select kind, post_id, hidden, body_en, body_it, body_en_path, body_it_path,
            body_en_sha256, body_it_sha256, body_en_bytes, body_it_bytes
       from public.${DEFAULT_RESTORE_TABLE}
      where run_id = $1
      order by kind, post_id`,
    [runId]
  );
  return result.rows;
}

/** Digest mismatches recomputed entirely inside PostgreSQL. */
async function sqlDigestMismatches(
  db: PGlite,
  runId: string
): Promise<Array<{ post_id: number; locale: string }>> {
  const result = await db.query<{ post_id: number; locale: string }>(
    `select post_id, 'en' as locale
       from public.${DEFAULT_RESTORE_TABLE}
      where run_id = $1 and body_en is not null
        and encode(sha256(convert_to(body_en, 'UTF8')), 'hex') <> body_en_sha256
     union all
     select post_id, 'it' as locale
       from public.${DEFAULT_RESTORE_TABLE}
      where run_id = $1 and body_it is not null
        and encode(sha256(convert_to(body_it, 'UTF8')), 'hex') <> body_it_sha256`,
    [runId]
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/* Fixture: a real artifact on disk, then a real restore                       */
/* -------------------------------------------------------------------------- */

const PROD_URL = 'https://mtvwynyikouqzmhqespl.supabase.co';
const SCRATCH_URL = 'https://scratchprojectref123.supabase.co';
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

type Fixture = {
  rows: Record<BodyContentKind, LegacyBodyRow[]>;
  objects: Record<string, Buffer>;
};

function postRow(
  kind: BodyContentKind,
  id: number,
  bodies: { en?: string | null; it?: string | null; hidden?: boolean },
  objects: Record<string, Buffer>
): LegacyBodyRow {
  const row: LegacyBodyRow = {
    id,
    hidden: bodies.hidden ?? false,
    body_en: bodies.en ?? null,
    body_it: bodies.it ?? null,
    body_en_path: null,
    body_it_path: null,
  };
  for (const locale of ['en', 'it'] as const) {
    const value = bodies[locale] ?? null;
    if (value === null) continue;
    const prepared = prepareBodyContent(kind, id, locale, value);
    objects[prepared.path] = prepared.bytes;
    row[locale === 'en' ? 'body_en_path' : 'body_it_path'] = prepared.path;
  }
  return row;
}

/** Production-shaped bodies: CRLF, unicode, an emoji, and a NULL locale. */
function fixture(): Fixture {
  const objects: Record<string, Buffer> = {};
  const rows: Record<BodyContentKind, LegacyBodyRow[]> = {
    blog: [
      postRow(
        'blog',
        1,
        {
          en: '# Blog 1 EN\r\n\r\nünïcodé ✓\r\n',
          it: '# Blog 1 IT\n\ncorpo ünïcodé\n',
        },
        objects
      ),
      postRow('blog', 9, { en: '# Blog 9 EN 🎉\n', hidden: true }, objects),
    ],
    portfolio: [
      postRow('portfolio', 4, { en: '# Portfolio 4 EN\n', it: '\n' }, objects),
    ],
  };
  return { rows, objects };
}

type FakeStorage = {
  api: BodyContentStorageApi;
  uploads: Array<{ path: string; bytes: Buffer; upsert: boolean }>;
  downloads: string[];
  removals: string[];
};

function fakeStorage(objects: Record<string, Buffer>): FakeStorage {
  const uploads: Array<{ path: string; bytes: Buffer; upsert: boolean }> = [];
  const downloads: string[] = [];
  const removals: string[] = [];
  return {
    uploads,
    downloads,
    removals,
    api: {
      async upload(path, body, options) {
        uploads.push({
          path,
          bytes: Buffer.from(body),
          upsert: options.upsert,
        });
        objects[path] = Buffer.from(body);
        return { data: { path }, error: null };
      },
      async download(path) {
        downloads.push(path);
        const bytes = objects[path];
        if (!bytes)
          return { data: null, error: { message: 'Object not found' } };
        return { data: new Uint8Array(bytes), error: null };
      },
      async remove(paths) {
        removals.push(...paths);
        return { data: null, error: null };
      },
    },
  };
}

type Rehearsal = {
  deps: LegacyBodyBackupCliDeps;
  runDirectory: string;
  reader: BackupReader;
  storage: FakeStorage;
  manifest: BackupManifest;
  payloads: BackupRowPayload[];
};

/**
 * Exports a real artifact to a real temporary directory through the production
 * export path, then reads it back through the production reader — the same
 * artifact shape and reader a production restore faces.
 */
async function rehearsal(): Promise<Rehearsal> {
  const root = await mkdtemp(join(tmpdir(), 'legacy-body-restore-'));
  directories.push(root);
  const data = fixture();
  const storage = fakeStorage(data.objects);
  const deps: LegacyBodyBackupCliDeps = {
    argv: [],
    observed: {
      appEnv: 'production',
      schema: 'public',
      supabaseUrl: PROD_URL,
      hasServerSecret: true,
    },
    env: {
      APP_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_DB_SCHEMA: 'public',
      CMS_PROD_BACKUP_APPLY_ACK: 'yes-export-production-bodies',
      CMS_BACKUP_RESTORE_ACK: 'yes-restore-to-scratch-target',
      CMS_BACKUP_RESTORE_URL: SCRATCH_URL,
      CMS_BACKUP_RESTORE_KEY: 'sb_secret_not-a-real-key',
    },
    repositories: [],
    openRowReader: () => ({
      async listLegacyBodies(kind) {
        return data.rows[kind] ?? [];
      },
    }),
    openObjects: () => storage.api,
    openWriter: createFsBackupWriter,
    openReader: createFsBackupReader,
    openRestoreRows: () => pgliteRestoreClient(dbUnderTest),
    openRestoreObjects: () => storage.api,
    now: () => Date.parse('2026-10-19T14:15:30.123Z'),
    runId: () => 'abcdef123456',
  };

  const exported = await runLegacyBodyBackupCli({
    ...deps,
    // The post-shim recovery artifact: the kind a restore requires by default.
    argv: [`--out-dir=${root}`, '--apply', '--storage-authoritative'],
  });
  expect(exported.exitCode).toBe(0);
  const report = exported.report;
  if (!report || report.mode === 'verify' || report.mode === 'restore') {
    throw new Error('expected an export report');
  }
  const runDirectory = report.runDirectory;
  if (runDirectory === null) throw new Error('expected a run directory');

  const reader = createFsBackupReader(runDirectory);
  const loaded = await loadBackupManifest(reader);
  if (!loaded.ok) throw new Error(loaded.error);
  const payloads = parseRowsJsonl(
    await reader.readFile(loaded.manifest.rowsFile),
    loaded.manifest.rowsFile
  );
  return {
    deps: { ...deps, argv: [] },
    runDirectory,
    reader,
    storage,
    manifest: loaded.manifest,
    payloads,
  };
}

/** `--restore … --apply` through the production CLI, against real Postgres. */
async function restore(
  target: Rehearsal,
  extra: string[] = []
): Promise<LegacyBodyBackupCliOutcome> {
  return runLegacyBodyBackupCli({
    ...target.deps,
    argv: [
      '--restore',
      `--backup-dir=${target.runDirectory}`,
      ...extra,
      '--apply',
    ],
  });
}

/** Every artifact file's digest, so "the restore consumed nothing" is provable. */
async function artifactSnapshot(
  reader: BackupReader
): Promise<Array<[string, string]>> {
  const files = await reader.listFiles();
  const snapshot: Array<[string, string]> = [];
  for (const file of files) {
    snapshot.push([file, sha256Hex(await reader.readFile(file))]);
  }
  return snapshot;
}

let dbUnderTest: PGlite;

beforeAll(async () => {
  dbUnderTest = new PGlite();
  await dbUnderTest.exec(await scratchTableDdl());
});

afterAll(async () => {
  await dbUnderTest.close();
});

/* -------------------------------------------------------------------------- */
/* The documented DDL                                                          */
/* -------------------------------------------------------------------------- */

describe('documented scratch-table DDL', () => {
  it('creates the table the restore upserts into, with the composite key', async () => {
    const columns = await dbUnderTest.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by column_name`,
      [DEFAULT_RESTORE_TABLE]
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      [...RESTORE_COLUMNS].sort()
    );
    const key = await dbUnderTest.query<{ column_name: string }>(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
        where tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position`,
      [DEFAULT_RESTORE_TABLE]
    );
    expect(key.rows.map((row) => row.column_name)).toEqual([
      'run_id',
      'kind',
      'post_id',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Real restore                                                                */
/* -------------------------------------------------------------------------- */

describe('restore into a real Postgres scratch table', () => {
  it('replays every captured row and value into Postgres and cross-checks in SQL', async () => {
    const target = await rehearsal();
    const before = await artifactSnapshot(target.reader);

    const outcome = await restore(target);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    const report = outcome.report;
    if (!report) throw new Error('expected a restore report, got none');
    if (report.mode !== 'restore') {
      throw new Error(`expected a restore report, got '${report.mode}'`);
    }
    expect(report.ok).toBe(true);
    expect(report.counts.rowsPlanned).toBe(target.manifest.counts.rows);
    expect(report.counts.rowsRestored).toBe(target.manifest.counts.rows);
    expect(report.counts.failures).toBe(0);
    expect(report.target?.table).toBe(DEFAULT_RESTORE_TABLE);
    expect(report.verification?.ok).toBe(true);

    // --- independent SQL cross-check, no payload builder involved ------------
    const rows = await scratchRows(dbUnderTest, target.manifest.runId);
    expect(rows).toHaveLength(target.manifest.counts.rows);
    expect(rows).toHaveLength(target.payloads.length);
    expect(rows.filter((row) => row.hidden === true)).toHaveLength(
      target.manifest.counts.hidden
    );

    // Every restored value hashes to its own recorded digest, in PostgreSQL.
    expect(
      await sqlDigestMismatches(dbUnderTest, target.manifest.runId)
    ).toEqual([]);

    const byKey = new Map(
      target.payloads.map((payload) => [
        `${payload.kind}:${payload.id}`,
        payload,
      ])
    );
    const restoredBodies = rows.reduce(
      (total, row) =>
        total +
        (row.body_en === null || row.body_en === '' ? 0 : 1) +
        (row.body_it === null || row.body_it === '' ? 0 : 1),
      0
    );
    const restoredPointers = rows.reduce(
      (total, row) =>
        total +
        (row.body_en_path === null ? 0 : 1) +
        (row.body_it_path === null ? 0 : 1),
      0
    );
    expect(restoredBodies).toBe(target.manifest.counts.bodies);
    expect(restoredPointers).toBe(target.manifest.counts.pointers);

    for (const row of rows) {
      const payload = byKey.get(`${row.kind}:${Number(row.post_id)}`);
      if (!payload)
        throw new Error(`unexpected restored row ${row.kind}/${row.post_id}`);
      expect(row.body_en).toBe(payload.body_en);
      expect(row.body_it).toBe(payload.body_it);
      expect(row.body_en_path).toBe(payload.body_en_path);
      expect(row.body_it_path).toBe(payload.body_it_path);
      expect(row.hidden).toBe(payload.hidden);
      expect(Number(row.body_en_bytes)).toBe(
        payload.body_en === null
          ? 0
          : Buffer.byteLength(payload.body_en, 'utf8')
      );
      expect(Number(row.body_it_bytes)).toBe(
        payload.body_it === null
          ? 0
          : Buffer.byteLength(payload.body_it, 'utf8')
      );
      expect(row.body_en_sha256).toBe(
        payload.body_en === null
          ? null
          : sha256Hex(Buffer.from(payload.body_en, 'utf8'))
      );
    }

    // Byte length and digest are also consistent with the stored bytea, which
    // only the database can see.
    const lengthDrift = await dbUnderTest.query<{ post_id: number }>(
      `select post_id from public.${DEFAULT_RESTORE_TABLE}
        where run_id = $1
          and (octet_length(body_en) <> body_en_bytes
            or octet_length(body_it) <> body_it_bytes)`,
      [target.manifest.runId]
    );
    expect(lengthDrift.rows).toEqual([]);

    // The canonical pointer columns survived the round trip and still name the
    // objects whose bytes are in the artifact.
    const pointers = await dbUnderTest.query<{
      body_en_path: string | null;
      body_it_path: string | null;
    }>(
      `select body_en_path, body_it_path from public.${DEFAULT_RESTORE_TABLE}
        where run_id = $1 and body_en_path is not null`,
      [target.manifest.runId]
    );
    expect(pointers.rows.length).toBeGreaterThan(0);
    for (const row of pointers.rows) {
      for (const path of [row.body_en_path, row.body_it_path]) {
        if (path === null) continue;
        const object = target.manifest.objects.find(
          (candidate) => candidate.path === path
        );
        expect(object?.captured).toBe(true);
        expect(path).toContain(object?.sha256 ?? '');
      }
    }

    // --- the artifact itself is untouched -----------------------------------
    expect(await artifactSnapshot(target.reader)).toEqual(before);
    const verified = await verifyBackupArtifact(target.reader, {
      backupDir: target.runDirectory,
      now: Date.parse('2026-10-19T14:20:00.000Z'),
    });
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it('is idempotent: re-running the same artifact upserts the same rows', async () => {
    const target = await rehearsal();
    expect((await restore(target)).exitCode).toBe(0);
    const first = await scratchRows(dbUnderTest, target.manifest.runId);
    const second = await restore(target);
    expect(second.exitCode).toBe(0);
    expect(second.report?.mode).toBe('restore');
    expect(await scratchRows(dbUnderTest, target.manifest.runId)).toEqual(
      first
    );
  });

  it('records a real Postgres rejection per batch instead of failing the run', async () => {
    const target = await rehearsal();
    const outcome = await runLegacyBodyBackupCli({
      ...target.deps,
      // A table that does not exist: the adapter surfaces the real PostgreSQL
      // error the way PostgREST would, and the CLI must account for it.
      argv: [
        '--restore',
        `--backup-dir=${target.runDirectory}`,
        '--restore-table=legacy_body_missing_table',
        '--apply',
      ],
    });
    expect(outcome.exitCode).toBe(1);
    const report = outcome.report;
    if (!report) throw new Error('expected a restore report, got none');
    if (report.mode !== 'restore') {
      throw new Error(`expected a restore report, got '${report.mode}'`);
    }
    expect(report.ok).toBe(false);
    expect(report.counts.rowsRestored).toBe(0);
    expect(report.counts.failures).toBeGreaterThan(0);
    expect(report.failures[0].message).toMatch(/legacy_body_missing_table/);
  });
});

/* -------------------------------------------------------------------------- */
/* --restore-bucket against an in-memory target (no real bucket available)      */
/* -------------------------------------------------------------------------- */

describe('--restore-bucket against an in-memory target', () => {
  it('re-uploads the captured bytes immutably and proves them by read-back', async () => {
    const target = await rehearsal();
    const uploadsBefore = target.storage.uploads.length;
    const outcome = await restore(target, ['--restore-bucket=scratch-content']);
    expect(outcome.exitCode).toBe(0);
    const report = outcome.report;
    if (!report) throw new Error('expected a restore report, got none');
    if (report.mode !== 'restore') {
      throw new Error(`expected a restore report, got '${report.mode}'`);
    }
    expect(report.counts.objectsPlanned).toBe(target.manifest.objects.length);
    expect(report.counts.objectsRestored).toBe(target.manifest.objects.length);
    expect(report.counts.uploads).toBe(target.manifest.objects.length);

    const uploaded = target.storage.uploads.slice(uploadsBefore);
    expect(uploaded).toHaveLength(target.manifest.objects.length);
    for (const upload of uploaded) {
      const object = target.manifest.objects.find(
        (candidate) => candidate.path === upload.path
      );
      if (!object) throw new Error(`unrecorded upload ${upload.path}`);
      expect(upload.upsert).toBe(false);
      expect(sha256Hex(upload.bytes)).toBe(object.sha256);
      expect(upload.bytes.length).toBe(object.bytes);
      // The read-back proof ran for every upload.
      expect(target.storage.downloads).toContain(upload.path);
    }
    expect(target.storage.removals).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The real production artifact (opt-in)                                       */
/* -------------------------------------------------------------------------- */

describe.skipIf(REHEARSAL_DIR === '')(
  'real production artifact rehearsal',
  () => {
    it('restores the shipped baseline into scratch Postgres and re-verifies it', async () => {
      const reader = createFsBackupReader(REHEARSAL_DIR);
      const loaded = await loadBackupManifest(reader);
      if (!loaded.ok) throw new Error(loaded.error);
      const manifest = loaded.manifest;
      const before = await artifactSnapshot(reader);
      const db = await scratchDatabase();

      try {
        const outcome = await runLegacyBodyBackupCli({
          argv: ['--restore', `--backup-dir=${REHEARSAL_DIR}`, '--apply'],
          observed: {
            appEnv: 'production',
            schema: 'public',
            supabaseUrl: PROD_URL,
            hasServerSecret: true,
          },
          env: {
            CMS_BACKUP_RESTORE_ACK: 'yes-restore-to-scratch-target',
            CMS_BACKUP_RESTORE_URL: SCRATCH_URL,
            CMS_BACKUP_RESTORE_KEY: 'sb_secret_not-a-real-key',
          },
          repositories: [],
          openRowReader: () => {
            throw new Error('a restore never reads production');
          },
          openObjects: () => {
            throw new Error(
              'a rows-only restore never touches production Storage'
            );
          },
          openWriter: () => {
            throw new Error('a restore never writes an artifact');
          },
          openReader: createFsBackupReader,
          openRestoreRows: () => pgliteRestoreClient(db),
          openRestoreObjects: () => {
            throw new Error('no bucket was requested');
          },
        });

        expect(outcome.exitCode).toBe(0);
        const report = outcome.report;
        if (!report) throw new Error('expected a restore report, got none');
        if (report.mode !== 'restore') {
          throw new Error(`expected a restore report, got '${report.mode}'`);
        }
        expect(report.ok).toBe(true);
        expect(report.counts.rowsRestored).toBe(manifest.counts.rows);

        const rows = await scratchRows(db, manifest.runId);
        expect(rows).toHaveLength(manifest.counts.rows);
        expect(await sqlDigestMismatches(db, manifest.runId)).toEqual([]);
        expect(rows.filter((row) => row.hidden === true)).toHaveLength(
          manifest.counts.hidden
        );
        const restoredBodies = rows.reduce(
          (total, row) =>
            total +
            (row.body_en === null || row.body_en === '' ? 0 : 1) +
            (row.body_it === null || row.body_it === '' ? 0 : 1),
          0
        );
        const restoredPointers = rows.reduce(
          (total, row) =>
            total +
            (row.body_en_path === null ? 0 : 1) +
            (row.body_it_path === null ? 0 : 1),
          0
        );
        expect(restoredBodies).toBe(manifest.counts.bodies);
        expect(restoredPointers).toBe(manifest.counts.pointers);

        // Every restored value agrees with the artifact's own manifest record.
        for (const row of rows) {
          const record = manifest.rows.find(
            (candidate) =>
              candidate.kind === row.kind &&
              candidate.id === Number(row.post_id)
          );
          if (!record) {
            throw new Error(`no manifest row for ${row.kind}/${row.post_id}`);
          }
          expect(row.hidden).toBe(record.hidden);
          expect(row.body_en_sha256).toBe(record.en.bodySha256);
          expect(Number(row.body_en_bytes)).toBe(record.en.bodyBytes);
          expect(row.body_en_path).toBe(record.en.pointer);
          expect(row.body_it_sha256).toBe(record.it.bodySha256);
          expect(Number(row.body_it_bytes)).toBe(record.it.bodyBytes);
          expect(row.body_it_path).toBe(record.it.pointer);
        }
      } finally {
        await db.close();
      }

      // The baseline artifact is byte-for-byte what it was before the rehearsal.
      expect(await artifactSnapshot(reader)).toEqual(before);
      const verified = await verifyBackupArtifact(reader, {
        backupDir: REHEARSAL_DIR,
        now: Date.parse('2026-10-19T14:25:00.000Z'),
      });
      expect(verified.ok).toBe(true);
      expect(verified.problems).toEqual([]);
      expect(verified.counts.bodies).toBe(manifest.counts.bodies);
    });
  }
);

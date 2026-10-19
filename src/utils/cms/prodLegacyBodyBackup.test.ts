import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pointerHashFor } from '@/libs/cms/storage/backfillPlan';
import {
  type BodyContentKind,
  type BodyContentStorageApi,
  prepareBodyContent,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  ARTIFACT_FILE_MODE,
  assertBackupApplyAcknowledged,
  assertBackupOutDirAllowed,
  assertBackupRestoreAcknowledged,
  assertLegacyBodyBackupEnvAllowed,
  assertRestoreTargetAllowed,
  BACKUP_APPLY_ACK_ENV,
  BACKUP_APPLY_ACK_VALUE,
  BACKUP_BUCKET,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_PROJECT_REF,
  BACKUP_RESTORE_ACK_ENV,
  BACKUP_RESTORE_ACK_VALUE,
  type BackupManifest,
  type BackupReader,
  type BackupReport,
  type BackupRowPayload,
  type BackupWriter,
  backupRepositoriesForModule,
  buildBackupArtifact,
  buildRestorePlan,
  captureLegacyBodies,
  compactTimestamp,
  createLegacyBodyReader,
  DEFAULT_RESTORE_TABLE,
  LEGACY_BODY_BACKUP_COMMAND,
  LEGACY_BODY_EN_PLACEHOLDER,
  type LegacyBodyBackupCliDeps,
  type LegacyBodyBackupCliOutcome,
  type LegacyBodyRow,
  loadBackupManifest,
  MANIFEST_FILE,
  OBJECTS_DIR,
  parseLegacyBodyBackupArgs,
  parseRowsJsonl,
  parseSums,
  RESTORE_KEY_ENV,
  RESTORE_URL_ENV,
  type ReadOnlyLegacyBodyClient,
  type RestoreReport,
  ROWS_FILE,
  runDirectoryName,
  runLegacyBodyBackupCli,
  SUMS_FILE,
  type VerifyReport,
  verifyBackupArtifact,
} from '@/utils/cms/prodLegacyBodyBackup';

/**
 * Unit tests for the production legacy-body backup/restore command, against
 * injected fake row/object clients and an in-memory filesystem. Nothing here
 * touches a network, a project or a real file: every "wrote nothing" claim is
 * proved by the fake surfaces recording zero calls.
 */

const PROD_URL = `https://${BACKUP_PROJECT_REF}.supabase.co`;
const SCRATCH_URL = 'https://scratchprojectref123.supabase.co';
const SCRATCH_REF = 'scratchprojectref123';

const PROD_OBSERVED = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: PROD_URL,
  hasServerSecret: true,
};

const PROD_ENV: Record<string, string | undefined> = {
  APP_ENV: 'production',
  NEXT_PUBLIC_SUPABASE_DB_SCHEMA: 'public',
  [BACKUP_APPLY_ACK_ENV]: BACKUP_APPLY_ACK_VALUE,
  [BACKUP_RESTORE_ACK_ENV]: BACKUP_RESTORE_ACK_VALUE,
  [RESTORE_URL_ENV]: SCRATCH_URL,
  [RESTORE_KEY_ENV]: 'sb_secret_not-a-real-key',
};

const NO_REPOSITORIES: readonly string[] = [];
const REPOSITORIES = [
  '/tmp/workspace/okazakee-cms',
  '/tmp/workspace/okazakee-ws',
];
const RUN_DIRECTORY =
  '/tmp/backups/prod-legacy-bodies-2026-10-19T14-15-30-123Z-abcdef123456';
const BACKUP_DIR = '/tmp/backups/run';
const RESTORE_ARGS = ['--restore', `--backup-dir=${BACKUP_DIR}`];

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function postRow(
  kind: BodyContentKind,
  id: number,
  bodies: { en?: string | null; it?: string | null; hidden?: boolean | null },
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

type Fixture = {
  rows: Record<BodyContentKind, LegacyBodyRow[]>;
  objects: Record<string, Buffer>;
};

/** Two blog posts (one hidden) and one portfolio post, with their objects. */
function productionFixture(): Fixture {
  const objects: Record<string, Buffer> = {};
  const rows: Record<BodyContentKind, LegacyBodyRow[]> = {
    blog: [
      postRow(
        'blog',
        1,
        { en: '# One\n\nFirst body.\n', it: '# Uno\n\nPrimo corpo.\n' },
        objects
      ),
      postRow(
        'blog',
        2,
        { en: '# Two\n\nDraft body.\n', hidden: true },
        objects
      ),
    ],
    portfolio: [
      postRow(
        'portfolio',
        7,
        { en: '# Seven\n', it: null, hidden: false },
        objects
      ),
    ],
  };
  return { rows, objects };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type Upsert = {
  table: string;
  rows: Record<string, unknown>[];
  onConflict: string;
};

type Harness = {
  deps: LegacyBodyBackupCliDeps;
  files: Map<string, Buffer>;
  reader: BackupReader;
  objects: Record<string, Buffer>;
  downloads: string[];
  uploads: Array<{ path: string; bytes: Buffer; upsert: boolean }>;
  removes: string[];
  upserts: Upsert[];
  factories: string[];
  /** Throws when the artifact file is absent, like the real reader. */
  file(relativePath: string): Buffer;
  text(relativePath: string): string;
  /** The manifest, through the same validating loader the CLI uses. */
  manifest(): Promise<BackupManifest>;
  run(
    argv: string[],
    options?: RunOptions
  ): Promise<LegacyBodyBackupCliOutcome>;
};

type RunOptions = {
  env?: Record<string, string | undefined>;
  observed?: typeof PROD_OBSERVED;
};

function harness(options: {
  fixture?: Fixture;
  objectErrors?: Record<string, string>;
  upsertError?: string;
  uploadError?: string;
  repositories?: readonly string[];
  now?: number;
  runId?: string;
}): Harness {
  const fixture = options.fixture ?? productionFixture();
  const rows = fixture.rows;
  const objects = fixture.objects;
  const files = new Map<string, Buffer>();
  const downloads: string[] = [];
  const uploads: Array<{ path: string; bytes: Buffer; upsert: boolean }> = [];
  const removes: string[] = [];
  const upserts: Upsert[] = [];
  const factories: string[] = [];

  const storage: BodyContentStorageApi = {
    async upload(path, body, uploadOptions) {
      if (options.uploadError) {
        return { data: null, error: { message: options.uploadError } };
      }
      uploads.push({
        path,
        bytes: Buffer.from(body),
        upsert: uploadOptions.upsert,
      });
      objects[path] = Buffer.from(body);
      return { data: { path }, error: null };
    },
    async download(path) {
      downloads.push(path);
      const failure = options.objectErrors?.[path];
      if (failure) return { data: null, error: { message: failure } };
      const bytes = objects[path];
      if (!bytes) return { data: null, error: { message: 'Object not found' } };
      return { data: new Uint8Array(bytes), error: null };
    },
    async remove(paths) {
      removes.push(...paths);
      return { data: null, error: null };
    },
  };

  const reader: BackupReader = {
    async readFile(relativePath) {
      const bytes = files.get(relativePath);
      if (!bytes) throw new Error(`ENOENT: ${relativePath}`);
      return bytes;
    },
    async listFiles() {
      return [...files.keys()].sort();
    },
  };

  const deps: LegacyBodyBackupCliDeps = {
    argv: [],
    observed: PROD_OBSERVED,
    env: PROD_ENV,
    repositories: options.repositories ?? NO_REPOSITORIES,
    openRowReader() {
      factories.push('rowReader');
      return {
        async listLegacyBodies(kind) {
          return rows[kind] ?? [];
        },
      };
    },
    openObjects() {
      factories.push('objects');
      return storage;
    },
    openWriter(runDirectory) {
      factories.push(`writer:${runDirectory}`);
      const writer: BackupWriter = {
        async createRun() {
          // The real writer creates a fresh directory and never merges into an
          // existing one; the fake refuses the same way.
          if (files.size > 0) {
            throw new Error('EEXIST: the run directory already exists');
          }
        },
        async writeFile(relativePath, bytes) {
          if (files.has(relativePath)) {
            throw new Error(`${relativePath} already exists`);
          }
          files.set(relativePath, bytes);
        },
      };
      return writer;
    },
    openReader() {
      factories.push('reader');
      return reader;
    },
    openRestoreRows() {
      factories.push('restoreRows');
      return {
        from(table) {
          return {
            upsert(records, upsertOptions) {
              upserts.push({
                table,
                rows: records,
                onConflict: upsertOptions.onConflict,
              });
              return Promise.resolve({
                error: options.upsertError
                  ? { message: options.upsertError }
                  : null,
              });
            },
          };
        },
      };
    },
    openRestoreObjects() {
      factories.push('restoreObjects');
      return storage;
    },
    now: () => options.now ?? Date.parse('2026-10-19T14:15:30.123Z'),
    runId: () => options.runId ?? 'abcdef123456',
  };

  const file = (relativePath: string): Buffer => {
    const bytes = files.get(relativePath);
    if (!bytes) throw new Error(`no artifact file '${relativePath}'`);
    return bytes;
  };

  return {
    deps,
    files,
    reader,
    objects,
    downloads,
    uploads,
    removes,
    upserts,
    factories,
    file,
    text: (relativePath) => file(relativePath).toString('utf8'),
    manifest: async () => {
      const loaded = await loadBackupManifest(reader);
      if (!loaded.ok) throw new Error(loaded.error);
      return loaded.manifest;
    },
    run: (argv, runOptions) =>
      runLegacyBodyBackupCli({
        ...deps,
        argv,
        env: { ...PROD_ENV, ...(runOptions?.env ?? {}) },
        observed: runOptions?.observed ?? PROD_OBSERVED,
      }),
  };
}

function backupReportOf(outcome: LegacyBodyBackupCliOutcome): BackupReport {
  const report = outcome.report;
  if (!report) throw new Error('expected an export report, got none');
  if (report.mode !== 'dry-run' && report.mode !== 'apply') {
    throw new Error(`expected an export report, got '${report.mode}'`);
  }
  return report;
}

function verifyReportOf(outcome: LegacyBodyBackupCliOutcome): VerifyReport {
  const report = outcome.report;
  if (!report) throw new Error('expected a verify report, got none');
  if (report.mode !== 'verify') {
    throw new Error(`expected a verify report, got '${report.mode}'`);
  }
  return report;
}

function restoreReportOf(outcome: LegacyBodyBackupCliOutcome): RestoreReport {
  const report = outcome.report;
  if (!report) throw new Error('expected a restore report, got none');
  if (report.mode !== 'restore') {
    throw new Error(`expected a restore report, got '${report.mode}'`);
  }
  return report;
}

function findingCodes(outcome: LegacyBodyBackupCliOutcome): string[] {
  return backupReportOf(outcome).findings.map((finding) => finding.code);
}

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

describe('fail-closed gates', () => {
  it('refuses anything but an explicit APP_ENV=production', () => {
    for (const appEnv of [
      '',
      'development',
      'staging',
      'preview',
      'Production',
    ]) {
      expect(() =>
        assertLegacyBodyBackupEnvAllowed({ ...PROD_OBSERVED, appEnv })
      ).toThrow(/APP_ENV must be exactly 'production'/);
    }
  });

  it('refuses the dev schema, a foreign project and a missing secret', () => {
    expect(() =>
      assertLegacyBodyBackupEnvAllowed({
        ...PROD_OBSERVED,
        schema: 'dev_staging',
      })
    ).toThrow(/NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be 'public'/);
    expect(() =>
      assertLegacyBodyBackupEnvAllowed({
        ...PROD_OBSERVED,
        supabaseUrl: SCRATCH_URL,
      })
    ).toThrow(/project mismatch/);
    expect(() =>
      assertLegacyBodyBackupEnvAllowed({ ...PROD_OBSERVED, supabaseUrl: '' })
    ).toThrow(/missing NEXT_PUBLIC_SUPABASE_URL/);
    expect(() =>
      assertLegacyBodyBackupEnvAllowed({
        ...PROD_OBSERVED,
        supabaseUrl: 'nonsense',
      })
    ).toThrow(/not a usable/);
    expect(() =>
      assertLegacyBodyBackupEnvAllowed({
        ...PROD_OBSERVED,
        hasServerSecret: false,
      })
    ).toThrow(/missing SUPABASE_SECRET_KEY/);
    expect(() => assertLegacyBodyBackupEnvAllowed(PROD_OBSERVED)).not.toThrow();
  });

  it('needs the exact acknowledgement for an export write', () => {
    expect(() => assertBackupApplyAcknowledged(undefined)).toThrow(
      BACKUP_APPLY_ACK_ENV
    );
    expect(() => assertBackupApplyAcknowledged('yes')).toThrow(
      /refusing to write/
    );
    expect(() =>
      assertBackupApplyAcknowledged(BACKUP_APPLY_ACK_VALUE)
    ).not.toThrow();
  });

  it('needs its own acknowledgement for a restore write', () => {
    expect(() => assertBackupRestoreAcknowledged(undefined)).toThrow(
      BACKUP_RESTORE_ACK_ENV
    );
    expect(() =>
      assertBackupRestoreAcknowledged(BACKUP_APPLY_ACK_VALUE)
    ).toThrow(/refusing to restore/);
    expect(() =>
      assertBackupRestoreAcknowledged(BACKUP_RESTORE_ACK_VALUE)
    ).not.toThrow();
  });

  it('refuses an --out-dir inside either repository', () => {
    expect(() =>
      assertBackupOutDirAllowed('/tmp/backups', REPOSITORIES)
    ).not.toThrow();
    expect(() =>
      assertBackupOutDirAllowed('/tmp/backups', NO_REPOSITORIES)
    ).not.toThrow();
    expect(() =>
      assertBackupOutDirAllowed(
        '/tmp/workspace/okazakee-cms/backups',
        REPOSITORIES
      )
    ).toThrow(/outside both repositories/);
    expect(() =>
      assertBackupOutDirAllowed('/tmp/workspace/okazakee-ws', REPOSITORIES)
    ).toThrow(/outside both repositories/);
    expect(() =>
      assertBackupOutDirAllowed(
        '/tmp/workspace/okazakee-cms/../elsewhere',
        REPOSITORIES
      )
    ).not.toThrow();
    expect(() => assertBackupOutDirAllowed('/', REPOSITORIES)).toThrow(
      /outside both repositories/
    );
  });

  it('derives the two repositories from this module, not from a hard-coded path', () => {
    const repositories = backupRepositoriesForModule(import.meta.url);
    expect(repositories).toHaveLength(2);
    // `import.meta.url` of this test file lives in the CMS checkout, so the
    // first entry is its root and the second is the sibling WS checkout.
    expect(repositories[0].endsWith('okazakee-cms')).toBe(true);
    expect(repositories[1].endsWith('okazakee-ws')).toBe(true);
    expect(existsSync(join(repositories[0], 'package.json'))).toBe(true);
  });

  it('refuses a live production content table as a restore target', () => {
    const base = {
      url: PROD_URL,
      ref: BACKUP_PROJECT_REF,
      schema: 'public',
      table: 'blog_posts',
      bucket: null,
    };
    expect(() => assertRestoreTargetAllowed(base)).toThrow(
      /live content table/
    );
    expect(() =>
      assertRestoreTargetAllowed({ ...base, table: 'portfolio_posts' })
    ).toThrow(/live content table/);
    // A scratch table in the same project, or a scratch project, is allowed.
    expect(() =>
      assertRestoreTargetAllowed({ ...base, table: DEFAULT_RESTORE_TABLE })
    ).not.toThrow();
    expect(() =>
      assertRestoreTargetAllowed({
        ...base,
        ref: SCRATCH_REF,
        url: SCRATCH_URL,
      })
    ).not.toThrow();
    expect(() =>
      assertRestoreTargetAllowed({ ...base, url: '', ref: '' })
    ).toThrow(/is not configured/);
  });
});

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

describe('argument parsing', () => {
  it('is a read-only export when silent', () => {
    expect(parseLegacyBodyBackupArgs([])).toEqual({
      mode: 'export',
      outDir: null,
      apply: false,
      json: false,
    });
  });

  it('refuses an armed export without an --out-dir', () => {
    expect(parseLegacyBodyBackupArgs(['--apply'])).toEqual({
      mode: 'invalid',
      error:
        '--apply requires --out-dir=<dir>: the artifact must be written outside both repositories',
    });
  });

  it('refuses unknown, duplicated and misplaced arguments', () => {
    const errors = [
      ['--nope'],
      ['--out-dir=/tmp/a', '--out-dir=/tmp/b'],
      ['--apply', '--apply', '--out-dir=/tmp/a'],
      ['--verify', '--apply', '--backup-dir=/tmp/a'],
      ['--verify'],
      ['--verify', '--restore', '--backup-dir=/tmp/a'],
      ['--out-dir=/tmp/a', '--backup-dir=/tmp/b'],
      ['--restore-table=evil', '--out-dir=/tmp/a'],
      ['--verify', '--backup-dir=/tmp/a', '--restore-table=x'],
      ['--verify', '--restore-schema=public'],
      ['--verify', '--backup-dir=/tmp/a', '--restore-bucket=website-content'],
      ['--restore', '--backup-dir=/tmp/a', '--restore-table=bad name'],
      ['--restore', '--backup-dir=/tmp/a', '--restore-bucket=bad/bucket'],
      ['--out-dir='],
    ];
    for (const argv of errors) {
      expect(parseLegacyBodyBackupArgs(argv).mode).toBe('invalid');
    }
  });

  it('accepts the documented modes', () => {
    expect(parseLegacyBodyBackupArgs(['--out-dir=/tmp/a'])).toMatchObject({
      mode: 'export',
      apply: false,
    });
    expect(
      parseLegacyBodyBackupArgs(['--out-dir=/tmp/a', '--apply', '--json'])
    ).toMatchObject({ mode: 'export', apply: true, json: true });
    expect(
      parseLegacyBodyBackupArgs(['--verify', '--backup-dir=/tmp/a'])
    ).toEqual({
      mode: 'verify',
      backupDir: '/tmp/a',
      json: false,
    });
    expect(
      parseLegacyBodyBackupArgs([
        '--restore',
        '--backup-dir=/tmp/a',
        '--restore-schema=scratch',
        '--restore-table=legacy_restore',
        '--restore-bucket=scratch-content',
      ])
    ).toEqual({
      mode: 'restore',
      backupDir: '/tmp/a',
      apply: false,
      json: false,
      schema: 'scratch',
      table: 'legacy_restore',
      bucket: 'scratch-content',
    });
    expect(parseLegacyBodyBackupArgs(['--help'])).toEqual({ mode: 'help' });
  });

  it('names a run directory with a sortable timestamp and the run id', () => {
    const now = Date.parse('2026-10-19T14:15:30.123Z');
    expect(compactTimestamp(now)).toBe('2026-10-19T14-15-30-123Z');
    expect(runDirectoryName(now, 'abcdef123456')).toBe(
      'prod-legacy-bodies-2026-10-19T14-15-30-123Z-abcdef123456'
    );
    expect(ARTIFACT_FILE_MODE).toBe(0o600);
  });
});

/* -------------------------------------------------------------------------- */
/* Dry run                                                                     */
/* -------------------------------------------------------------------------- */

describe('export dry run', () => {
  it('reads production and writes nothing at all', async () => {
    const h = harness({});
    const outcome = await h.run(['--out-dir=/tmp/backups']);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    const report = backupReportOf(outcome);
    expect(report.mode).toBe('dry-run');
    expect(report.counts).toMatchObject({
      rows: 3,
      blog: 2,
      portfolio: 1,
      hidden: 1,
      visible: 2,
      bodies: 4,
      pointers: 4,
      objects: 4,
      objectsMissing: 0,
      errors: 0,
      warnings: 0,
    });
    expect(report.complete).toBe(true);
    expect(report.artifact).toBeNull();
    expect(report.runDirectory).toBe(RUN_DIRECTORY);

    // The only calls are reads, and no writer was ever built.
    expect(h.downloads).toHaveLength(4);
    expect(h.uploads).toHaveLength(0);
    expect(h.removes).toHaveLength(0);
    expect(h.upserts).toHaveLength(0);
    expect(h.files.size).toBe(0);
    expect(h.factories).toEqual(['rowReader', 'objects']);
    expect(outcome.lines.join('\n')).toContain('dry run');
  });

  it('shows no run directory when --out-dir is omitted', async () => {
    const h = harness({});
    const outcome = await h.run([]);
    expect(outcome.exitCode).toBe(0);
    expect(backupReportOf(outcome).runDirectory).toBeNull();
    expect(outcome.lines.join('\n')).toMatch(/pass --out-dir/);
  });

  it('refuses a refused environment before it builds any client', async () => {
    const h = harness({});
    const outcome = await h.run(['--out-dir=/tmp/backups'], {
      observed: { ...PROD_OBSERVED, appEnv: '' },
    });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.error).toMatch(/APP_ENV/);
    expect(h.factories).toEqual([]);
    expect(h.downloads).toHaveLength(0);
  });

  it('refuses an --out-dir inside a repository before it reads', async () => {
    const h = harness({ repositories: REPOSITORIES });
    const outcome = await h.run([
      '--out-dir=/tmp/workspace/okazakee-cms/backups',
    ]);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.error).toMatch(/outside both repositories/);
    expect(h.factories).toEqual([]);
  });

  it('refuses an armed export without the acknowledgement, before reading', async () => {
    const h = harness({});
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply'], {
      env: { [BACKUP_APPLY_ACK_ENV]: 'nope' },
    });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toMatch(
      new RegExp(`${BACKUP_APPLY_ACK_ENV}=${BACKUP_APPLY_ACK_VALUE}`)
    );
    expect(h.factories).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it('reports invalid usage with exit code 2', async () => {
    const h = harness({});
    const outcome = await h.run(['--apply']);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/requires --out-dir/);
    expect(h.factories).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Artifact                                                                    */
/* -------------------------------------------------------------------------- */

describe('export artifact', () => {
  it('writes a verifiable artifact whose manifest records every hash', async () => {
    const h = harness({});
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    expect(outcome.exitCode).toBe(0);
    const report = backupReportOf(outcome);
    expect(report.mode).toBe('apply');
    expect(report.artifact).not.toBeNull();
    expect(report.runDirectory).toBe(RUN_DIRECTORY);

    const manifest = await h.manifest();
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.version).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.command).toBe(LEGACY_BODY_BACKUP_COMMAND);
    expect(manifest.projectRef).toBe(BACKUP_PROJECT_REF);
    expect(manifest.bucket).toBe(BACKUP_BUCKET);
    expect(manifest.runId).toBe('abcdef123456');
    expect(manifest.runDirectory).toBe(RUN_DIRECTORY);
    expect(manifest.complete).toBe(true);
    expect(manifest.counts.rows).toBe(3);
    expect(manifest.counts.bodyBytes).toBe(manifest.counts.objectBytes);
    expect(manifest.rows).toHaveLength(3);

    // Every recorded body hash and length matches the payload file.
    const payloads = parseRowsJsonl(
      h.file(manifest.rowsFile),
      manifest.rowsFile
    );
    expect(payloads).toHaveLength(3);
    for (const row of manifest.rows) {
      const payload = payloads.find(
        (candidate) => candidate.kind === row.kind && candidate.id === row.id
      );
      if (!payload) throw new Error(`no payload row for ${row.kind}/${row.id}`);
      for (const locale of ['en', 'it'] as const) {
        const body = row[locale];
        const value = locale === 'en' ? payload.body_en : payload.body_it;
        expect(body.bodyNull).toBe(value === null);
        expect(body.bodyBytes).toBe(
          value === null ? 0 : Buffer.byteLength(value, 'utf8')
        );
        expect(body.bodySha256).toBe(
          value === null ? null : sha256Hex(Buffer.from(value, 'utf8'))
        );
        expect(body.objectMatchesBody).toBe(value === null ? null : true);
        expect(body.pointer).toBe(
          locale === 'en' ? payload.body_en_path : payload.body_it_path
        );
        if (body.pointer !== null) {
          expect(body.pointerHash).toBe(
            pointerHashFor(row.kind, row.id, locale, body.pointer)
          );
          expect(body.objectFile).toBe(`${OBJECTS_DIR}/${body.pointer}`);
        }
      }
    }

    // Every object was captured byte-for-byte under its canonical key.
    expect(manifest.objects).toHaveLength(4);
    for (const object of manifest.objects) {
      expect(object.captured).toBe(true);
      if (object.file === null) throw new Error('expected a recorded file');
      const bytes = h.file(object.file);
      expect(sha256Hex(bytes)).toBe(object.sha256);
      expect(bytes.length).toBe(object.bytes);
      expect(object.file).toBe(`${OBJECTS_DIR}/${object.path}`);
      // The hash in the key IS the hash of the bytes, by construction.
      expect(object.path).toContain(object.sha256 ?? '');
    }

    // SHA256SUMS pins every file, including the manifest itself.
    const sums = parseSums(h.text(SUMS_FILE));
    expect(sums.size).toBe(h.files.size - 1);
    expect(sums.get(MANIFEST_FILE)).toBe(sha256Hex(h.file(MANIFEST_FILE)));
    expect(sums.get(ROWS_FILE)).toBe(sha256Hex(h.file(ROWS_FILE)));
    for (const [path, sha256] of sums) {
      expect(sha256Hex(h.file(path))).toBe(sha256);
    }
    expect(report.artifact?.sumsSha256).toBe(sha256Hex(h.file(SUMS_FILE)));

    const verified = await verifyBackupArtifact(h.reader, {
      backupDir: BACKUP_DIR,
      now: 1_760_000_000_000,
    });
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.counts.bodies).toBe(6);
    expect(verified.counts.objects).toBe(4);
  });

  it('is immutable: an existing run directory is never reused', async () => {
    const h = harness({});
    h.files.set(ROWS_FILE, Buffer.from('tampered\n'));
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.error).toMatch(/already exists/);
    expect(h.text(ROWS_FILE)).toBe('tampered\n');
  });
});

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

describe('findings', () => {
  it('reports a body with no pointer and marks the artifact incomplete', async () => {
    const objects: Record<string, Buffer> = {};
    const fixture: Fixture = {
      rows: {
        blog: [
          postRow('blog', 1, { en: '# Pointed\n' }, objects),
          { ...postRow('blog', 2, {}, objects), body_en: '# Unpointed\n' },
        ],
        portfolio: [],
      },
      objects,
    };
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    expect(outcome.exitCode).toBe(1);
    const report = backupReportOf(outcome);
    expect(report.complete).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'body-without-pointer',
        severity: 'error',
        kind: 'blog',
        id: 2,
        locale: 'en',
      }),
    ]);
    // The unpointed body is still captured: it is a real value, and the
    // artifact records (and verifies) that it has no canonical object.
    const manifest = await h.manifest();
    expect(parseRowsJsonl(h.file(ROWS_FILE), ROWS_FILE)[1].body_en).toBe(
      '# Unpointed\n'
    );
    expect(manifest.rows[1].en.objectPath).toBeNull();
  });

  it('reports a referenced object Storage does not have, and records it', async () => {
    const fixture = productionFixture();
    const missing = fixture.rows.blog[1].body_en_path;
    if (missing === null) throw new Error('expected a pointer');
    delete fixture.objects[missing];
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    expect(outcome.exitCode).toBe(1);
    const manifest = await h.manifest();
    expect(manifest.complete).toBe(false);
    expect(manifest.findings).toEqual([
      expect.objectContaining({
        code: 'object-missing',
        severity: 'error',
        pointer: missing,
      }),
    ]);
    // Recorded as an explicit, uncaptured object rather than omitted.
    expect(
      manifest.objects.find((object) => object.path === missing)
    ).toMatchObject({ captured: false, sha256: null, bytes: null, file: null });
    expect(h.files.has(`${OBJECTS_DIR}/${missing}`)).toBe(false);
    expect(h.downloads).toHaveLength(4);
  });

  it('distinguishes an unreadable object from a missing one', async () => {
    const fixture = productionFixture();
    const broken = fixture.rows.blog[0].body_en_path;
    if (broken === null) throw new Error('expected a pointer');
    const h = harness({
      fixture,
      objectErrors: { [broken]: 'Internal server error' },
    });
    const outcome = await h.run(['--out-dir=/tmp/backups']);
    expect(outcome.exitCode).toBe(1);
    expect(findingCodes(outcome)).toEqual(['object-unreadable']);
  });

  it('reports a pointer that names another post', async () => {
    const fixture = productionFixture();
    const foreign = postRow('blog', 99, { en: '# Foreign\n' }, fixture.objects);
    fixture.rows.blog[0].body_it_path = foreign.body_en_path;
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    expect(outcome.exitCode).toBe(1);
    expect(findingCodes(outcome)).toEqual(['unaddressable-pointer']);
  });

  it('reports the shim placeholder as a failed baseline', async () => {
    const objects: Record<string, Buffer> = {};
    const fixture: Fixture = {
      rows: {
        blog: [
          {
            ...postRow('blog', 3, { en: '# Real body\n' }, objects),
            body_en: LEGACY_BODY_EN_PLACEHOLDER,
          },
        ],
        portfolio: [],
      },
      objects,
    };
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    expect(outcome.exitCode).toBe(1);
    const report = backupReportOf(outcome);
    expect(report.complete).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'legacy-body-placeholder',
        severity: 'error',
      }),
      expect.objectContaining({
        code: 'body-object-mismatch',
        severity: 'warning',
      }),
    ]);
  });

  it('warns when the legacy column and the object disagree', async () => {
    const fixture = productionFixture();
    fixture.rows.blog[0].body_en = '# Edited after the backfill\n';
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
    // A disagreement is recorded, not fatal: both copies are captured.
    expect(outcome.exitCode).toBe(0);
    const report = backupReportOf(outcome);
    expect(report.complete).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'body-object-mismatch',
        severity: 'warning',
      }),
    ]);
    const manifest = await h.manifest();
    expect(manifest.rows[0].en.objectMatchesBody).toBe(false);
  });

  it('reports a committed pointer with no legacy body left', async () => {
    const fixture = productionFixture();
    const prepared = prepareBodyContent(
      'portfolio',
      7,
      'it',
      '# Bodies differ\n'
    );
    fixture.objects[prepared.path] = prepared.bytes;
    fixture.rows.portfolio[0].body_it_path = prepared.path;
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups']);
    expect(outcome.exitCode).toBe(0);
    expect(findingCodes(outcome)).toEqual(['body-missing-with-pointer']);
  });

  it('reports unknown visibility instead of guessing it', async () => {
    const fixture = productionFixture();
    fixture.rows.blog[0].hidden = null;
    const h = harness({ fixture });
    const outcome = await h.run(['--out-dir=/tmp/backups']);
    const report = backupReportOf(outcome);
    expect(report.counts.hidden).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'visibility-unknown',
        severity: 'warning',
      }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* --verify                                                                    */
/* -------------------------------------------------------------------------- */

async function exportArtifact(): Promise<Harness> {
  const h = harness({});
  const outcome = await h.run(['--out-dir=/tmp/backups', '--apply']);
  expect(outcome.exitCode).toBe(0);
  return h;
}

describe('--verify', () => {
  it('passes on an untouched artifact and reports the hashes to retain', async () => {
    const h = await exportArtifact();
    const outcome = await h.run(['--verify', `--backup-dir=${BACKUP_DIR}`]);
    expect(outcome.exitCode).toBe(0);
    const report = verifyReportOf(outcome);
    expect(report.ok).toBe(true);
    expect(report.runId).toBe('abcdef123456');
    expect(report.sumsSha256).toBe(sha256Hex(h.file(SUMS_FILE)));
    expect(report.manifestSha256).toBe(sha256Hex(h.file(MANIFEST_FILE)));
    expect(outcome.lines.join('\n')).toContain(
      `sha256sums-sha256 ${report.sumsSha256 ?? ''}`
    );
  });

  it('detects a tampered object file', async () => {
    const h = await exportArtifact();
    const target = [...h.files.keys()].find((path) =>
      path.startsWith(`${OBJECTS_DIR}/blog/1/en/`)
    );
    if (!target) throw new Error('expected an exported object');
    h.files.set(target, Buffer.from('# tampered\n'));
    const outcome = await h.run(['--verify', `--backup-dir=${BACKUP_DIR}`]);
    expect(outcome.exitCode).toBe(1);
    const report = verifyReportOf(outcome);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      expect.objectContaining({ code: 'file-mismatch', path: target }),
    ]);
    expect(report.counts.filesMismatched).toBe(1);
    expect(outcome.lines.join('\n')).toContain('NOT verified');
  });

  it('detects a tampered row payload, per body', async () => {
    const h = await exportArtifact();
    const payloads = parseRowsJsonl(h.file(ROWS_FILE), ROWS_FILE);
    payloads[0].body_en = `${payloads[0].body_en}tampered`;
    h.files.set(
      ROWS_FILE,
      Buffer.from(payloads.map((row) => `${JSON.stringify(row)}\n`).join(''))
    );
    const outcome = await h.run(['--verify', `--backup-dir=${BACKUP_DIR}`]);
    expect(outcome.exitCode).toBe(1);
    const report = verifyReportOf(outcome);
    expect(report.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['file-mismatch', 'body-mismatch'])
    );
    expect(report.bodies.filter((body) => body.status !== 'ok')).toHaveLength(
      1
    );
  });

  it('detects a deleted file and an extra file', async () => {
    const h = await exportArtifact();
    const target = [...h.files.keys()].find((path) =>
      path.startsWith(OBJECTS_DIR)
    );
    if (!target) throw new Error('expected an exported object');
    h.files.delete(target);
    h.files.set('extra.md', Buffer.from('# not recorded\n'));
    const outcome = await h.run(['--verify', `--backup-dir=${BACKUP_DIR}`]);
    const report = verifyReportOf(outcome);
    expect(report.ok).toBe(false);
    expect(report.counts.filesMissing).toBe(1);
    expect(report.counts.filesUnexpected).toBe(1);
    expect(report.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['file-missing', 'file-unexpected'])
    );
  });

  it('detects a rewritten manifest', async () => {
    const h = await exportArtifact();
    const manifest = await h.manifest();
    manifest.rows = manifest.rows.slice(0, 2);
    h.files.set(MANIFEST_FILE, Buffer.from(`${JSON.stringify(manifest)}\n`));
    const outcome = await h.run(['--verify', `--backup-dir=${BACKUP_DIR}`]);
    expect(outcome.exitCode).toBe(1);
    expect(
      verifyReportOf(outcome).problems.map((problem) => problem.code)
    ).toEqual(expect.arrayContaining(['file-mismatch', 'rows-count-mismatch']));
  });

  it('reports a missing artifact instead of throwing', async () => {
    const h = harness({});
    const outcome = await h.run(['--verify', `--backup-dir=${BACKUP_DIR}`]);
    expect(outcome.exitCode).toBe(1);
    expect(
      verifyReportOf(outcome).problems.map((problem) => problem.code)
    ).toEqual(expect.arrayContaining(['manifest-unreadable', 'sums-missing']));
  });
});

/* -------------------------------------------------------------------------- */
/* --restore                                                                   */
/* -------------------------------------------------------------------------- */

describe('--restore', () => {
  it('stops before writing when the artifact does not verify', async () => {
    const h = await exportArtifact();
    h.files.set(ROWS_FILE, Buffer.from('{}\n'));
    const outcome = await h.run([...RESTORE_ARGS, '--apply']);
    expect(outcome.exitCode).toBe(1);
    const report = restoreReportOf(outcome);
    expect(report.ok).toBe(false);
    expect(report.blocked).toMatch(/failed verification/);
    expect(h.upserts).toHaveLength(0);
    expect(h.factories).not.toContain('restoreRows');
  });

  it('is a dry run by default: it verifies and plans, and writes nothing', async () => {
    const h = await exportArtifact();
    const outcome = await h.run(RESTORE_ARGS);
    expect(outcome.exitCode).toBe(0);
    const report = restoreReportOf(outcome);
    expect(report.apply).toBe(false);
    expect(report.counts.rowsPlanned).toBe(3);
    expect(report.counts.rowsRestored).toBe(0);
    expect(report.counts.upserts).toBe(0);
    expect(report.target?.ref).toBe(SCRATCH_REF);
    expect(report.target?.table).toBe(DEFAULT_RESTORE_TABLE);
    expect(h.upserts).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    expect(h.factories).not.toContain('restoreRows');
  });

  it('replays the rows into the scratch table when armed', async () => {
    const h = await exportArtifact();
    const outcome = await h.run([...RESTORE_ARGS, '--apply']);
    expect(outcome.exitCode).toBe(0);
    const report = restoreReportOf(outcome);
    expect(report.ok).toBe(true);
    expect(report.counts.rowsRestored).toBe(3);
    expect(report.counts.upserts).toBe(1);

    expect(h.upserts).toHaveLength(1);
    const upsert = h.upserts[0];
    expect(upsert.table).toBe(DEFAULT_RESTORE_TABLE);
    expect(upsert.onConflict).toBe('run_id,kind,post_id');

    const payloads = parseRowsJsonl(h.file(ROWS_FILE), ROWS_FILE);
    expect(upsert.rows).toHaveLength(3);
    for (const [index, record] of upsert.rows.entries()) {
      const payload: BackupRowPayload = payloads[index];
      expect(record.run_id).toBe('abcdef123456');
      expect(record.kind).toBe(payload.kind);
      expect(record.post_id).toBe(payload.id);
      expect(record.hidden).toBe(payload.hidden);
      expect(record.body_en).toBe(payload.body_en);
      expect(record.body_it).toBe(payload.body_it);
      expect(record.body_en_path).toBe(payload.body_en_path);
      expect(record.body_it_path).toBe(payload.body_it_path);
      expect(record.body_en_sha256).toBe(
        payload.body_en === null
          ? null
          : sha256Hex(Buffer.from(payload.body_en, 'utf8'))
      );
    }
  });

  it('restores object bytes immutably when a scratch bucket is named', async () => {
    const h = await exportArtifact();
    const outcome = await h.run([
      ...RESTORE_ARGS,
      '--restore-bucket=scratch-content',
      '--apply',
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(h.uploads).toHaveLength(4);
    for (const upload of h.uploads) {
      expect(upload.upsert).toBe(false);
      const hash = upload.path.slice(upload.path.lastIndexOf('/') + 1);
      expect(sha256Hex(upload.bytes)).toBe(hash.replace(/\.md$/, ''));
    }
    expect(restoreReportOf(outcome).counts.objectsRestored).toBe(4);
  });

  it('records a failed object upload instead of hiding it', async () => {
    const h = await exportArtifact();
    h.deps.openRestoreObjects = () => {
      h.factories.push('restoreObjects');
      return {
        async upload() {
          return { data: null, error: { message: 'bucket not found' } };
        },
        async download(path) {
          return { data: new Uint8Array(h.objects[path]), error: null };
        },
        async remove() {
          return { data: null, error: null };
        },
      };
    };
    const outcome = await h.run([
      ...RESTORE_ARGS,
      '--restore-bucket=scratch-content',
      '--apply',
    ]);
    expect(outcome.exitCode).toBe(1);
    const report = restoreReportOf(outcome);
    expect(report.counts.objectsRestored).toBe(0);
    expect(report.counts.failures).toBe(4);
    expect(report.failures[0]).toMatchObject({
      scope: 'objects',
      message: expect.stringContaining('bucket not found'),
    });
  });

  it('refuses an object restore the artifact cannot satisfy', async () => {
    const fixture = productionFixture();
    const missing = fixture.rows.blog[1].body_en_path;
    if (missing === null) throw new Error('expected a pointer');
    delete fixture.objects[missing];
    const h = harness({ fixture });
    await h.run(['--out-dir=/tmp/backups', '--apply']);
    const outcome = await h.run([
      ...RESTORE_ARGS,
      '--restore-bucket=scratch-content',
      '--apply',
    ]);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.error).toMatch(/never captured/);
    expect(h.uploads).toHaveLength(0);
    expect(h.factories).not.toContain('restoreObjects');
  });

  it('refuses a live content table on the production project', async () => {
    const h = await exportArtifact();
    const outcome = await h.run(
      [...RESTORE_ARGS, '--restore-table=blog_posts', '--apply'],
      { env: { [RESTORE_URL_ENV]: PROD_URL } }
    );
    expect(outcome.exitCode).toBe(3);
    expect(outcome.error).toMatch(/live content table/);
    expect(h.factories).not.toContain('restoreRows');
  });

  it('refuses a missing target and the production bucket', async () => {
    const h = await exportArtifact();

    const unconfigured = await h.run([...RESTORE_ARGS, '--apply'], {
      env: { [RESTORE_URL_ENV]: undefined },
    });
    expect(unconfigured.exitCode).toBe(3);
    expect(unconfigured.error).toMatch(new RegExp(RESTORE_URL_ENV));

    const noKey = await h.run([...RESTORE_ARGS, '--apply'], {
      env: { [RESTORE_KEY_ENV]: undefined },
    });
    expect(noKey.exitCode).toBe(3);
    expect(noKey.error).toMatch(new RegExp(RESTORE_KEY_ENV));

    const prodBucket = await h.run([
      ...RESTORE_ARGS,
      `--restore-bucket=${BACKUP_BUCKET}`,
      '--apply',
    ]);
    expect(prodBucket.exitCode).toBe(3);
    expect(prodBucket.error).toMatch(/production content bucket/);

    expect(h.factories).not.toContain('restoreRows');
  });

  it('needs the restore acknowledgement before it builds a client', async () => {
    const h = await exportArtifact();
    const outcome = await h.run([...RESTORE_ARGS, '--apply'], {
      env: { [BACKUP_RESTORE_ACK_ENV]: undefined },
    });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain(
      `${BACKUP_RESTORE_ACK_ENV}=${BACKUP_RESTORE_ACK_VALUE}`
    );
    expect(h.factories).not.toContain('restoreRows');
  });

  it('records a failed upsert instead of pretending it succeeded', async () => {
    const h = harness({ upsertError: 'permission denied for table' });
    await h.run(['--out-dir=/tmp/backups', '--apply']);
    const outcome = await h.run([...RESTORE_ARGS, '--apply']);
    expect(outcome.exitCode).toBe(1);
    const report = restoreReportOf(outcome);
    expect(report.ok).toBe(false);
    expect(report.counts.rowsRestored).toBe(0);
    expect(report.counts.failures).toBe(1);
    expect(report.failures[0]).toMatchObject({
      scope: 'rows',
      message: 'permission denied for table',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only row access                                                        */
/* -------------------------------------------------------------------------- */

describe('createLegacyBodyReader', () => {
  it('pages through the projection and validates every row', async () => {
    const pages: Array<{ from: number; to: number }> = [];
    const data = [
      {
        id: 1,
        hidden: false,
        body_en: 'a',
        body_it: null,
        body_en_path: null,
        body_it_path: null,
      },
      {
        id: 2,
        hidden: true,
        body_en: 'b',
        body_it: null,
        body_en_path: null,
        body_it_path: null,
      },
      {
        id: 3,
        hidden: false,
        body_en: 'c',
        body_it: null,
        body_en_path: null,
        body_it_path: null,
      },
    ];
    const client: ReadOnlyLegacyBodyClient = {
      from(table) {
        expect(table).toBe('blog_posts');
        return {
          select(columns) {
            expect(columns).toContain('hidden');
            expect(columns).toContain('body_en_path');
            return {
              order(column) {
                expect(column).toBe('id');
                return {
                  range(from, to) {
                    pages.push({ from, to });
                    return Promise.resolve({
                      data: data.slice(from, to + 1),
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      },
    };
    expect(
      await createLegacyBodyReader(client, { pageSize: 2 }).listLegacyBodies(
        'blog'
      )
    ).toHaveLength(3);
    expect(pages).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ]);
  });

  it('fails loudly on a malformed row and on a PostgREST error', async () => {
    const client = (result: {
      data: unknown[] | null;
      error: { message: string } | null;
    }): ReadOnlyLegacyBodyClient => ({
      from: () => ({
        select: () => ({
          order: () => ({
            range: () => Promise.resolve(result),
          }),
        }),
      }),
    });

    await expect(
      createLegacyBodyReader(
        client({ data: [{ id: 'x' }], error: null })
      ).listLegacyBodies('blog')
    ).rejects.toThrow(/unexpected id/);
    await expect(
      createLegacyBodyReader(
        client({ data: null, error: { message: 'permission denied' } })
      ).listLegacyBodies('blog')
    ).rejects.toThrow(/reading public\.blog_posts failed: permission denied/);
    await expect(
      createLegacyBodyReader(
        client({ data: [{ id: 1, body_en: 5 }], error: null })
      ).listLegacyBodies('blog')
    ).rejects.toThrow(/unexpected body_en type/);
  });
});

/* -------------------------------------------------------------------------- */
/* Lower-level pieces                                                          */
/* -------------------------------------------------------------------------- */

function fixtureObjectsApi(
  fixture: Fixture,
  override: Partial<BodyContentStorageApi> = {}
): BodyContentStorageApi {
  return {
    async upload() {
      return { data: null, error: null };
    },
    async remove() {
      return { data: null, error: null };
    },
    async download(path) {
      return { data: new Uint8Array(fixture.objects[path]), error: null };
    },
    ...override,
  };
}

describe('capture and artifact helpers', () => {
  it('captures pointers and bodies without mutating its inputs', async () => {
    const fixture = productionFixture();
    const snapshot = JSON.stringify(fixture.rows);
    const capture = await captureLegacyBodies({
      reader: {
        async listLegacyBodies(kind) {
          return fixture.rows[kind];
        },
      },
      objects: fixtureObjectsApi(fixture),
    });
    expect(JSON.stringify(fixture.rows)).toBe(snapshot);
    expect(capture.counts).toMatchObject({ rows: 3, bodies: 4, objects: 4 });
    expect(capture.findings).toEqual([]);
    const blog1 = capture.rows.find(
      (row) => row.kind === 'blog' && row.id === 1
    );
    expect(blog1?.en.pointerHash).toBe(
      pointerHashFor('blog', 1, 'en', blog1?.en.pointer ?? '')
    );
    expect(blog1?.it.bodyBytes).toBe(
      Buffer.byteLength('# Uno\n\nPrimo corpo.\n')
    );
  });

  it('refuses a duplicated row id', async () => {
    const fixture = productionFixture();
    const duplicated: Fixture = {
      rows: {
        ...fixture.rows,
        blog: [fixture.rows.blog[0], fixture.rows.blog[0]],
      },
      objects: fixture.objects,
    };
    await expect(
      captureLegacyBodies({
        reader: {
          async listLegacyBodies(kind) {
            return duplicated.rows[kind];
          },
        },
        objects: fixtureObjectsApi(duplicated),
      })
    ).rejects.toThrow(/returned twice/);
  });

  it('builds an artifact whose manifest matches its payload', async () => {
    const fixture = productionFixture();
    const capture = await captureLegacyBodies({
      reader: {
        async listLegacyBodies(kind) {
          return fixture.rows[kind];
        },
      },
      objects: fixtureObjectsApi(fixture),
    });
    const artifact = buildBackupArtifact(capture, {
      runId: 'run',
      runDirectory: '/tmp/x',
      generatedAt: '2026-10-19T14:15:30.123Z',
      appEnv: 'production',
      schema: 'public',
      projectRef: BACKUP_PROJECT_REF,
      bucket: BACKUP_BUCKET,
    });
    expect(parseRowsJsonl(artifact.rowsJsonl, ROWS_FILE)).toHaveLength(3);
    expect(artifact.manifest.rows).toHaveLength(3);
    expect(artifact.manifest.complete).toBe(true);
    expect(artifact.files).toHaveLength(5);
    expect(artifact.objectFiles).toHaveLength(4);
    expect(artifact.sumsBytes.toString('utf8')).toContain(
      `${sha256Hex(artifact.manifestBytes)}  ${MANIFEST_FILE}`
    );
  });

  it('loads a manifest, and reports a damaged one without throwing', async () => {
    const h = await exportArtifact();
    const loaded = await loadBackupManifest(h.reader);
    expect(loaded.ok).toBe(true);
    h.files.set(MANIFEST_FILE, Buffer.from('{"format":"other"}\n'));
    const broken = await loadBackupManifest(h.reader);
    expect(broken.ok).toBe(false);
    expect(broken.ok ? '' : broken.error).toContain('is not a');
    h.files.set(MANIFEST_FILE, Buffer.from('not json\n'));
    const unparseable = await loadBackupManifest(h.reader);
    expect(unparseable.ok).toBe(false);
    expect(unparseable.ok ? '' : unparseable.error).toContain('not valid JSON');
  });

  it('plans a restore from a manifest, keeping uncaptured objects visible', async () => {
    const fixture = productionFixture();
    const capture = await captureLegacyBodies({
      reader: {
        async listLegacyBodies(kind) {
          return fixture.rows[kind];
        },
      },
      objects: fixtureObjectsApi(fixture, {
        async download() {
          return { data: null, error: { message: 'Object not found' } };
        },
      }),
    });
    const artifact = buildBackupArtifact(capture, {
      runId: 'run',
      runDirectory: '/tmp/x',
      generatedAt: '2026-10-19T14:15:30.123Z',
      appEnv: 'production',
      schema: 'public',
      projectRef: BACKUP_PROJECT_REF,
      bucket: BACKUP_BUCKET,
    });
    const plan = buildRestorePlan(
      artifact.manifest,
      parseRowsJsonl(artifact.rowsJsonl, ROWS_FILE)
    );
    expect(plan.rows).toHaveLength(3);
    expect(plan.runId).toBe('run');
    expect(plan.objects).toHaveLength(0);
    expect(plan.uncaptured).toHaveLength(4);
    expect(artifact.manifest.complete).toBe(false);
  });
});

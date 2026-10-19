import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BodyContentKind,
  type BodyContentStorageApi,
  prepareBodyContent,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  ARTIFACT_FILE_MODE,
  assertBackupOutDirAllowed,
  type BackupReport,
  backupRepositoriesForModule,
  buildBackupArtifact,
  captureLegacyBodies,
  createFsBackupReader,
  createFsBackupWriter,
  type LegacyBodyBackupCliDeps,
  type LegacyBodyBackupCliOutcome,
  type LegacyBodyRow,
  MANIFEST_FILE,
  OBJECTS_DIR,
  ROWS_FILE,
  RUN_DIRECTORY_MODE,
  runLegacyBodyBackupCli,
  SUMS_FILE,
  verifyBackupArtifact,
  writeBackupArtifact,
} from '@/utils/cms/prodLegacyBodyBackup';

/**
 * Filesystem-level tests for the backup/restore command: real 0700/0600 modes,
 * real append-only immutability, real walk-up repository detection, and a real
 * export → verify → restore round trip through the CLI. Every temporary
 * directory lives outside the repositories, under the OS temp root.
 */

const directories: string[] = [];
/** The two real checkouts, derived exactly as the CLI derives them. */
const REPOSITORIES = backupRepositoriesForModule(import.meta.url);

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), `legacy-body-backup-${prefix}-`)
  );
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** One blog post and one portfolio post, with their canonical objects. */
async function captureFixture() {
  const objects: Record<string, Buffer> = {};
  const rows: LegacyBodyRow[] = [
    {
      id: 4,
      hidden: false,
      body_en: '# Filing\n\nBody.\n',
      body_it: null,
      body_en_path: null,
      body_it_path: null,
    },
    {
      id: 9,
      hidden: true,
      body_en: '# Archived\n',
      body_it: '# Archiviato\n',
      body_en_path: null,
      body_it_path: null,
    },
  ];
  for (const row of rows) {
    for (const locale of ['en', 'it'] as const) {
      const value = locale === 'en' ? row.body_en : row.body_it;
      if (value === null) continue;
      const prepared = prepareBodyContent('blog', row.id, locale, value);
      objects[prepared.path] = prepared.bytes;
      if (locale === 'en') row.body_en_path = prepared.path;
      if (locale === 'it') row.body_it_path = prepared.path;
    }
  }
  const storage: BodyContentStorageApi = {
    async download(path) {
      const bytes = objects[path];
      if (!bytes) return { data: null, error: { message: 'Object not found' } };
      return { data: new Uint8Array(bytes), error: null };
    },
    async upload() {
      return { data: null, error: null };
    },
    async remove() {
      return { data: null, error: null };
    },
  };
  const capture = await captureLegacyBodies({
    reader: {
      async listLegacyBodies(kind: BodyContentKind) {
        return kind === 'blog' ? rows : [];
      },
    },
    objects: storage,
  });
  return { capture, rows, objects };
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function freshRunDirectory(): Promise<string> {
  const root = await temporaryDirectory('out');
  const runDirectory = join(
    root,
    'prod-legacy-bodies-2026-10-19T14-15-30-123Z-abcdef123456'
  );
  return runDirectory;
}

async function fixtureArtifact(runDirectory: string, runId = 'abcdef123456') {
  const { capture } = await captureFixture();
  return buildBackupArtifact(capture, {
    runId,
    runDirectory,
    generatedAt: '2026-10-19T14:15:30.123Z',
    appEnv: 'production',
    schema: 'public',
    projectRef: 'mtvwynyikouqzmhqespl',
    bucket: 'website-content',
  });
}

async function writeFixtureArtifact(runDirectory: string) {
  const artifact = await fixtureArtifact(runDirectory);
  await writeBackupArtifact(createFsBackupWriter(runDirectory), artifact);
  return artifact;
}

/* -------------------------------------------------------------------------- */
/* Writer                                                                      */
/* -------------------------------------------------------------------------- */

describe('filesystem writer', () => {
  it('creates a 0700 run directory holding 0600 files', async () => {
    const runDirectory = await freshRunDirectory();
    const artifact = await writeFixtureArtifact(runDirectory);

    expect(await modeOf(runDirectory)).toBe(RUN_DIRECTORY_MODE);
    expect(await modeOf(join(runDirectory, MANIFEST_FILE))).toBe(
      ARTIFACT_FILE_MODE
    );
    expect(await modeOf(join(runDirectory, ROWS_FILE))).toBe(
      ARTIFACT_FILE_MODE
    );
    expect(await modeOf(join(runDirectory, SUMS_FILE))).toBe(
      ARTIFACT_FILE_MODE
    );
    expect(await modeOf(join(runDirectory, OBJECTS_DIR))).toBe(
      RUN_DIRECTORY_MODE
    );
    for (const object of artifact.objectFiles) {
      expect(await modeOf(join(runDirectory, object.file))).toBe(
        ARTIFACT_FILE_MODE
      );
    }
    expect(artifact.objectFiles).toHaveLength(3);
  });

  it('never merges into an existing run directory', async () => {
    const runDirectory = await freshRunDirectory();
    await writeFixtureArtifact(runDirectory);
    await expect(
      writeBackupArtifact(
        createFsBackupWriter(runDirectory),
        await fixtureArtifact(runDirectory, 'second')
      )
    ).rejects.toThrow(/EEXIST/);
    // The first artifact is untouched.
    expect(existsSync(join(runDirectory, MANIFEST_FILE))).toBe(true);
  });

  it('refuses to overwrite a file and refuses a path that escapes', async () => {
    const runDirectory = await freshRunDirectory();
    const writer = createFsBackupWriter(runDirectory);
    await writer.createRun();
    await writer.writeFile('rows.jsonl', Buffer.from('{"a":1}\n'));
    await expect(
      writer.writeFile('rows.jsonl', Buffer.from('{"a":2}\n'))
    ).rejects.toThrow(/EEXIST/);
    for (const relativePath of ['../escape', '/etc/passwd', 'a/../../b', '']) {
      await expect(
        writer.writeFile(relativePath, Buffer.from('x'))
      ).rejects.toThrow(/plain relative path/);
    }
    expect(existsSync(join(runDirectory, '..', 'escape'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Reader, probe and verification                                              */
/* -------------------------------------------------------------------------- */

describe('filesystem reader and repository boundary', () => {
  it('lists every file, recursively and sorted', async () => {
    const runDirectory = await freshRunDirectory();
    await writeFixtureArtifact(runDirectory);
    const reader = createFsBackupReader(runDirectory);
    const files = await reader.listFiles();
    expect(files).toContain(MANIFEST_FILE);
    expect(files).toContain(ROWS_FILE);
    expect(files).toContain(SUMS_FILE);
    expect(
      files.filter((path) => path.startsWith(`${OBJECTS_DIR}/`))
    ).toHaveLength(3);
    expect([...files].sort()).toEqual(files);
    expect(
      (await reader.readFile(SUMS_FILE)).toString('utf8').split('\n')[0]
    ).toMatch(/^[0-9a-f]{64} {2}/);
    await expect(reader.readFile('missing.json')).rejects.toThrow();
  });

  it('verifies a real artifact, and detects a real byte flip', async () => {
    const runDirectory = await freshRunDirectory();
    await writeFixtureArtifact(runDirectory);
    const reader = createFsBackupReader(runDirectory);

    const clean = await verifyBackupArtifact(reader, {
      backupDir: runDirectory,
      now: Date.parse('2026-10-19T14:20:00.000Z'),
    });
    expect(clean.problems).toEqual([]);
    expect(clean.ok).toBe(true);
    expect(clean.sumsSha256).toBe(sha256Hex(await reader.readFile(SUMS_FILE)));

    const target = (await reader.listFiles()).find((path) =>
      path.startsWith(`${OBJECTS_DIR}/`)
    );
    if (!target) throw new Error('expected an exported object');
    await chmod(join(runDirectory, target), 0o600);
    await writeFile(join(runDirectory, target), Buffer.from('# tampered\n'));

    const tampered = await verifyBackupArtifact(reader, {
      backupDir: runDirectory,
      now: Date.parse('2026-10-19T14:21:00.000Z'),
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.problems).toEqual([
      expect.objectContaining({ code: 'file-mismatch', path: target }),
    ]);
    expect(tampered.counts.filesMismatched).toBe(1);

    await rm(join(runDirectory, target));
    await mkdir(join(runDirectory, 'debris'), { recursive: true });
    await writeFile(join(runDirectory, 'debris', 'note.txt'), 'not recorded');
    const damaged = await verifyBackupArtifact(reader, {
      backupDir: runDirectory,
      now: Date.parse('2026-10-19T14:22:00.000Z'),
    });
    expect(damaged.counts.filesMissing).toBe(1);
    expect(damaged.counts.filesUnexpected).toBe(1);
  });

  it('keeps the artifact out of both real checkouts', async () => {
    const root = await temporaryDirectory('out');
    expect(assertBackupOutDirAllowed(root, REPOSITORIES)).toBeUndefined();
    for (const repository of REPOSITORIES) {
      expect(() =>
        assertBackupOutDirAllowed(join(repository, 'backups'), REPOSITORIES)
      ).toThrow(/outside both repositories/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end CLI on the real filesystem                                       */
/* -------------------------------------------------------------------------- */

function reportOf(outcome: LegacyBodyBackupCliOutcome): BackupReport {
  const report = outcome.report;
  if (!report) throw new Error('expected an export report, got none');
  if (report.mode !== 'dry-run' && report.mode !== 'apply') {
    throw new Error(`expected an export report, got '${report.mode}'`);
  }
  return report;
}

async function cliFixture(): Promise<{
  deps: LegacyBodyBackupCliDeps;
  root: string;
}> {
  const root = await temporaryDirectory('cli');
  const { rows, objects } = await captureFixture();
  const storage: BodyContentStorageApi = {
    async download(path) {
      const bytes = objects[path];
      if (!bytes) return { data: null, error: { message: 'Object not found' } };
      return { data: new Uint8Array(bytes), error: null };
    },
    async upload() {
      return { data: null, error: null };
    },
    async remove() {
      return { data: null, error: null };
    },
  };
  const upserts: number[] = [];
  return {
    root,
    deps: {
      argv: [],
      observed: {
        appEnv: 'production',
        schema: 'public',
        supabaseUrl: 'https://mtvwynyikouqzmhqespl.supabase.co',
        hasServerSecret: true,
      },
      env: {
        CMS_PROD_BACKUP_APPLY_ACK: 'yes-export-production-bodies',
        CMS_BACKUP_RESTORE_ACK: 'yes-restore-to-scratch-target',
        CMS_BACKUP_RESTORE_URL: 'https://scratchprojectref123.supabase.co',
        CMS_BACKUP_RESTORE_KEY: 'sb_secret_not-a-real-key',
      },
      repositories: REPOSITORIES,
      openRowReader: () => ({
        async listLegacyBodies(kind: BodyContentKind) {
          return kind === 'blog' ? rows : [];
        },
      }),
      openObjects: () => storage,
      openWriter: createFsBackupWriter,
      openReader: createFsBackupReader,
      openRestoreRows: () => ({
        from: () => ({
          upsert(records) {
            upserts.push(records.length);
            return Promise.resolve({ error: null });
          },
        }),
      }),
      openRestoreObjects: () => storage,
      now: () => Date.parse('2026-10-19T14:15:30.123Z'),
      runId: () => 'abcdef123456',
    },
  };
}

describe('cli on the real filesystem', () => {
  it('writes, verifies and restores an artifact end to end', async () => {
    const { deps, root } = await cliFixture();

    const exported = await runLegacyBodyBackupCli({
      ...deps,
      argv: [`--out-dir=${root}`, '--apply', '--storage-authoritative'],
    });
    expect(exported.exitCode).toBe(0);
    const report = reportOf(exported);
    expect(report.mode).toBe('apply');
    expect(report.kind).toBe('storage-authoritative');
    const runDirectory = report.runDirectory;
    if (runDirectory === null) throw new Error('expected a run directory');
    expect(runDirectory.startsWith(root)).toBe(true);
    expect(await modeOf(runDirectory)).toBe(RUN_DIRECTORY_MODE);
    expect(await modeOf(join(runDirectory, MANIFEST_FILE))).toBe(
      ARTIFACT_FILE_MODE
    );
    // The operator's out-of-band value is printed for retention.
    expect(exported.lines.join('\n')).toContain(
      `sha256sums-sha256 ${report.artifact?.sumsSha256 ?? ''}`
    );

    const dryRun = await runLegacyBodyBackupCli({
      ...deps,
      argv: [`--out-dir=${root}`],
    });
    expect(dryRun.exitCode).toBe(0);
    expect(reportOf(dryRun).mode).toBe('dry-run');
    expect(reportOf(dryRun).artifact).toBeNull();

    const verified = await runLegacyBodyBackupCli({
      ...deps,
      argv: ['--verify', `--backup-dir=${runDirectory}`],
    });
    expect(verified.exitCode).toBe(0);
    expect(verified.lines.join('\n')).toContain('verified:');

    const restored = await runLegacyBodyBackupCli({
      ...deps,
      argv: ['--restore', `--backup-dir=${runDirectory}`],
    });
    expect(restored.exitCode).toBe(0);
    expect(restored.report?.mode).toBe('restore');

    const armed = await runLegacyBodyBackupCli({
      ...deps,
      argv: ['--restore', `--backup-dir=${runDirectory}`, '--apply'],
    });
    expect(armed.exitCode).toBe(0);
    expect(armed.report?.mode).toBe('restore');

    // A tampered artifact cannot be restored through the same CLI path.
    await chmod(join(runDirectory, ROWS_FILE), 0o600);
    await writeFile(join(runDirectory, ROWS_FILE), '{"kind":"blog"}\n');
    const refused = await runLegacyBodyBackupCli({
      ...deps,
      argv: ['--restore', `--backup-dir=${runDirectory}`, '--apply'],
    });
    expect(refused.exitCode).toBe(1);
  });

  it('refuses to write an artifact into either repository', async () => {
    const { deps } = await cliFixture();
    for (const repository of REPOSITORIES) {
      const outDir = join(repository, 'prod-backups');
      const outcome = await runLegacyBodyBackupCli({
        ...deps,
        argv: [`--out-dir=${outDir}`, '--apply'],
      });
      expect(outcome.exitCode).toBe(3);
      expect(outcome.error).toMatch(/outside both repositories/);
      expect(existsSync(outDir)).toBe(false);
    }
  });
});

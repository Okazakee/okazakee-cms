import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BackfillExecutorDeps,
  type ExecutionManifest,
  executeBackfill,
  executionManifest,
  manifestDigest,
  planFromManifest,
  retryPendingRevalidations,
} from '@/libs/cms/storage/backfillApply';
import { PROD_BACKFILL_ENVIRONMENT } from '@/libs/cms/storage/backfillEnvironment';
import {
  auditJournal,
  createMemoryJournal,
  type JournalIntent,
  type JournalOutcome,
  type JournalRecord,
  journalEntryKey,
  pendingRevalidations,
  recordedManifest,
  selectResumeRun,
  unresolvedIntents,
} from '@/libs/cms/storage/backfillJournal';
import type { BackfillPlanEntry } from '@/libs/cms/storage/backfillPlan';
import type {
  BodyContentKind,
  BodyContentLocale,
} from '@/libs/cms/storage/bodyContent';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';
import { readPostBodies } from '@/libs/cms/storage/postBodyObjects';
import { runProdBackfillPlan } from '@/libs/cms/storage/prodBackfillPlan';
import {
  applyProdCasSql,
  type CasCallLog,
  createPgliteCas,
  createPglitePlanReader,
  createPgliteReaders,
  createRecordingInvalidation,
  createRecordingStorage,
  FIXTURE_SEED,
  type InvalidationCalls,
  openLegacyDatabase,
  readPointer,
  resetPointers,
  type StorageCalls,
  seedFixture,
  snapshotAll,
} from '@/testing/sql/prodBackfillPostgresFixture';

/**
 * Production backfill executor against a REAL Postgres (PGlite) carrying the
 * REVIEW-ONLY production CAS artifact, with Storage and signed invalidation
 * injected. It proves the migration contract end to end on the production
 * schema shape: `public.blog_posts` / `public.portfolio_posts`, the production
 * CAS function names, and the shared atomic guard deciding every switch.
 *
 * The rows are synthetic but shaped like the production baseline (6 blog + 11
 * portfolio rows, both locales populated) and carry a metadata column and a
 * visibility column, so "only the pointer column ever changes" and "hidden
 * content migrates exactly like visible content" are asserted against whole-row
 * snapshots rather than assumed.
 */

const PROD_OBSERVED = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: `https://${PROD_BACKFILL_ENVIRONMENT.projectRef}.supabase.co`,
  hasServerSecret: true,
};

const RUN_ID = 'run-1';
const NOW = () => new Date('2026-10-18T10:00:00.000Z');

/** Exact UTF-8 bytes of every non-empty fixture body (the source baseline). */
const FIXTURE_SOURCE_BYTES = FIXTURE_SEED.reduce(
  (total, row) =>
    total +
    Buffer.byteLength(row.bodyEn, 'utf8') +
    Buffer.byteLength(row.bodyIt, 'utf8'),
  0
);

function canonicalPath(
  kind: 'blog' | 'portfolio',
  postId: number,
  locale: 'en' | 'it',
  body: string
): string {
  return `${kind}/${postId}/${locale}/${sha256Hex(Buffer.from(body, 'utf8'))}.md`;
}

function seedRow(kind: 'blog' | 'portfolio', id: number) {
  const row = FIXTURE_SEED.find(
    (entry) => entry.kind === kind && entry.id === id
  );
  if (!row) throw new Error(`missing fixture row ${kind}:${id}`);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Pre-schema inventory on a database that really has no pointer columns       */
/* -------------------------------------------------------------------------- */

describe('production inventory before the pointer columns exist', () => {
  let legacy: PGlite;

  beforeAll(async () => {
    legacy = await openLegacyDatabase();
    await seedFixture(legacy);
  });

  afterAll(async () => {
    await legacy.close();
  });

  it('plans the baseline with the bodies-only projection and reports it', async () => {
    const { report, exitCode } = await runProdBackfillPlan({
      env: PROD_OBSERVED,
      reader: createPglitePlanReader(legacy, 'inventory'),
      mode: 'inventory',
      modeSource: 'flag',
    });

    // The projection never mentions a pointer column, so this read succeeded on
    // a schema where those columns genuinely do not exist.
    expect(report.baseline.pointerColumnsSelected).toBe(false);
    expect(report.baseline.projection).toBe(
      PROD_BACKFILL_ENVIRONMENT.projections.bodies
    );
    expect(report.baseline.blogRows).toBe(6);
    expect(report.baseline.portfolioRows).toBe(11);
    expect(report.baseline.posts).toBe(17);
    expect(report.baseline.nonemptyBodies).toBe(34);
    expect(report.baseline.totalSourceBytes).toBe(FIXTURE_SOURCE_BYTES);
    expect(report.digestKind).toBe('inventory-bodies-only');
    // No pointer exists yet, so nothing can conflict and every locale is work.
    expect(report.summary.byAction.UPLOAD_AND_POINT).toBe(34);
    expect(report.summary.byAction.ALREADY_CURRENT).toBe(0);
    expect(report.blockers).toEqual([]);
    expect(report.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('fails loudly when the pointer projection is asked of the same database', async () => {
    // The same read with the pointer-aware projection: a false
    // CMS_BODY_POINTER_COLUMNS assertion must fail, never plan blind.
    await expect(
      runProdBackfillPlan({
        env: PROD_OBSERVED,
        reader: createPglitePlanReader(legacy, 'manifest'),
        mode: 'manifest',
        modeSource: 'flag',
      })
    ).rejects.toThrow(/body_en_path/);
  });
});

/* -------------------------------------------------------------------------- */
/* Post-schema execution                                                       */
/* -------------------------------------------------------------------------- */

describe('production backfill execution', () => {
  let db: PGlite;
  let casCalls: CasCallLog;
  let cas: ReturnType<typeof createPgliteCas>['api'];
  let objects: Map<string, Buffer>;
  let storageCalls: StorageCalls;
  let invalidations: InvalidationCalls;
  let invalidationStatus: () => 'sent' | 'failed' | 'skipped';
  let readers: ReturnType<typeof createPgliteReaders>;
  let journal: ReturnType<typeof createMemoryJournal>;

  beforeAll(async () => {
    db = await openLegacyDatabase();
    await seedFixture(db);
    await applyProdCasSql(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetPointers(db);
    objects = new Map();
    storageCalls = { uploads: [], downloads: [], removes: [] };
    invalidations = [];
    invalidationStatus = () => 'sent';
    casCalls = [];
    cas = createPgliteCas(db, PROD_BACKFILL_ENVIRONMENT, casCalls).api;
    readers = createPgliteReaders(db);
    journal = createMemoryJournal(NOW);
  });

  /** The production manifest, read from the fixture database itself. */
  async function plan(): Promise<{
    planEntries: BackfillPlanEntry[];
    digest: string;
  }> {
    const { report } = await runProdBackfillPlan({
      env: PROD_OBSERVED,
      reader: createPglitePlanReader(db, 'manifest'),
      mode: 'manifest',
      modeSource: 'flag',
    });
    return { planEntries: report.manifest, digest: report.digest };
  }

  function deps(
    overrides: Partial<BackfillExecutorDeps> = {}
  ): BackfillExecutorDeps {
    return {
      storage: createRecordingStorage(objects, storageCalls),
      cas,
      readCommittedBody: readers.readCommittedBody,
      readCommittedPointer: readers.readCommittedPointer,
      invalidate: createRecordingInvalidation(invalidations, () =>
        invalidationStatus()
      ),
      journal,
      now: NOW,
      newRunId: () => RUN_ID,
      ...overrides,
    };
  }

  /** Records the immutable manifest exactly as the executor CLI does. */
  async function startRun(manifest: ExecutionManifest): Promise<void> {
    await journal.append({
      type: 'manifest',
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      entries: manifest.entries,
      at: NOW().toISOString(),
    });
  }

  async function records(): Promise<JournalRecord[]> {
    return (await journal.read()).records;
  }

  function recordsOf<T extends JournalRecord['type']>(
    all: JournalRecord[],
    type: T
  ): Extract<JournalRecord, { type: T }>[] {
    return all.filter(
      (record): record is Extract<JournalRecord, { type: T }> =>
        record.type === type
    );
  }

  /**
   * Migrates the whole baseline once and clears the call logs, so the next
   * assertion sees only what the scenario under test caused.
   */
  async function migrateFully(): Promise<BackfillPlanEntry[]> {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);
    const report = await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    expect(report.summary.failures).toBe(0);
    expect(report.summary.pointerSwitches).toBe(34);
    storageCalls = { uploads: [], downloads: [], removes: [] };
    invalidations = [];
    casCalls = [];
    return planEntries;
  }

  it('migrates a fully unmigrated production baseline, in order, once per post', async () => {
    const { planEntries, digest } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    expect(manifest.manifestDigest).toBe(digest);
    expect(manifest.entries).toHaveLength(34);
    await startRun(manifest);

    const report = await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });

    expect(report.summary.failures).toBe(0);
    expect(report.summary.pointerSwitches).toBe(34);
    expect(report.summary.uploadedObjects).toBe(34);
    expect(report.stopped).toBeNull();
    expect(report.remaining).toEqual([]);

    // Every committed pointer is the canonical key for its own body bytes.
    for (const entry of manifest.entries) {
      expect(
        await readPointer(
          db,
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        )
      ).toBe(entry.expectedPath);
    }
    // Every uploaded object is content-addressed by its own bytes.
    expect(objects.size).toBe(34);
    for (const [path, bytes] of objects) {
      expect(path).toContain(`/${sha256Hex(bytes)}.md`);
    }
    // ONE signed invalidation per post, after all its locales were committed.
    expect(invalidations).toHaveLength(17);
    expect(invalidations.every((call) => call.ids.length === 1)).toBe(true);
    // Nothing was ever deleted, and no object was overwritten (upsert:false).
    expect(storageCalls.removes).toEqual([]);

    const all = await records();
    expect(all[0].type).toBe('manifest');
    expect(recordsOf(all, 'intent')).toHaveLength(34);
    expect(recordsOf(all, 'outcome')).toHaveLength(34);
    expect(recordsOf(all, 'revalidation')).toHaveLength(34);
    const outcomes = recordsOf(all, 'outcome') as JournalOutcome[];
    expect(
      outcomes.every((record) => record.outcome === 'UPLOADED_AND_POINTED')
    ).toBe(true);
    expect(
      outcomes.every(
        (record) => record.pointerVerified && record.pointerSwitched
      )
    ).toBe(true);
  });

  it('reuses a clean plan and re-verifies a partially migrated production state', async () => {
    const { planEntries } = await plan();
    const target = planEntries[0];
    const body = seedRow(target.kind, target.postId).bodyEn;
    // Pretend an earlier run already committed this locale.
    await db.query(
      `update public.blog_posts set body_en_path = $2 where id = $1`,
      [target.postId, target.expectedPath]
    );
    objects.set(target.expectedPath as string, Buffer.from(body, 'utf8'));

    const { planEntries: second, digest } = await plan();
    expect(second[0].action).toBe('ALREADY_CURRENT');
    expect(digest).not.toBe(
      manifestDigest(planEntries.filter((e) => e.expectedPath !== null))
    );
    expect(
      second.filter((entry) => entry.action === 'UPLOAD_AND_POINT')
    ).toHaveLength(33);

    const manifest = executionManifest(RUN_ID, second);
    await startRun(manifest);
    const report = await executeBackfill(deps(), second, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });

    expect(report.summary.failures).toBe(0);
    expect(report.summary.pointerSwitches).toBe(33);
    expect(report.summary.uploadedObjects).toBe(33);
    // The already-current entry was verified (object downloaded) but never
    // re-uploaded and never re-pointed.
    expect(storageCalls.uploads).not.toContain(target.expectedPath);
    expect(storageCalls.downloads).toContain(target.expectedPath);
    expect(
      casCalls.filter(
        (call) =>
          call.args.p_kind === target.kind &&
          call.args.p_post_id === target.postId &&
          call.args.p_locale === target.locale
      )
    ).toEqual([]);
  });

  it('is a no-op on a fully migrated production state', async () => {
    await migrateFully();

    const second = await plan();
    expect(
      second.planEntries.every((entry) => entry.action === 'ALREADY_CURRENT')
    ).toBe(true);
    const secondManifest = executionManifest('run-2', second.planEntries);
    const report = await executeBackfill(deps(), second.planEntries, {
      runId: 'run-2',
      manifest: secondManifest,
      failFast: true,
    });

    expect(report.summary.failures).toBe(0);
    expect(report.summary.pointerSwitches).toBe(0);
    expect(report.summary.uploadedObjects).toBe(0);
    expect(storageCalls.uploads).toEqual([]);
    expect(invalidations).toEqual([]);
    expect(casCalls).toEqual([]);
  });

  it('stops before uploading when the body changed after planning', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);

    const target = planEntries[0];
    const edited = `${seedRow(target.kind, target.postId).bodyEn}\n\nedited after planning\n`;
    await db.query(`update public.blog_posts set body_en = $2 where id = $1`, [
      target.postId,
      edited,
    ]);

    const report = await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });

    expect(report.stopped?.outcome).toBe('CAS_STALE');
    expect(report.summary.failures).toBe(1);
    // Fail-fast: no later entry was started.
    expect(report.remaining).toHaveLength(33);
    expect(storageCalls.uploads).toEqual([]);
    expect(await readPointer(db, 'blog', target.postId, 'en')).toBeNull();
    // The refusal is durable: the intent is answered by a failed outcome, so a
    // later run retries it as a new attempt instead of trusting the journal.
    const all = await records();
    expect(recordsOf(all, 'intent')).toHaveLength(1);
    expect(recordsOf(all, 'outcome')).toHaveLength(1);
    expect(recordsOf(all, 'outcome')[0].outcome).toBe('CAS_STALE');
    expect(unresolvedIntents(all)).toEqual([]);
  });

  it('detects a body edit after a successful switch through the CMS read path', async () => {
    await migrateFully();

    const path = (await readPointer(db, 'blog', 1, 'en')) as string;
    await db.query(`update public.blog_posts set body_en = $2 where id = $1`, [
      1,
      '# Blog 1 EN rewritten by a legacy-only write\n',
    ]);

    // The pointer is untouched by the edit, so the read path refuses to serve
    // content that disagrees with the committed legacy body.
    await expect(
      readPostBodies(createRecordingStorage(objects, storageCalls), 'blog', 1, {
        en: { legacy: '# Blog 1 EN rewritten by a legacy-only write\n', path },
      })
    ).rejects.toThrow(/disagreement/);
    expect(await readPointer(db, 'blog', 1, 'en')).toBe(path);
  });

  it('re-migrates after a legacy-only CMS write cleared the pointer, keeping the old object', async () => {
    await migrateFully();

    const oldPath = (await readPointer(db, 'blog', 1, 'en')) as string;
    const newBody = '# Blog 1 EN v2\n\nrewritten\n';
    await db.query(
      `update public.blog_posts set body_en = $2, body_en_path = null where id = $1`,
      [1, newBody]
    );

    const second = await plan();
    const entry = second.planEntries.find(
      (candidate) =>
        candidate.kind === 'blog' &&
        candidate.postId === 1 &&
        candidate.locale === 'en'
    );
    expect(entry?.action).toBe('UPLOAD_AND_POINT');
    expect(entry?.expectedPath).toBe(canonicalPath('blog', 1, 'en', newBody));

    const secondManifest = executionManifest('run-2', second.planEntries);
    const report = await executeBackfill(deps(), second.planEntries, {
      runId: 'run-2',
      manifest: secondManifest,
      failFast: true,
    });

    expect(report.summary.failures).toBe(0);
    expect(await readPointer(db, 'blog', 1, 'en')).toBe(
      canonicalPath('blog', 1, 'en', newBody)
    );
    // The superseded immutable object is preserved, never cleaned up.
    expect(objects.has(oldPath)).toBe(true);
    expect(storageCalls.removes).toEqual([]);
  });

  it('ignores metadata-only edits: same manifest digest, same work', async () => {
    const before = await plan();
    await db.query(
      `update public.blog_posts set title_en = 'renamed', published = false where id = 8`
    );
    const after = await plan();

    expect(after.digest).toBe(before.digest);
    expect(
      after.planEntries.map((entry) => [entry.action, entry.expectedPath])
    ).toEqual(
      before.planEntries.map((entry) => [entry.action, entry.expectedPath])
    );
  });

  it('refuses to continue when a committed object vanished', async () => {
    const migrated = await migrateFully();
    objects.delete(migrated[0].expectedPath as string);

    const second = await plan();
    const manifest = executionManifest('run-2', second.planEntries);
    await startRun(manifest);
    const report = await executeBackfill(deps(), second.planEntries, {
      runId: 'run-2',
      manifest,
      failFast: true,
    });

    expect(report.entries[0].outcome).toBe('VERIFY_FAILED');
    expect(report.entries[0].detail).toMatch(/download|no data/i);
    expect(report.stopped?.outcome).toBe('VERIFY_FAILED');
    // A referenced object that vanished is never "repaired" by an upload, and
    // never deleted.
    expect(report.summary.uploadedObjects).toBe(0);
    expect(storageCalls.uploads).toEqual([]);
    expect(storageCalls.removes).toEqual([]);
  });

  it('refuses to continue when a committed object was replaced', async () => {
    const migrated = await migrateFully();
    const target = migrated[1];
    objects.set(
      target.expectedPath as string,
      Buffer.from('# tampered object\n', 'utf8')
    );

    const second = await plan();
    const manifest = executionManifest('run-2', second.planEntries);
    await startRun(manifest);
    const report = await executeBackfill(deps(), second.planEntries, {
      runId: 'run-2',
      manifest,
      failFast: true,
    });

    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    expect(report.entries[1].outcome).toBe('VERIFY_FAILED');
    expect(report.entries[1].detail).toMatch(/do not match/i);
    expect(report.stopped?.outcome).toBe('VERIFY_FAILED');
    expect(storageCalls.uploads).toEqual([]);
    expect(storageCalls.removes).toEqual([]);
    // The committed pointer is left exactly as the earlier run wrote it.
    expect(
      await readPointer(db, target.kind, target.postId, target.locale)
    ).toBe(target.expectedPath);
  });

  it('keeps every non-pointer column and every hidden body untouched', async () => {
    const before = await snapshotAll(db);
    const planEntries = await migrateFully();
    const after = await snapshotAll(db);

    for (const key of Object.keys(before)) {
      expect(after[key].body_en).toBe(before[key].body_en);
      expect(after[key].body_it).toBe(before[key].body_it);
      expect(after[key].title_en).toBe(before[key].title_en);
      expect(after[key].published).toBe(before[key].published);
    }
    // Hidden rows migrate exactly like visible ones: same work, same contract.
    const hidden = planEntries.filter(
      (entry) => entry.kind === 'blog' && [9, 18].includes(entry.postId)
    );
    expect(hidden).toHaveLength(4);
    for (const entry of hidden) {
      expect(await readPointer(db, 'blog', entry.postId, entry.locale)).toBe(
        entry.expectedPath
      );
      // Visibility is not encoded in the object path, so a hidden body is
      // protected by the private bucket and its RLS policy (verified by the
      // readiness probes), never by naming.
      expect(entry.expectedPath).not.toMatch(/hidden|draft|private/);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Journal identity, resume, and interruption recovery                     */
  /* ---------------------------------------------------------------------- */

  it('never completes an intent from another run, manifest or destination', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);

    const target = planEntries[0];
    const identity = {
      runId: RUN_ID,
      manifestDigest: manifest.manifestDigest,
      kind: target.kind,
      postId: target.postId,
      locale: target.locale,
      intendedPath: target.expectedPath as string,
    };
    await journal.append({
      type: 'intent',
      ...identity,
      attempt: 1,
      previousPath: null,
      sourceSha256: target.sourceSha256 ?? '',
      at: NOW().toISOString(),
    });

    // Same run/entry/locale but a DIFFERENT destination: a foreign identity.
    await journal.append({
      type: 'outcome',
      ...identity,
      intendedPath:
        'blog/1/en/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.md',
      attempt: 1,
      previousPath: null,
      sourceSha256: target.sourceSha256 ?? '',
      outcome: 'UPLOADED_AND_POINTED',
      upload: 'uploaded',
      cas: 'APPLIED',
      casReason: null,
      pointerVerified: true,
      pointerSwitched: true,
      objectCreatedByRun: true,
      revalidation: 'sent',
      detail: null,
      at: NOW().toISOString(),
    });

    const all = await records();
    expect(unresolvedIntents(all)).toHaveLength(1);
    // A resume may only continue under the run's own manifest digest.
    const audit = auditJournal(await journal.read());
    expect(selectResumeRun(audit, { manifestDigest: 'deadbeef' }).ok).toBe(
      false
    );
    expect(recordedManifest(all, 'run-does-not-exist').ok).toBe(false);
    expect(recordedManifest(all, RUN_ID).ok).toBe(true);
  });

  it('resumes a failed final entry as a new attempt without rewriting the manifest', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);

    const last = planEntries[planEntries.length - 1];
    storageCalls.failUpload = (path) =>
      path === last.expectedPath ? 'disk full' : null;

    const first = await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    expect(first.stopped?.outcome).toBe('UPLOAD_FAILED');
    expect(first.summary.failures).toBe(1);
    // Everything before the last entry is committed and preserved.
    const committed = planEntries.slice(0, -1);
    for (const entry of committed) {
      expect(
        await readPointer(
          db,
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        )
      ).toBe(entry.expectedPath);
    }
    expect(
      await readPointer(db, last.kind, last.postId, last.locale)
    ).toBeNull();

    // Explicit recovery: same run, same immutable manifest, re-verified from the
    // database and Storage.
    storageCalls.failUpload = undefined;
    const observed = await Promise.all(
      manifest.entries.map((entry) =>
        readers.readCommittedPointer(
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        )
      )
    );
    const workPlan = planFromManifest(
      { type: 'manifest', at: NOW().toISOString(), ...manifest },
      observed
    );
    const second = await executeBackfill(deps(), workPlan, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });

    expect(second.summary.failures).toBe(0);
    expect(await readPointer(db, last.kind, last.postId, last.locale)).toBe(
      last.expectedPath
    );

    const all = await records();
    // The manifest is written once and never rewritten.
    expect(recordsOf(all, 'manifest')).toHaveLength(1);
    expect(recordsOf(all, 'manifest')[0].manifestDigest).toBe(
      manifest.manifestDigest
    );
    // Both attempts of the failed entry survive as history.
    const lastKey = journalEntryKey({
      runId: RUN_ID,
      manifestDigest: manifest.manifestDigest,
      kind: last.kind,
      postId: last.postId,
      locale: last.locale,
      intendedPath: last.expectedPath as string,
    });
    const attempts = recordsOf(all, 'intent')
      .filter((record) => journalEntryKey(record) === lastKey)
      .map((record) => (record as JournalIntent).attempt);
    expect(attempts).toEqual([1, 2]);
    const lastOutcomes = recordsOf(all, 'outcome')
      .filter((record) => journalEntryKey(record) === lastKey)
      .map((record) => (record as JournalOutcome).attempt);
    expect(lastOutcomes).toEqual([1, 2]);
  });

  it('stops before any mutation when an interruption happens before the upload', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);
    const target = planEntries[0];
    storageCalls.failUpload = (path) =>
      path === target.expectedPath ? 'interrupted' : null;

    const report = await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    expect(report.stopped?.outcome).toBe('UPLOAD_FAILED');
    expect(objects.size).toBe(0);
    expect(await readPointer(db, 'blog', target.postId, 'en')).toBeNull();
    // The failure is recorded, so the retry is a new attempt (see the resume
    // test) rather than a re-run that trusts the journal.
    const all = await records();
    expect(recordsOf(all, 'intent')).toHaveLength(1);
    expect(recordsOf(all, 'outcome')[0].outcome).toBe('UPLOAD_FAILED');
    expect(unresolvedIntents(all)).toEqual([]);
  });

  it('recovers an interruption after the upload and before the CAS', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);
    const target = planEntries[0];

    let first = true;
    const interrupted: BackfillExecutorDeps['cas'] = {
      pointerCas: async (args) => {
        if (first) {
          first = false;
          throw new Error('process interrupted before the CAS');
        }
        return cas.pointerCas(args);
      },
      pointerRollback: (args) => cas.pointerRollback(args),
    };

    const report = await executeBackfill(
      deps({ cas: interrupted }),
      planEntries,
      {
        runId: RUN_ID,
        manifest,
        failFast: true,
      }
    );
    expect(report.entries[0].outcome).toBe('VERIFY_FAILED');
    // The object exists without a committed pointer: reported, never deleted.
    expect(objects.has(target.expectedPath as string)).toBe(true);
    expect(storageCalls.removes).toEqual([]);
    expect(await readPointer(db, 'blog', target.postId, 'en')).toBeNull();
    const all = await records();
    expect(recordsOf(all, 'intent')).toHaveLength(1);
    expect(recordsOf(all, 'outcome')[0].outcome).toBe('VERIFY_FAILED');
    expect(unresolvedIntents(all)).toEqual([]);

    // Recovery re-downloads the object, sees it is byte-identical, and only
    // then switches the pointer.
    const observed = await Promise.all(
      manifest.entries.map((entry) =>
        readers.readCommittedPointer(
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        )
      )
    );
    const recovery = await executeBackfill(
      deps(),
      planFromManifest(
        { type: 'manifest', at: NOW().toISOString(), ...manifest },
        observed
      ),
      { runId: RUN_ID, manifest, failFast: true }
    );
    expect(recovery.summary.failures).toBe(0);
    expect(await readPointer(db, 'blog', target.postId, 'en')).toBe(
      target.expectedPath
    );
  });

  it('recovers an interruption between the CAS and the durable outcome', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);
    const target = planEntries[0];

    let failOnce = true;
    const interruptedJournal = {
      ...journal,
      async append(record: JournalRecord) {
        if (record.type === 'outcome' && failOnce) {
          failOnce = false;
          throw new Error('process interrupted before the outcome was durable');
        }
        return journal.append(record);
      },
    };

    await expect(
      executeBackfill(deps({ journal: interruptedJournal }), planEntries, {
        runId: RUN_ID,
        manifest,
        failFast: true,
      })
    ).rejects.toThrow(/interrupted/);

    // Both locales of the interrupted post were switched before the outcome
    // record was written, so their intents are unanswered and the next run
    // re-verifies them from the database instead of trusting the journal.
    const afterInterruption = await records();
    expect(recordsOf(afterInterruption, 'manifest')).toHaveLength(1);
    expect(unresolvedIntents(afterInterruption)).toHaveLength(2);

    // Recovery: the entry is re-derived as already-current from the live
    // pointer, verified against Storage, and only then recorded.
    const observed = await Promise.all(
      manifest.entries.map((entry) =>
        readers.readCommittedPointer(
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        )
      )
    );
    const recoveryPlan = planFromManifest(
      { type: 'manifest', at: NOW().toISOString(), ...manifest },
      observed
    );
    expect(recoveryPlan[0].action).toBe('ALREADY_CURRENT');
    // Recovery only asserts what it already did: the two switched entries are
    // re-verified (downloaded) and never re-uploaded.
    storageCalls = { uploads: [], downloads: [], removes: [] };
    const recovery = await executeBackfill(deps(), recoveryPlan, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    expect(recovery.summary.failures).toBe(0);
    for (const entry of manifest.entries.slice(0, 2)) {
      expect(storageCalls.uploads).not.toContain(entry.expectedPath);
      expect(storageCalls.downloads).toContain(entry.expectedPath);
    }

    // The interrupted append never landed, so attempt 1 was never closed: the
    // recovery completes THAT attempt instead of inventing a second one, and
    // the manifest record is still the only one ever written.
    const all = await records();
    expect(recordsOf(all, 'manifest')).toHaveLength(1);
    expect(recordsOf(all, 'manifest')[0].manifestDigest).toBe(
      manifest.manifestDigest
    );
    const targetKey = journalEntryKey({
      runId: RUN_ID,
      manifestDigest: manifest.manifestDigest,
      kind: target.kind,
      postId: target.postId,
      locale: target.locale,
      intendedPath: target.expectedPath as string,
    });
    expect(
      recordsOf(all, 'outcome')
        .filter((record) => journalEntryKey(record) === targetKey)
        .map((record) => (record as JournalOutcome).attempt)
    ).toEqual([1]);
    expect(
      recordsOf(all, 'outcome')
        .filter((record) => journalEntryKey(record) === targetKey)
        .map((record) => (record as JournalOutcome).outcome)
    ).toEqual(['ALREADY_CURRENT']);
  });

  it('leaves a pending invalidation retryable and never re-uploads for it', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);
    invalidationStatus = () => 'failed';

    const report = await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    // The pointer switch is committed; only the signed invalidation is missing,
    // and fail-fast stops before starting the next post.
    expect(report.entries[0].outcome).toBe('REVALIDATION_FAILED');
    expect(report.entries[1].outcome).toBe('REVALIDATION_FAILED');
    expect(report.stopped).not.toBeNull();
    const pending = pendingRevalidations(await records());
    expect(pending).toHaveLength(2);
    expect(await readPointer(db, 'blog', 1, 'en')).not.toBeNull();

    const uploadsBefore = [...storageCalls.uploads];
    const casBefore = casCalls.length;
    invalidationStatus = () => 'sent';
    const retries = await retryPendingRevalidations(
      {
        readCommittedPointer: readers.readCommittedPointer,
        invalidate: deps().invalidate,
        journal,
        now: NOW,
      },
      pending
    );

    expect(retries.map((retry) => retry.outcome)).toEqual([
      'REVALIDATED',
      'REVALIDATED',
    ]);
    expect(pendingRevalidations(await records())).toEqual([]);
    // A retry only re-sends the signed event: no upload, no pointer write.
    expect(storageCalls.uploads).toEqual(uploadsBefore);
    expect(casCalls).toHaveLength(casBefore);
  });

  it('marks an invalidation as superseded when the row moved on', async () => {
    const { planEntries } = await plan();
    const manifest = executionManifest(RUN_ID, planEntries);
    await startRun(manifest);
    invalidationStatus = () => 'skipped';

    await executeBackfill(deps(), planEntries, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    const pending = pendingRevalidations(await records());
    expect(pending.every((entry) => entry.lastStatus === 'skipped')).toBe(true);

    // A legacy-only CMS write clears the pointer: whatever changed the row owns
    // its cache, so the retry records `superseded` instead of re-sending.
    await db.query(
      `update public.blog_posts set body_en = $2, body_en_path = null where id = $1`,
      [1, '# Blog 1 EN changed again\n']
    );
    const retries = await retryPendingRevalidations(
      {
        readCommittedPointer: readers.readCommittedPointer,
        invalidate: deps().invalidate,
        journal,
        now: NOW,
      },
      pending.filter((entry) => entry.postId === 1)
    );
    expect(retries.every((retry) => retry.outcome === 'SUPERSEDED')).toBe(true);
    expect(pendingRevalidations(await records())).toEqual([]);
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BackfillExecutorDeps,
  type ExecutionManifest,
  executeBackfill,
  executeRollback,
  executionManifest,
  planRollback,
  type RollbackDeps,
  retryRollbackRevalidations,
} from '@/libs/cms/storage/backfillApply';
import { PROD_BACKFILL_ENVIRONMENT } from '@/libs/cms/storage/backfillEnvironment';
import {
  createMemoryJournal,
  type JournalRecord,
  type JournalRollback,
  journalEntryKey,
  pendingRollbackRevalidations,
} from '@/libs/cms/storage/backfillJournal';
import { runProdBackfillPlan } from '@/libs/cms/storage/prodBackfillPlan';
import {
  applyProdCasSql,
  type CasCallLog,
  createPgliteCas,
  createPglitePlanReader,
  createPgliteReaders,
  createRecordingInvalidation,
  createRecordingStorage,
  type InvalidationCalls,
  openLegacyDatabase,
  readPointer,
  resetPointers,
  type StorageCalls,
  seedFixture,
  snapshotAll,
} from '@/testing/sql/prodBackfillPostgresFixture';

/**
 * Production rollback against a REAL Postgres (PGlite) carrying the reviewed
 * production CAS artifact: the guarded rollback CAS decides every restore, so
 * "the pointer moved on" and "the body changed" are enforced by the database,
 * not by the planner reading the row twice.
 *
 * The suite also proves the two absolutes of this path: legacy Markdown is
 * never written, and a Storage object is never removed.
 */

const PROD_OBSERVED = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: `https://${PROD_BACKFILL_ENVIRONMENT.projectRef}.supabase.co`,
  hasServerSecret: true,
};

const RUN_ID = 'run-1';
const NOW = () => new Date('2026-10-18T11:00:00.000Z');

describe('production backfill rollback', () => {
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

  function executorDeps(): BackfillExecutorDeps {
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
    };
  }

  function rollbackDeps(overrides: Partial<RollbackDeps> = {}): RollbackDeps {
    return {
      cas,
      readCommittedBody: readers.readCommittedBody,
      readCommittedPointer: readers.readCommittedPointer,
      invalidate: createRecordingInvalidation(invalidations, () =>
        invalidationStatus()
      ),
      journal,
      now: NOW,
      ...overrides,
    };
  }

  async function records(): Promise<JournalRecord[]> {
    return (await journal.read()).records;
  }

  function rollbackRecords(all: JournalRecord[]): JournalRollback[] {
    return all.filter(
      (record): record is JournalRollback => record.type === 'rollback'
    );
  }

  /** Runs the production migration once, then clears the logs. */
  async function migrateFully(): Promise<ExecutionManifest> {
    const { report } = await runProdBackfillPlan({
      env: PROD_OBSERVED,
      reader: createPglitePlanReader(db, 'manifest'),
      mode: 'manifest',
      modeSource: 'flag',
    });
    const manifest = executionManifest(RUN_ID, report.manifest);
    await journal.append({
      type: 'manifest',
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      entries: manifest.entries,
      at: NOW().toISOString(),
    });
    const run = await executeBackfill(executorDeps(), report.manifest, {
      runId: RUN_ID,
      manifest,
      failFast: true,
    });
    expect(run.summary.failures).toBe(0);
    expect(run.summary.pointerSwitches).toBe(34);
    storageCalls = { uploads: [], downloads: [], removes: [] };
    invalidations = [];
    casCalls = [];
    return manifest;
  }

  it('plans the rollback read-only, in reverse migration order', async () => {
    const manifest = await migrateFully();
    const before = await snapshotAll(db);

    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });

    expect(candidates).toHaveLength(34);
    expect(candidates.every((candidate) => candidate.state === 'READY')).toBe(
      true
    );
    // The last switch is rolled back first.
    const lastEntry = manifest.entries[manifest.entries.length - 1];
    expect(candidates[0].installedPath).toBe(lastEntry.expectedPath);
    expect(candidates[0].postId).toBe(lastEntry.postId);
    expect(candidates[33].installedPath).toBe(manifest.entries[0].expectedPath);
    expect(
      candidates.every((candidate) => candidate.previousPath === null)
    ).toBe(true);

    // Read-only: no CAS call, no invalidation, no upload, no row change.
    expect(casCalls).toEqual([]);
    expect(invalidations).toEqual([]);
    expect(storageCalls.uploads).toEqual([]);
    expect(await snapshotAll(db)).toEqual(before);
  });

  it('restores every pointer, invalidates once per post, and touches nothing else', async () => {
    const manifest = await migrateFully();
    const beforeRollback = await snapshotAll(db);
    const bodiesBefore = Object.fromEntries(
      Object.entries(beforeRollback).map(([key, row]) => [
        key,
        `${row.body_en}|${row.body_it}`,
      ])
    );

    const report = await executeRollback(
      rollbackDeps(),
      await planRollback(rollbackDeps(), { runId: RUN_ID })
    );

    expect(report.summary.planned).toBe(34);
    expect(report.summary.rolledBack).toBe(34);
    expect(report.summary.conflicts).toBe(0);
    expect(report.summary.failed).toBe(0);
    expect(report.incomplete).toBe(false);
    // Exactly one signed invalidation per post, after both locales.
    expect(invalidations).toHaveLength(17);

    const after = await snapshotAll(db);
    for (const key of Object.keys(after)) {
      expect(after[key].body_en_path).toBeNull();
      expect(after[key].body_it_path).toBeNull();
      expect(`${after[key].body_en}|${after[key].body_it}`).toBe(
        bodiesBefore[key]
      );
      expect(after[key].title_en).toBe(beforeRollback[key].title_en);
      expect(after[key].published).toBe(beforeRollback[key].published);
    }
    // No Storage cleanup, ever.
    expect(storageCalls.removes).toEqual([]);
    expect(storageCalls.uploads).toEqual([]);
    expect(objects.size).toBe(34);

    const all = await records();
    const rollbacks = rollbackRecords(all);
    expect(rollbacks).toHaveLength(34);
    expect(rollbacks.every((record) => record.outcome === 'ROLLED_BACK')).toBe(
      true
    );
    expect(rollbacks.every((record) => record.runId === RUN_ID)).toBe(true);
    expect(
      rollbacks.every(
        (record) => record.manifestDigest === manifest.manifestDigest
      )
    ).toBe(true);
    const rollbackInvalidations = all.filter(
      (record) =>
        record.type === 'revalidation' &&
        record.detail === 'rollback invalidation'
    );
    expect(rollbackInvalidations).toHaveLength(34);

    // Per-post invalidation happens only after EVERY locale of that post was
    // restored: the rollback invalidation records for blog 1 come after BOTH
    // rollback records for blog 1 (the migration's own invalidation records
    // precede them and are not what this ordering is about).
    const indicesOf = (predicate: (record: JournalRecord) => boolean) =>
      all
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => predicate(record))
        .map(({ index }) => index);
    const blogOneRollbacks = indicesOf(
      (record) =>
        record.type === 'rollback' &&
        record.kind === 'blog' &&
        record.postId === 1
    );
    const blogOneRollbackInvalidations = indicesOf(
      (record) =>
        record.type === 'revalidation' &&
        record.kind === 'blog' &&
        record.postId === 1 &&
        record.detail === 'rollback invalidation'
    );
    expect(blogOneRollbacks).toHaveLength(2);
    expect(blogOneRollbackInvalidations).toHaveLength(2);
    expect(Math.min(...blogOneRollbackInvalidations)).toBeGreaterThan(
      Math.max(...blogOneRollbacks)
    );
  });

  it('refuses to roll back after a conflicting CMS edit', async () => {
    await migrateFully();
    // The first candidate (reverse order) is the last migrated entry.
    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });
    const first = candidates[0];
    const table = first.kind === 'blog' ? 'blog_posts' : 'portfolio_posts';
    await db.query(
      `update public.${table} set body_${first.locale} = $2 where id = $1`,
      [first.postId, '# edited by the CMS after the migration\n']
    );

    const replanned = await planRollback(rollbackDeps(), { runId: RUN_ID });
    expect(replanned[0].state).toBe('BODY_CHANGED');
    expect(replanned[0].detail).toMatch(/changed after the migration/);

    const report = await executeRollback(rollbackDeps(), replanned);
    // Fail-fast: the conflicting first candidate stops the rollback before any
    // pointer is restored.
    expect(report.stopped?.state).toBe('BODY_CHANGED');
    expect(report.summary.rolledBack).toBe(0);
    expect(report.summary.conflicts).toBe(1);
    expect(invalidations).toEqual([]);
    expect(await readPointer(db, first.kind, first.postId, first.locale)).toBe(
      first.installedPath
    );
  });

  it('keeps the rollback partial and recorded when a conflict appears mid-run', async () => {
    await migrateFully();
    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });
    // Candidates run in reverse migration order, so index 5 is restored before
    // the conflicting candidate at index 6.
    const conflict = candidates[6];
    const table = conflict.kind === 'blog' ? 'blog_posts' : 'portfolio_posts';
    await db.query(
      `update public.${table} set body_${conflict.locale} = $2 where id = $1`,
      [conflict.postId, '# edited by the CMS after the migration\n']
    );

    const replanned = await planRollback(rollbackDeps(), { runId: RUN_ID });
    const report = await executeRollback(rollbackDeps(), replanned);

    expect(report.summary.rolledBack).toBe(6);
    expect(report.stopped?.state).toBe('BODY_CHANGED');
    expect(report.summary.conflicts).toBe(1);
    // The six restored entries keep their committed change and are invalidated
    // once per post (the last three posts, in reverse order).
    expect(invalidations).toHaveLength(3);
    expect(report.incomplete).toBe(false);
    const restored = rollbackRecords(await records()).filter(
      (record) => record.outcome === 'ROLLED_BACK'
    );
    expect(restored).toHaveLength(6);
    // The conflicting row keeps its migrated pointer.
    expect(
      await readPointer(db, conflict.kind, conflict.postId, conflict.locale)
    ).toBe(conflict.installedPath);
  });

  it('treats a legacy-only pointer clear and metadata edits as safe', async () => {
    await migrateFully();
    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });

    // A legacy-only CMS write already cleared one pointer back to NULL.
    const cleared = candidates[0];
    await db.query(
      `update public.${cleared.kind === 'blog' ? 'blog_posts' : 'portfolio_posts'}
         set body_${cleared.locale}_path = null where id = $1`,
      [cleared.postId]
    );
    // A metadata-only edit on another row is not a conflict.
    const renamed = candidates[1];
    await db.query(
      `update public.${renamed.kind === 'blog' ? 'blog_posts' : 'portfolio_posts'}
         set title_en = 'renamed during the rollback window', published = false where id = $1`,
      [renamed.postId]
    );

    const replanned = await planRollback(rollbackDeps(), { runId: RUN_ID });
    expect(replanned[0].state).toBe('ALREADY_ROLLED_BACK');
    expect(replanned[1].state).toBe('READY');

    const report = await executeRollback(rollbackDeps(), replanned);
    // An already-restored entry never stops the run and is never re-written.
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.rolledBack).toBe(33);
    expect(report.stopped).toBeNull();
    expect(report.summary.failed).toBe(0);
  });

  it('detects pointer drift instead of forcing a rollback', async () => {
    await migrateFully();
    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });
    const drifted = candidates[0];

    // Somebody else moved the pointer to a DIFFERENT canonical key (a new CMS
    // edit that dual-wrote its own object).
    const other = `${drifted.kind}/${drifted.postId}/${drifted.locale}/${'a'.repeat(64)}.md`;
    await db.query(
      `update public.${drifted.kind === 'blog' ? 'blog_posts' : 'portfolio_posts'}
         set body_${drifted.locale}_path = $2 where id = $1`,
      [drifted.postId, other]
    );

    const replanned = await planRollback(rollbackDeps(), { runId: RUN_ID });
    expect(replanned[0].state).toBe('POINTER_DRIFTED');
    expect(replanned[0].observedPointer).toBe(other);

    const report = await executeRollback(rollbackDeps(), replanned);
    expect(report.stopped?.state).toBe('POINTER_DRIFTED');
    expect(report.summary.rolledBack).toBe(0);
    expect(
      await readPointer(db, drifted.kind, drifted.postId, drifted.locale)
    ).toBe(other);
  });

  it('recovers an interrupted rollback without rewriting what it restored', async () => {
    await migrateFully();
    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });
    const interrupted = candidates[3];

    let interrupt = true;
    const interruptedCas: RollbackDeps['cas'] = {
      pointerCas: (args) => cas.pointerCas(args),
      pointerRollback: async (args) => {
        if (interrupt && args.installedPath === interrupted.installedPath) {
          interrupt = false;
          throw new Error('process interrupted during the rollback');
        }
        return cas.pointerRollback(args);
      },
    };

    await expect(
      executeRollback(rollbackDeps({ cas: interruptedCas }), candidates)
    ).rejects.toThrow(/interrupted/);

    // The three candidates before the interruption are restored and durable.
    for (const candidate of candidates.slice(0, 3)) {
      expect(
        await readPointer(
          db,
          candidate.kind,
          candidate.postId,
          candidate.locale
        )
      ).toBeNull();
    }
    expect(
      await readPointer(
        db,
        interrupted.kind,
        interrupted.postId,
        interrupted.locale
      )
    ).toBe(interrupted.installedPath);
    expect(rollbackRecords(await records())).toHaveLength(3);

    // Recovery: already-restored entries are classified, not re-written; the
    // rest completes; the earlier rollback records survive.
    const replanned = await planRollback(rollbackDeps(), { runId: RUN_ID });
    expect(
      replanned.filter((candidate) => candidate.state === 'ALREADY_ROLLED_BACK')
    ).toHaveLength(3);
    const report = await executeRollback(rollbackDeps(), replanned);
    expect(report.summary.rolledBack).toBe(31);
    expect(report.summary.skipped).toBe(3);
    expect(report.stopped).toBeNull();

    const all = await records();
    expect(rollbackRecords(all)).toHaveLength(34);
    expect((await snapshotAll(db))['blog:1'].body_en_path).toBeNull();
  });

  it('leaves a pending rollback invalidation retryable and order-aware', async () => {
    await migrateFully();
    const candidates = await planRollback(rollbackDeps(), { runId: RUN_ID });
    invalidations = [];
    invalidationStatus = () => 'failed';

    const report = await executeRollback(rollbackDeps(), candidates);
    // Every pointer is restored, but the public cache was not acknowledged.
    expect(report.summary.rolledBack).toBe(34);
    expect(report.incomplete).toBe(true);
    expect(report.revalidationPending).toHaveLength(17);

    const pending = pendingRollbackRevalidations(await records());
    expect(pending).toHaveLength(34);

    const rollbackRecordsBefore = rollbackRecords(await records()).length;
    invalidations = [];
    invalidationStatus = () => 'sent';
    const retries = await retryRollbackRevalidations(rollbackDeps(), pending);

    expect(retries.map((retry) => retry.outcome)).toEqual(
      Array.from({ length: 34 }, () => 'REVALIDATED')
    );
    // The retry only re-sends signed events: no upload, no pointer write, and
    // the original rollback records are untouched.
    expect(storageCalls.uploads).toEqual([]);
    expect(storageCalls.removes).toEqual([]);
    expect(rollbackRecords(await records())).toHaveLength(
      rollbackRecordsBefore
    );
    expect(pendingRollbackRevalidations(await records())).toEqual([]);
  });

  it('reports a superseded rollback invalidation when the row moved again', async () => {
    const manifest = await migrateFully();
    invalidationStatus = () => 'failed';
    await executeRollback(
      rollbackDeps(),
      await planRollback(rollbackDeps(), { runId: RUN_ID })
    );

    const all = await records();
    const pending = pendingRollbackRevalidations(all);
    expect(pending.length).toBeGreaterThan(0);
    const restored = rollbackRecords(all).find(
      (record) =>
        record.kind === 'blog' && record.postId === 1 && record.locale === 'en'
    );
    if (!restored) throw new Error('expected a rollback record for blog 1 EN');
    expect(restored.runId).toBe(RUN_ID);
    expect(restored.manifestDigest).toBe(manifest.manifestDigest);

    // The row moved again (a re-migration) before the invalidation retry, so
    // the cache is owned by whatever wrote the new pointer.
    await db.query(
      `update public.blog_posts set body_en_path = $2 where id = $1`,
      [1, restored.installedPath]
    );

    const retries = await retryRollbackRevalidations(
      rollbackDeps(),
      pending.filter((entry) => entry.kind === 'blog' && entry.postId === 1)
    );
    expect(retries).toHaveLength(2);
    expect(retries.every((retry) => retry.outcome === 'SUPERSEDED')).toBe(true);
    // Nothing was uploaded, removed or re-pointed by the retry.
    expect(storageCalls.uploads).toEqual([]);
    expect(storageCalls.removes).toEqual([]);
    expect(await readPointer(db, 'blog', 1, 'en')).toBe(restored.installedPath);
  });

  it('ignores execution records that belong to another run', async () => {
    await migrateFully();
    // A run id the journal has no manifest for: no candidates can be owned.
    const foreign = await planRollback(rollbackDeps(), {
      runId: 'a-different-run',
    });
    expect(foreign).toEqual([]);
    expect(casCalls).toEqual([]);
    expect(invalidations).toEqual([]);
  });

  it('keeps the journal key of a rollback distinct from its migration outcome', async () => {
    const manifest = await migrateFully();
    await executeRollback(
      rollbackDeps(),
      await planRollback(rollbackDeps(), { runId: RUN_ID })
    );
    const all = await records();
    for (const record of rollbackRecords(all)) {
      const key = journalEntryKey(record);
      expect(key).toBe(
        [
          RUN_ID,
          manifest.manifestDigest,
          record.kind,
          record.postId,
          record.locale,
          record.installedPath,
        ].join('|')
      );
    }
  });
});

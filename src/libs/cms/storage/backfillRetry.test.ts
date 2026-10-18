import { describe, expect, it } from 'vitest';
import type { BodyContentStorageApi } from '@/libs/cms/storage/bodyContent';
import { planEntry, type BackfillPlanEntry } from '@/libs/cms/storage/backfillPlan';
import {
  executeBackfill,
  executionManifest,
  planFromManifest,
  type BackfillExecutorDeps,
} from '@/libs/cms/storage/backfillApply';
import {
  auditJournal,
  createMemoryJournal,
  detectConflicts,
  recordedManifest,
  selectResumeRun,
  type BackfillJournal,
  type JournalRecord,
} from '@/libs/cms/storage/backfillJournal';

/**
 * Phase 12 checkpoint 1: recovery after a durably recorded failure.
 *
 * A failed entry must be retryable, the successful retry must be recordable
 * without a conflicting identity, the failed attempt must stay auditable, the
 * already-completed entries must not be uploaded or repointed again, a failed
 * FINAL entry must keep the run unfinished, later entries must not run before
 * recovery succeeds, and nothing retries automatically.
 */

const BODIES = ['# one\n', '# two\n', '# three\n', '# four\n', '# five\n'];

type State = {
  bodies: Map<string, string | null>;
  pointers: Map<string, string | null>;
  objects: Map<string, Buffer>;
  writes: Map<string, number>;
};

function harness(
  journal: BackfillJournal,
  state: State,
  options: {
    failUploadFor?: (path: string) => boolean;
    invalidate?: 'sent' | 'failed';
  } = {}
) {
  const uploads: string[] = [];
  const casCalls: number[] = [];
  const invalidations: Array<{ entity: string; ids: number[] }> = [];

  const storage: BodyContentStorageApi = {
    async upload(path, body) {
      uploads.push(path);
      if (options.failUploadFor?.(path)) {
        return { data: null, error: { message: 'upload exploded' } };
      }
      state.writes.set(path, (state.writes.get(path) ?? 0) + 1);
      state.objects.set(path, Buffer.from(body as Buffer));
      return { data: { path }, error: null };
    },
    async download(path) {
      const found = state.objects.get(path);
      return found ? { data: found, error: null } : { data: null, error: { message: 'missing' } };
    },
    async remove() {
      return { data: null, error: null };
    },
  };

  const deps: BackfillExecutorDeps = {
    storage,
    cas: {
      async pointerCas(args) {
        casCalls.push(args.postId);
        const key = `${args.kind}:${args.postId}:${args.locale}`;
        const current = state.pointers.get(key) ?? null;
        if (current === args.newPath) return { outcome: 'ALREADY_CURRENT', reason: null };
        if (current !== args.expectedPrevious) {
          return { outcome: 'STALE', reason: 'pointer_drift' };
        }
        state.pointers.set(key, args.newPath);
        return { outcome: 'APPLIED', reason: null };
      },
      async pointerRollback() {
        return { outcome: 'ROLLED_BACK', reason: null };
      },
    },
    readCommittedBody: async (kind, postId, locale) =>
      state.bodies.get(`${kind}:${postId}:${locale}`) ?? null,
    readCommittedPointer: async (kind, postId, locale) =>
      state.pointers.get(`${kind}:${postId}:${locale}`) ?? null,
    invalidate: async (args) => {
      invalidations.push({ entity: args.entity, ids: args.ids });
      return options.invalidate ?? 'sent';
    },
    journal,
    now: () => new Date('2026-10-18T10:00:00.000Z'),
    newRunId: () => 'run-retry',
  };

  return { deps, uploads, casCalls, invalidations };
}

function fiveEntryPlan(): BackfillPlanEntry[] {
  return BODIES.map((body, index) => planEntry('blog', index + 1, 'en', body, null));
}

function seedBodies(state: State): void {
  for (const [index, body] of BODIES.entries()) {
    state.bodies.set(`blog:${index + 1}:en`, body);
  }
}

async function startRun(journal: BackfillJournal, work: BackfillPlanEntry[], runId = 'run-retry') {
  const manifest = executionManifest(runId, work);
  await journal.append({
    type: 'manifest',
    runId: manifest.runId,
    manifestDigest: manifest.manifestDigest,
    entries: manifest.entries,
    at: '2026-10-18T10:00:00.000Z',
  });
  return manifest;
}

function outcomesFor(records: JournalRecord[], postId: number) {
  return records.filter(
    (record) => record.type === 'outcome' && record.postId === postId
  );
}

describe('checkpoint 1: retry after a durably recorded failure', () => {
  it('retries a failed middle entry as a new attempt without conflicting identities', async () => {
    const journal = createMemoryJournal();
    const work = fiveEntryPlan();
    const manifest = await startRun(journal, work);
    const state: State = {
      bodies: new Map(),
      pointers: new Map(),
      objects: new Map(),
      writes: new Map(),
    };
    seedBodies(state);

    // ── run 1: entries 1-2 succeed, entry 3 fails, nothing after it runs ────
    const first = harness(journal, state, { failUploadFor: (path) => path === work[2].expectedPath });
    const failedRun = await executeBackfill(first.deps, work, {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });

    expect(failedRun.entries.map((entry) => entry.outcome)).toEqual([
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOAD_FAILED',
    ]);
    expect(failedRun.stopped).toMatchObject({ postId: 3, outcome: 'UPLOAD_FAILED' });
    expect(failedRun.remaining.map((entry) => entry.postId)).toEqual([4, 5]);
    // No automatic retry inside the same invocation: three upload attempts only.
    expect(first.uploads).toHaveLength(3);
    expect(outcomesFor((await journal.read()).records, 3)).toHaveLength(1);

    const afterFailure = await journal.read();
    const failure = outcomesFor(afterFailure.records, 3)[0];
    expect(failure).toMatchObject({
      type: 'outcome',
      attempt: 1,
      outcome: 'UPLOAD_FAILED',
      pointerVerified: false,
    });

    // The failure keeps the run unfinished, including at the entry level.
    const failedAudit = auditJournal(afterFailure);
    const failedSummary = failedAudit.runs[0];
    expect(failedSummary.entriesTotal).toBe(5);
    expect(failedSummary.entriesSucceeded).toBe(2);
    expect(failedSummary.entriesFailed).toBe(1);
    expect(failedSummary.entriesMissing).toBe(2);
    expect(selectResumeRun(failedAudit, {}).ok).toBe(true);
    expect(failedAudit.trustworthy).toBe(true);
    expect(detectConflicts(afterFailure.records)).toEqual([]);

    // ── the cause is fixed; the same run resumes from its original manifest ─
    const lookup = recordedManifest(afterFailure.records, manifest.runId);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const observed = lookup.manifest.entries.map(
      (entry) => state.pointers.get(`${entry.kind}:${entry.postId}:${entry.locale}`) ?? null
    );
    const resumedWork = planFromManifest(lookup.manifest, observed);
    expect(resumedWork.map((entry) => entry.action)).toEqual([
      'ALREADY_CURRENT',
      'ALREADY_CURRENT',
      'UPLOAD_AND_POINT',
      'UPLOAD_AND_POINT',
      'UPLOAD_AND_POINT',
    ]);

    const writesBefore = new Map(state.writes);
    const second = harness(journal, state);
    const resumed = await executeBackfill(second.deps, resumedWork, {
      runId: lookup.manifest.runId,
      manifest: {
        runId: lookup.manifest.runId,
        manifestDigest: lookup.manifest.manifestDigest,
        entries: lookup.manifest.entries,
      },
      failFast: true,
    });

    // Every entry is now successful; the retried one is attempt 2.
    expect(resumed.entries.map((entry) => entry.outcome)).toEqual([
      'ALREADY_CURRENT',
      'ALREADY_CURRENT',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
    ]);
    expect(resumed.entries[2].attempt).toBe(2);
    expect(resumed.summary.failures).toBe(0);
    expect(resumed.stopped).toBeNull();
    expect(resumed.remaining).toEqual([]);

    // Completed entries were neither uploaded nor repointed again.
    expect(second.uploads).toEqual([
      work[2].expectedPath,
      work[3].expectedPath,
      work[4].expectedPath,
    ]);
    expect(second.casCalls).toEqual([3, 4, 5]);
    for (const entry of work.slice(0, 2)) {
      expect(state.writes.get(entry.expectedPath as string) ?? 0).toBe(
        writesBefore.get(entry.expectedPath as string) ?? 0
      );
      expect(outcomesFor((await journal.read()).records, entry.postId)).toHaveLength(1);
    }

    const finalRecords = (await journal.read()).records;
    // The failed attempt is preserved and the retry is a distinct attempt.
    const entryThree = outcomesFor(finalRecords, 3);
    expect(entryThree.map((record) => (record.type === 'outcome' ? record.attempt : 0))).toEqual([
      1, 2,
    ]);
    expect(entryThree.map((record) => (record.type === 'outcome' ? record.outcome : ''))).toEqual([
      'UPLOAD_FAILED',
      'UPLOADED_AND_POINTED',
    ]);
    // No conflicting identities were created, and the run is now complete.
    expect(detectConflicts(finalRecords)).toEqual([]);
    const finalAudit = auditJournal({ records: finalRecords, tornTail: false, malformedLines: 0 });
    expect(finalAudit.trustworthy).toBe(true);
    expect(finalAudit.runs[0]).toMatchObject({
      entriesTotal: 5,
      entriesSucceeded: 5,
      entriesFailed: 0,
      entriesMissing: 0,
    });
    expect(selectResumeRun(finalAudit, {}).ok).toBe(false);
  });

  it('keeps the run unfinished when the FAILED entry is the last one', async () => {
    const journal = createMemoryJournal();
    const work = fiveEntryPlan();
    const manifest = await startRun(journal, work);
    const state: State = {
      bodies: new Map(),
      pointers: new Map(),
      objects: new Map(),
      writes: new Map(),
    };
    seedBodies(state);

    const first = harness(journal, state, { failUploadFor: (path) => path === work[4].expectedPath });
    const failedRun = await executeBackfill(first.deps, work, {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });

    expect(failedRun.entries.map((entry) => entry.outcome)).toEqual([
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOAD_FAILED',
    ]);
    expect(failedRun.stopped).toMatchObject({ postId: 5 });
    expect(failedRun.remaining).toEqual([]);

    // Everything else landed, but the run must NOT look finished.
    const failedAudit = auditJournal(await journal.read());
    expect(failedAudit.runs[0]).toMatchObject({
      entriesTotal: 5,
      entriesSucceeded: 4,
      entriesFailed: 1,
      entriesMissing: 0,
    });
    const selection = selectResumeRun(failedAudit, {});
    expect(selection.ok).toBe(true);
    expect(failedAudit.trustworthy).toBe(true);

    // Recovered on a later invocation.
    const lookup = recordedManifest((await journal.read()).records, manifest.runId);
    if (!lookup.ok) throw new Error('manifest missing');
    const observed = lookup.manifest.entries.map(
      (entry) => state.pointers.get(`${entry.kind}:${entry.postId}:${entry.locale}`) ?? null
    );
    const second = harness(journal, state);
    const resumed = await executeBackfill(
      second.deps,
      planFromManifest(lookup.manifest, observed),
      {
        runId: lookup.manifest.runId,
        manifest: {
          runId: lookup.manifest.runId,
          manifestDigest: lookup.manifest.manifestDigest,
          entries: lookup.manifest.entries,
        },
        failFast: true,
      }
    );

    expect(resumed.entries[4].outcome).toBe('UPLOADED_AND_POINTED');
    expect(resumed.entries[4].attempt).toBe(2);
    expect(second.uploads).toEqual([work[4].expectedPath]);
    expect(second.casCalls).toEqual([5]);

    const finalAudit = auditJournal(await journal.read());
    expect(finalAudit.runs[0]).toMatchObject({
      entriesSucceeded: 5,
      entriesFailed: 0,
      entriesMissing: 0,
    });
    expect(selectResumeRun(finalAudit, {}).ok).toBe(false);
    expect(detectConflicts((await journal.read()).records)).toEqual([]);
  });

  it('does not run later entries while the failing entry keeps failing', async () => {
    const journal = createMemoryJournal();
    const work = fiveEntryPlan();
    const manifest = await startRun(journal, work);
    const state: State = {
      bodies: new Map(),
      pointers: new Map(),
      objects: new Map(),
      writes: new Map(),
    };
    seedBodies(state);

    await executeBackfill(
      harness(journal, state, { failUploadFor: (path) => path === work[2].expectedPath }).deps,
      work,
      { runId: manifest.runId, manifest, failFast: true }
    );

    const lookup = recordedManifest((await journal.read()).records, manifest.runId);
    if (!lookup.ok) throw new Error('manifest missing');
    const observed = lookup.manifest.entries.map(
      (entry) => state.pointers.get(`${entry.kind}:${entry.postId}:${entry.locale}`) ?? null
    );

    // The retry fails again: entries 4-5 still must not be attempted.
    const retry = harness(journal, state, {
      failUploadFor: (path) => path === work[2].expectedPath,
    });
    const secondFailure = await executeBackfill(
      retry.deps,
      planFromManifest(lookup.manifest, observed),
      {
        runId: lookup.manifest.runId,
        manifest: {
          runId: lookup.manifest.runId,
          manifestDigest: lookup.manifest.manifestDigest,
          entries: lookup.manifest.entries,
        },
        failFast: true,
      }
    );

    expect(secondFailure.stopped).toMatchObject({ postId: 3, outcome: 'UPLOAD_FAILED' });
    expect(secondFailure.remaining.map((entry) => entry.postId)).toEqual([4, 5]);
    expect(retry.uploads).toEqual([work[2].expectedPath]);
    expect(retry.casCalls).toEqual([]);
    expect(state.pointers.get('blog:4:en') ?? null).toBeNull();
    expect(state.pointers.get('blog:5:en') ?? null).toBeNull();

    // The run remains unfinished with two failed attempts recorded.
    const audit = auditJournal(await journal.read());
    expect(audit.runs[0].entriesFailed).toBe(1);
    expect(audit.runs[0].entriesMissing).toBe(2);
    expect(selectResumeRun(audit, {}).ok).toBe(true);
    expect(
      outcomesFor((await journal.read()).records, 3).map((record) =>
        record.type === 'outcome' ? record.attempt : 0
      )
    ).toEqual([1, 2]);
    expect(audit.trustworthy).toBe(true);
    expect(detectConflicts((await journal.read()).records)).toEqual([]);
  });

  it('still detects genuinely contradictory outcomes within one attempt', () => {
    const base = {
      type: 'outcome' as const,
      runId: 'run-x',
      manifestDigest: 'manifest-x',
      kind: 'blog',
      postId: 1,
      locale: 'en',
      attempt: 1,
      previousPath: null,
      intendedPath: `blog/1/en/${'a'.repeat(64)}.md`,
      sourceSha256: 'a'.repeat(64),
      upload: 'uploaded' as const,
      cas: 'APPLIED',
      casReason: null,
      pointerVerified: true,
      pointerSwitched: true,
      objectCreatedByRun: true,
      revalidation: 'sent' as const,
      detail: null,
      at: '2026-10-18T10:00:00.000Z',
    };
    const conflicts = detectConflicts([
      { ...base, outcome: 'UPLOADED_AND_POINTED' },
      { ...base, outcome: 'CAS_STALE', pointerSwitched: false },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('conflicting outcome records');
  });
});

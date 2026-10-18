import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sha256Hex, type BodyContentStorageApi } from '@/libs/cms/storage/bodyContent';
import { planEntry, type BackfillPlanEntry } from '@/libs/cms/storage/backfillPlan';
import {
  executeBackfill,
  executeRollback,
  executionManifest,
  manifestDigest,
  planFromManifest,
  planRollback,
  retryRollbackRevalidations,
  type BackfillExecutorDeps,
  type ExecutionManifest,
} from '@/libs/cms/storage/backfillApply';
import { validatePointerCasArgs, type PointerCasArgs } from '@/libs/cms/storage/backfillCas';
import {
  auditJournal,
  createFileJournal,
  createMemoryJournal,
  pendingRollbackRevalidations,
  recordedManifest,
  selectResumeRun,
  type BackfillJournal,
  type JournalFsApi,
  type JournalRecord,
} from '@/libs/cms/storage/backfillJournal';

/**
 * Phase 12 GATE A: the durable immutable execution manifest, fail-fast
 * execution, and rollback integrity around an interrupted run.
 */

const fsApi = fs as unknown as JournalFsApi;

type State = {
  bodies: Map<string, string | null>;
  pointers: Map<string, string | null>;
  objects: Map<string, Buffer>;
  writes: Map<string, number>;
};

function freshState(): State {
  return {
    bodies: new Map(),
    pointers: new Map(),
    objects: new Map(),
    writes: new Map(),
  };
}

type Harness = {
  deps: BackfillExecutorDeps;
  uploads: string[];
  downloads: string[];
  removes: string[];
  casCalls: PointerCasArgs[];
  rollbackCalls: unknown[];
  invalidations: Array<{ entity: string; ids: number[] }>;
  state: State;
};

function makeHarness(options: {
  journal: BackfillJournal;
  state?: State;
  invalidate?: 'sent' | 'failed' | 'skipped';
  failUploadFor?: (path: string) => boolean;
  journalFailsOn?: (record: JournalRecord) => boolean;
  rollbackOutcome?: 'ROLLED_BACK' | 'STALE';
}): Harness {
  const state = options.state ?? freshState();
  const uploads: string[] = [];
  const downloads: string[] = [];
  const removes: string[] = [];
  const casCalls: PointerCasArgs[] = [];
  const rollbackCalls: unknown[] = [];
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
      downloads.push(path);
      const found = state.objects.get(path);
      return found ? { data: found, error: null } : { data: null, error: { message: 'missing' } };
    },
    async remove(paths) {
      removes.push(...paths);
      return { data: null, error: null };
    },
  };

  const journal: BackfillJournal = {
    path: options.journal.path,
    async append(record) {
      if (options.journalFailsOn?.(record)) {
        throw new Error('journal append refused');
      }
      await options.journal.append(record);
    },
    read: () => options.journal.read(),
  };

  const deps: BackfillExecutorDeps = {
    storage,
    cas: {
      async pointerCas(args) {
        const invalid = validatePointerCasArgs(args);
        if (invalid) throw new Error(`[backfill-cas] refusing pointer CAS: ${invalid}`);
        casCalls.push(args);
        const key = `${args.kind}:${args.postId}:${args.locale}`;
        const current = state.pointers.get(key) ?? null;
        if (current === args.newPath) return { outcome: 'ALREADY_CURRENT', reason: null };
        if (current !== args.expectedPrevious) {
          return { outcome: 'STALE', reason: 'pointer_drift' };
        }
        state.pointers.set(key, args.newPath);
        return { outcome: 'APPLIED', reason: null };
      },
      async pointerRollback(args) {
        rollbackCalls.push(args);
        const key = `${args.kind}:${args.postId}:${args.locale}`;
        const wanted = options.rollbackOutcome ?? 'ROLLED_BACK';
        if (wanted === 'ROLLED_BACK') state.pointers.set(key, args.previousPath);
        return { outcome: wanted, reason: wanted === 'STALE' ? 'body_changed' : null };
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
    newRunId: () => 'run-a',
  };

  return { deps, uploads, downloads, removes, casCalls, rollbackCalls, invalidations, state };
}

function plan(kind: 'blog' | 'portfolio', entries: Array<[number, 'en' | 'it', string]>): BackfillPlanEntry[] {
  return entries.map(([postId, locale, body]) => planEntry(kind, postId, locale, body, null));
}

/** Mirrors the CLI: record the immutable manifest before the first mutation. */
async function startRun(
  journal: BackfillJournal,
  work: BackfillPlanEntry[],
  runId = 'run-a'
): Promise<ExecutionManifest> {
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

const BODIES = ['# one\n', '# two\n', '# three\n', '# four\n', '# five\n'];

/** Unset pointers are "no pointer" in these assertions. */
function ptr(state: State, key: string): string | null {
  return state.pointers.get(key) ?? null;
}

describe('GATE A1: immutable manifest and partial-run resume', () => {
  it('the planner digest changes after a switch, but the recorded manifest does not', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', BODIES.map((body, i) => [i + 1, 'en', body] as [number, 'en', string]));
    const manifest = await startRun(journal, work);

    const h = makeHarness({ journal });
    for (const [index, body] of BODIES.entries()) {
      h.state.bodies.set(`blog:${index + 1}:en`, body);
    }
    // Interrupt: the run stops before entry 4's intent is durable.
    const interrupted = makeHarness({
      journal,
      state: h.state,
      journalFailsOn: (record) => record.type === 'intent' && record.postId === 4,
    });
    await expect(
      executeBackfill(interrupted.deps, work, { runId: manifest.runId, manifest, failFast: true })
    ).rejects.toThrow(/journal append refused/);

    // Three posts are switched; the journal holds their outcomes.
    expect(ptr(h.state, 'blog:1:en')).toBe(work[0].expectedPath);
    expect(ptr(h.state, 'blog:2:en')).toBe(work[1].expectedPath);
    expect(ptr(h.state, 'blog:3:en')).toBe(work[2].expectedPath);
    expect(ptr(h.state, 'blog:4:en')).toBeNull();

    // A digest recomputed from the CURRENT database no longer matches.
    const replanned = BODIES.map((body, i) =>
      planEntry('blog', i + 1, 'en', body, h.state.pointers.get(`blog:${i + 1}:en`) ?? null)
    );
    expect(replanned[0].action).toBe('ALREADY_CURRENT');
    expect(manifestDigest(replanned)).not.toBe(manifest.manifestDigest);

    // The recorded manifest still does.
    const lookup = recordedManifest((await journal.read()).records);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.manifest.manifestDigest).toBe(manifest.manifestDigest);
  });

  it('finishes the remaining entries without re-uploading or re-writing the first three', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', BODIES.map((body, i) => [i + 1, 'en', body] as [number, 'en', string]));
    const manifest = await startRun(journal, work);
    const state = freshState();
    for (const [index, body] of BODIES.entries()) {
      state.bodies.set(`blog:${index + 1}:en`, body);
    }

    await expect(
      executeBackfill(
        makeHarness({
          journal,
          state,
          journalFailsOn: (record) => record.type === 'intent' && record.postId === 4,
        }).deps,
        work,
        { runId: manifest.runId, manifest, failFast: true }
      )
    ).rejects.toThrow(/journal append refused/);

    // ── a fresh process resumes from the recorded manifest ──────────────────
    const lookup = recordedManifest((await journal.read()).records);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const observed = lookup.manifest.entries.map(
      (entry) => state.pointers.get(`${entry.kind}:${entry.postId}:${entry.locale}`) ?? null
    );
    const resumedWork = planFromManifest(lookup.manifest, observed);
    expect(resumedWork.map((entry) => entry.action)).toEqual([
      'ALREADY_CURRENT',
      'ALREADY_CURRENT',
      'ALREADY_CURRENT',
      'UPLOAD_AND_POINT',
      'UPLOAD_AND_POINT',
    ]);

    const resumed = makeHarness({ journal, state });
    const writesBefore = new Map(state.writes);
    const report = await executeBackfill(resumed.deps, resumedWork, {
      runId: lookup.manifest.runId,
      manifest: {
        runId: lookup.manifest.runId,
        manifestDigest: lookup.manifest.manifestDigest,
        entries: lookup.manifest.entries,
      },
      failFast: true,
    });

    expect(report.entries.map((entry) => entry.outcome)).toEqual([
      'ALREADY_CURRENT',
      'ALREADY_CURRENT',
      'ALREADY_CURRENT',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
    ]);
    // Only the two outstanding objects were written; the first three were
    // verified by download and never re-uploaded.
    expect(resumed.uploads).toEqual([work[3].expectedPath, work[4].expectedPath]);
    for (const entry of work.slice(0, 3)) {
      // Each object was written exactly once — by the interrupted run.
      expect(state.writes.get(entry.expectedPath as string) ?? 0).toBe(
        writesBefore.get(entry.expectedPath as string) ?? 0
      );
      expect(resumed.downloads).toContain(entry.expectedPath);
    }
    // Exactly one object per entry, and exactly one manifest record.
    expect(state.objects.size).toBe(5);
    expect(report.manifestDigest).toBe(manifest.manifestDigest);
    const records = (await journal.read()).records;
    expect(records.filter((record) => record.type === 'manifest')).toHaveLength(1);
    // Exactly one terminal outcome per entry: the resume re-verified the three
    // completed entries without appending a second, conflicting record.
    const latest = new Map<string, string>();
    for (const record of records) {
      if (record.type !== 'outcome') continue;
      latest.set(`${record.kind}:${record.postId}:${record.locale}`, record.outcome);
    }
    expect(latest.size).toBe(5);
    expect([...latest.values()]).toEqual([
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
    ]);
  });

  it('resumes across processes through a real file journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cms-cutover-'));
    const journalPath = join(dir, 'run.jsonl');
    try {
      const work = plan('blog', BODIES.map((body, i) => [i + 1, 'en', body] as [number, 'en', string]));
      const state = freshState();
      for (const [index, body] of BODIES.entries()) {
        state.bodies.set(`blog:${index + 1}:en`, body);
      }

      const firstJournal = createFileJournal(journalPath, fsApi);
      const manifest = await startRun(firstJournal, work);
      await expect(
        executeBackfill(
          makeHarness({
            journal: firstJournal,
            state,
            journalFailsOn: (record) => record.type === 'intent' && record.postId === 4,
          }).deps,
          work,
          { runId: manifest.runId, manifest, failFast: true }
        )
      ).rejects.toThrow(/journal append refused/);

      // A brand-new process opens the same journal file.
      const secondJournal = createFileJournal(journalPath, fsApi);
      const lookup = recordedManifest((await secondJournal.read()).records);
      expect(lookup.ok).toBe(true);
      if (!lookup.ok) return;
      // The interruption happened between entries: every intent it wrote was
      // answered, yet the manifest still declares two entries without outcomes,
      // so the run must remain resumable.
      const secondAudit = auditJournal(await secondJournal.read());
      expect(secondAudit.runs[0].unresolved).toHaveLength(0);
      expect(secondAudit.runs[0].intents).toBe(3);
      expect(secondAudit.runs[0].outcomes).toBe(3);
      expect(secondAudit.runs[0].manifestEntries).toBe(5);
      const selection = selectResumeRun(secondAudit, {});
      expect(selection.ok).toBe(true);

      const observed = lookup.manifest.entries.map(
        (entry) => state.pointers.get(`${entry.kind}:${entry.postId}:${entry.locale}`) ?? null
      );
      const resumed = makeHarness({ journal: secondJournal, state });
      const report = await executeBackfill(
        resumed.deps,
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
      expect(report.summary.pointerSwitches).toBe(2);
      expect(state.objects.size).toBe(5);
      const parsed = await createFileJournal(journalPath, fsApi).read();
      expect(parsed.malformedLines).toBe(0);
      expect(parsed.tornTail).toBe(false);
      expect(auditJournal(parsed).trustworthy).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers an entry interrupted after its CAS but before its outcome', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [[1, 'en', BODIES[0]]]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);

    // Interruption: the switch happens, the outcome never becomes durable.
    await expect(
      executeBackfill(
        makeHarness({
          journal,
          state,
          journalFailsOn: (record) => record.type === 'outcome',
        }).deps,
        work,
        { runId: manifest.runId, manifest, failFast: true }
      )
    ).rejects.toThrow(/journal append refused/);
    expect(ptr(state, 'blog:1:en')).toBe(work[0].expectedPath);

    // The manifest still names the entry, so a rollback can own it…
    const candidates = await planRollback(makeHarness({ journal, state }).deps, {
      runId: manifest.runId,
    });
    expect(candidates.map((candidate) => candidate.state)).toEqual(['READY']);

    // …and a resume verifies it instead of switching it again.
    const lookup = recordedManifest((await journal.read()).records);
    if (!lookup.ok) throw new Error('manifest missing');
    const observed = [state.pointers.get('blog:1:en') ?? null];
    const resumed = makeHarness({ journal, state });
    const report = await executeBackfill(resumed.deps, planFromManifest(lookup.manifest, observed), {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });
    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    expect(resumed.uploads).toEqual([]);
  });
});

describe('GATE A2: fail-fast execution', () => {
  it('stops at the third entry and attempts nothing after it', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', BODIES.map((body, i) => [i + 1, 'en', body] as [number, 'en', string]));
    const manifest = await startRun(journal, work);
    const state = freshState();
    for (const [index, body] of BODIES.entries()) {
      state.bodies.set(`blog:${index + 1}:en`, body);
    }

    const h = makeHarness({
      journal,
      state,
      failUploadFor: (path) => path === work[2].expectedPath,
    });
    const report = await executeBackfill(h.deps, work, {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });

    expect(report.entries.map((entry) => entry.outcome)).toEqual([
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
      'UPLOAD_FAILED',
    ]);
    expect(report.stopped).toMatchObject({ postId: 3, outcome: 'UPLOAD_FAILED' });
    expect(report.remaining.map((entry) => entry.postId)).toEqual([4, 5]);
    expect(report.summary.failures).toBe(1);

    // Nothing after the failure was touched: no upload attempt, no CAS, no
    // pointer, and the successful switches are preserved.
    expect(h.uploads).toEqual([work[0].expectedPath, work[1].expectedPath, work[2].expectedPath]);
    expect(h.casCalls.map((call) => call.postId)).toEqual([1, 2]);
    expect(ptr(state, 'blog:1:en')).toBe(work[0].expectedPath);
    expect(ptr(state, 'blog:2:en')).toBe(work[1].expectedPath);
    expect(ptr(state, 'blog:4:en')).toBeNull();
    expect(ptr(state, 'blog:5:en')).toBeNull();

    // The audit for everything observed was flushed; nothing was deleted.
    const records = (await journal.read()).records;
    expect(records.filter((record) => record.type === 'outcome')).toHaveLength(3);
    expect(records.filter((record) => record.type === 'intent')).toHaveLength(3);
    expect(h.removes).toEqual([]);
  });

  it('stops when a signed invalidation fails, before the next post', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [
      [1, 'en', BODIES[0]],
      [2, 'en', BODIES[1]],
    ]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.bodies.set('blog:2:en', BODIES[1]);

    const h = makeHarness({ journal, state, invalidate: 'failed' });
    const report = await executeBackfill(h.deps, work, {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });

    expect(report.entries.map((entry) => entry.outcome)).toEqual(['REVALIDATION_FAILED']);
    expect(report.stopped).toMatchObject({ postId: 1, outcome: 'REVALIDATION_FAILED' });
    expect(report.remaining.map((entry) => entry.postId)).toEqual([2]);
    expect(report.revalidationPending).toEqual(['blog:1']);
    // The second post was never uploaded or switched.
    expect(h.uploads).toEqual([work[0].expectedPath]);
    expect(ptr(state, 'blog:2:en')).toBeNull();
  });

  it('stops when a journal append fails and leaves the earlier work committed', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [
      [1, 'en', BODIES[0]],
      [2, 'en', BODIES[1]],
    ]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.bodies.set('blog:2:en', BODIES[1]);

    const h = makeHarness({
      journal,
      state,
      journalFailsOn: (record) => record.type === 'intent' && record.postId === 2,
    });

    await expect(
      executeBackfill(h.deps, work, { runId: manifest.runId, manifest, failFast: true })
    ).rejects.toThrow(/journal append refused/);

    expect(ptr(state, 'blog:1:en')).toBe(work[0].expectedPath);
    expect(ptr(state, 'blog:2:en')).toBeNull();
    expect(h.uploads).toEqual([work[0].expectedPath]);
  });

  it('stops on a CMS edit made after planning', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [
      [1, 'en', BODIES[0]],
      [2, 'en', BODIES[1]],
    ]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.bodies.set('blog:2:en', '# edited by a CMS user\n');

    const h = makeHarness({ journal, state });
    const report = await executeBackfill(h.deps, work, {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });

    expect(report.entries.map((entry) => entry.outcome)).toEqual([
      'UPLOADED_AND_POINTED',
      'CAS_STALE',
    ]);
    expect(report.stopped).toMatchObject({ postId: 2, outcome: 'CAS_STALE' });
    // The edited row keeps its own pointer; nothing was overwritten.
    expect(ptr(state, 'blog:2:en')).toBeNull();
    expect(h.casCalls.map((call) => call.postId)).toEqual([1]);
  });
});

describe('GATE A3: rollback integrity', () => {
  it('rolls back an entry whose switch never got an outcome record', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [[1, 'en', BODIES[0]]]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    // The migration switched the pointer; only the intent is durable.
    state.pointers.set('blog:1:en', work[0].expectedPath as string);
    await journal.append({
      type: 'intent',
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      kind: 'blog',
      postId: 1,
      locale: 'en',
      previousPath: null,
      intendedPath: work[0].expectedPath as string,
      sourceSha256: work[0].sourceSha256 as string,
      at: '2026-10-18T10:00:00.000Z',
    });

    const h = makeHarness({ journal, state });
    const candidates = await planRollback(h.deps, { runId: manifest.runId });
    expect(candidates.map((candidate) => candidate.state)).toEqual(['READY']);

    const report = await executeRollback(h.deps, candidates, { failFast: true });
    expect(report.summary.rolledBack).toBe(1);
    expect(ptr(state, 'blog:1:en')).toBeNull();
    expect(report.incomplete).toBe(false);
  });

  it('groups the EN and IT invalidation of one post into a single event', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [
      [1, 'en', BODIES[0]],
      [1, 'it', BODIES[1]],
    ]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.bodies.set('blog:1:it', BODIES[1]);

    const h = makeHarness({ journal, state });
    const migration = await executeBackfill(h.deps, work, {
      runId: manifest.runId,
      manifest,
      failFast: true,
    });
    // One event for the migration of both locales.
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [1] }]);
    expect(migration.summary.pointerSwitches).toBe(2);

    h.invalidations.length = 0;
    const candidates = await planRollback(h.deps, { runId: manifest.runId });
    const rollback = await executeRollback(h.deps, candidates, { failFast: true });

    expect(rollback.summary.rolledBack).toBe(2);
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [1] }]);
    expect(rollback.incomplete).toBe(false);
    expect(ptr(state, 'blog:1:en')).toBeNull();
    expect(ptr(state, 'blog:1:it')).toBeNull();
  });

  it('keeps a failed rollback invalidation pending and retries it later', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [[1, 'en', BODIES[0]]]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.pointers.set('blog:1:en', work[0].expectedPath as string);
    await journal.append({
      type: 'intent',
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      kind: 'blog',
      postId: 1,
      locale: 'en',
      previousPath: null,
      intendedPath: work[0].expectedPath as string,
      sourceSha256: work[0].sourceSha256 as string,
      at: '2026-10-18T10:00:00.000Z',
    });

    const failing = makeHarness({ journal, state, invalidate: 'failed' });
    const candidates = await planRollback(failing.deps, { runId: manifest.runId });
    const report = await executeRollback(failing.deps, candidates, { failFast: true });

    expect(report.summary.rolledBack).toBe(1);
    expect(report.incomplete).toBe(true);
    expect(report.revalidationPending).toEqual(['blog:1']);

    const records = (await journal.read()).records;
    const pending = pendingRollbackRevalidations(records);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ postId: 1, installedPath: work[0].expectedPath });

    // A later invocation retries the invalidation only.
    const retrying = makeHarness({ journal, state, invalidate: 'sent' });
    const retries = await retryRollbackRevalidations(retrying.deps, pending);
    expect(retries).toEqual([
      expect.objectContaining({ outcome: 'REVALIDATED', status: 'sent', postId: 1 }),
    ]);
    expect(retrying.uploads).toEqual([]);
    expect(retrying.rollbackCalls).toEqual([]);
    expect(pendingRollbackRevalidations((await journal.read()).records)).toEqual([]);
  });

  it('stops at the first rollback conflict instead of forcing it', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [
      [1, 'en', BODIES[0]],
      [2, 'en', BODIES[1]],
    ]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.bodies.set('blog:2:en', '# edited after the migration\n');
    state.pointers.set('blog:1:en', work[0].expectedPath as string);
    state.pointers.set('blog:2:en', work[1].expectedPath as string);

    const h = makeHarness({ journal, state });
    const candidates = await planRollback(h.deps, { runId: manifest.runId });
    // Reverse order: post 2 first, and its body changed.
    expect(candidates.map((candidate) => [candidate.postId, candidate.state])).toEqual([
      [2, 'BODY_CHANGED'],
      [1, 'READY'],
    ]);

    const report = await executeRollback(h.deps, candidates, { failFast: true });
    expect(report.stopped).toMatchObject({ postId: 2, state: 'BODY_CHANGED' });
    expect(report.summary.rolledBack).toBe(0);
    expect(report.summary.conflicts).toBe(1);
    // The untouched entry keeps its migrated pointer.
    expect(ptr(state, 'blog:2:en')).toBe(work[1].expectedPath);
    expect(ptr(state, 'blog:1:en')).toBe(work[0].expectedPath);
    expect(h.rollbackCalls).toEqual([]);
  });

  it('never uploads or removes objects during a rollback', async () => {
    const journal = createMemoryJournal();
    const work = plan('blog', [[1, 'en', BODIES[0]]]);
    const manifest = await startRun(journal, work);
    const state = freshState();
    state.bodies.set('blog:1:en', BODIES[0]);
    state.objects.set(work[0].expectedPath as string, Buffer.from(BODIES[0], 'utf8'));

    const h = makeHarness({ journal, state });
    await executeBackfill(h.deps, work, { runId: manifest.runId, manifest, failFast: true });
    const uploadsBefore = [...h.uploads];
    const candidates = await planRollback(h.deps, { runId: manifest.runId });
    await executeRollback(h.deps, candidates, { failFast: true });

    expect(h.uploads).toEqual(uploadsBefore);
    expect(h.removes).toEqual([]);
    expect(state.objects.size).toBe(1);
    expect(sha256Hex(state.objects.get(work[0].expectedPath as string) as Buffer)).toBe(
      work[0].sourceSha256
    );
  });
});

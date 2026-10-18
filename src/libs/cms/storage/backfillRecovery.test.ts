import { describe, expect, it } from 'vitest';
import { sha256Hex, type BodyContentStorageApi } from '@/libs/cms/storage/bodyContent';
import { planEntry, type BackfillPlanEntry } from '@/libs/cms/storage/backfillPlan';
import {
  ROLLBACK_ACK_ENV,
  ROLLBACK_ACK_VALUE,
  executeBackfill,
  executeRollback,
  parseExecArgs,
  parseRollbackArgs,
  planRollback,
  retryPendingRevalidations,
  validateRevalidationEndpoint,
  type BackfillExecutorDeps,
} from '@/libs/cms/storage/backfillApply';
import {
  auditJournal,
  createMemoryJournal,
  journalEntryKey,
  pendingRevalidations,
  selectResumeRun,
  unresolvedIntents,
  type JournalIntent,
  type JournalOutcome,
  type JournalRecord,
} from '@/libs/cms/storage/backfillJournal';
import { validatePointerCasArgs, type PointerCasArgs } from '@/libs/cms/storage/backfillCas';

/**
 * Phase 11B.2 recovery behaviors: journal identity across runs, resume
 * selection, pending-invalidation retry across invocations, the corrected
 * ALREADY_CURRENT pointer check, and the rollback plan/execute contract.
 */

const HASH = 'a'.repeat(64);

function slotKey(kind: string, postId: number, locale: string, path: string): string {
  return `${kind}|${postId}|${locale}|${path}`;
}

function makeIntent(overrides: Partial<JournalIntent> = {}): JournalIntent {
  return {
    type: 'intent',
    runId: 'run-a',
    manifestDigest: 'manifest-1',
    kind: 'blog',
    postId: 1,
    locale: 'en',
    previousPath: null,
    intendedPath: `blog/1/en/${HASH}.md`,
    sourceSha256: HASH,
    at: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<Omit<JournalOutcome, 'type'>> = {}): JournalOutcome {
  return {
    ...makeIntent(),
    type: 'outcome',
    outcome: 'UPLOADED_AND_POINTED',
    upload: 'uploaded',
    cas: 'APPLIED',
    casReason: null,
    pointerVerified: true,
    pointerSwitched: true,
    objectCreatedByRun: true,
    revalidation: 'sent',
    detail: null,
    ...overrides,
  };
}

type Harness = {
  deps: BackfillExecutorDeps;
  journal: ReturnType<typeof createMemoryJournal>;
  uploads: string[];
  downloads: string[];
  removes: string[];
  casCalls: PointerCasArgs[];
  rollbackCalls: unknown[];
  invalidations: Array<{ entity: string; ids: number[] }>;
  bodies: Map<string, string | null>;
  pointers: Map<string, string | null>;
  objects: Map<string, Buffer>;
};

function makeHarness(
  options: {
    invalidate?: 'sent' | 'failed' | 'skipped';
    journal?: ReturnType<typeof createMemoryJournal>;
    casOutcome?: 'APPLIED' | 'ALREADY_CURRENT' | 'STALE';
    rollbackOutcome?: 'ROLLED_BACK' | 'STALE' | 'ALREADY_CURRENT';
    missingObject?: boolean;
  } = {}
): Harness {
  const bodies = new Map<string, string | null>();
  const pointers = new Map<string, string | null>();
  const objects = new Map<string, Buffer>();
  const uploads: string[] = [];
  const downloads: string[] = [];
  const removes: string[] = [];
  const casCalls: PointerCasArgs[] = [];
  const rollbackCalls: unknown[] = [];
  const invalidations: Array<{ entity: string; ids: number[] }> = [];
  const journal = options.journal ?? createMemoryJournal();

  const storage: BodyContentStorageApi = {
    async upload(path, body) {
      uploads.push(path);
      objects.set(path, Buffer.from(body as Buffer));
      return { data: { path }, error: null };
    },
    async download(path) {
      downloads.push(path);
      const found = options.missingObject ? undefined : objects.get(path);
      return found ? { data: found, error: null } : { data: null, error: { message: 'missing' } };
    },
    async remove(paths) {
      removes.push(...paths);
      return { data: null, error: null };
    },
  };

  const deps: BackfillExecutorDeps = {
    storage,
    cas: {
      async pointerCas(args) {
        const invalid = validatePointerCasArgs(args);
        if (invalid) throw new Error(`[backfill-cas] refusing pointer CAS: ${invalid}`);
        casCalls.push(args);
        const key = `${args.kind}:${args.postId}:${args.locale}`;
        const current = pointers.get(key) ?? null;
        const wanted = options.casOutcome ?? 'APPLIED';
        if (wanted === 'STALE' || (wanted === 'APPLIED' && current !== args.expectedPrevious)) {
          return { outcome: 'STALE', reason: 'pointer_drift' };
        }
        if (wanted === 'APPLIED') pointers.set(key, args.newPath);
        return { outcome: wanted, reason: null };
      },
      async pointerRollback(args) {
        rollbackCalls.push(args);
        const key = `${args.kind}:${args.postId}:${args.locale}`;
        const wanted = options.rollbackOutcome ?? 'ROLLED_BACK';
        if (wanted === 'ROLLED_BACK') pointers.set(key, args.previousPath);
        return { outcome: wanted, reason: wanted === 'STALE' ? 'body_changed' : null };
      },
    },
    readCommittedBody: async (kind, postId, locale) =>
      bodies.get(`${kind}:${postId}:${locale}`) ?? null,
    readCommittedPointer: async (kind, postId, locale) =>
      pointers.get(`${kind}:${postId}:${locale}`) ?? null,
    invalidate: async (args) => {
      invalidations.push({ entity: args.entity, ids: args.ids });
      return options.invalidate ?? 'sent';
    },
    journal,
    now: () => new Date('2026-10-18T10:00:00.000Z'),
    newRunId: () => 'run-a',
  };

  return { deps, journal, uploads, downloads, removes, casCalls, rollbackCalls, invalidations, bodies, pointers, objects };
}

function entry(kind: 'blog' | 'portfolio', postId: number, locale: 'en' | 'it', body: string): BackfillPlanEntry {
  return planEntry(kind, postId, locale, body, null);
}

describe('journal identity across runs', () => {
  it('never lets one run complete another run.s intent', () => {
    const shared = {
      kind: 'blog',
      postId: 1,
      locale: 'en',
      intendedPath: `blog/1/en/${HASH}.md`,
    };
    const intentRunB = makeIntent({ ...shared, runId: 'run-b' });
    const outcomeRunA = makeOutcome({ ...shared, runId: 'run-a' });

    const records: JournalRecord[] = [intentRunB, outcomeRunA];
    expect(unresolvedIntents(records)).toHaveLength(1);
    expect(unresolvedIntents(records)[0].runId).toBe('run-b');

    // The same identity with a different manifest is also a different entry.
    const otherManifest = makeOutcome({ ...shared, runId: 'run-b', manifestDigest: 'manifest-2' });
    expect(unresolvedIntents([intentRunB, otherManifest])).toHaveLength(1);
  });

  it('audits runs separately and reports conflicts', () => {
    const records: JournalRecord[] = [
      makeIntent({ runId: 'run-a', manifestDigest: 'manifest-1' }),
      makeOutcome({ runId: 'run-a', manifestDigest: 'manifest-1' }),
      makeIntent({ runId: 'run-b', manifestDigest: 'manifest-1', postId: 2 }),
    ];
    const audit = auditJournal({ records, tornTail: false, malformedLines: 0 });
    expect(audit.runs.map((run) => run.runId)).toEqual(['run-a', 'run-b']);
    expect(audit.runs[0].switched).toBe(1);
    expect(audit.runs[1].unresolved).toHaveLength(1);
    expect(audit.conflicts).toEqual([]);
    expect(audit.trustworthy).toBe(true);
  });

  it('selects only a compatible, single unfinished run to resume', () => {
    const clean = auditJournal({
      records: [makeIntent(), makeOutcome()],
      tornTail: false,
      malformedLines: 0,
    });
    expect(selectResumeRun(clean, { manifestDigest: 'manifest-1' }).ok).toBe(false);

    const unfinished = auditJournal({
      records: [makeIntent()],
      tornTail: false,
      malformedLines: 0,
    });
    const ok = selectResumeRun(unfinished, { manifestDigest: 'manifest-1' });
    expect(ok.ok).toBe(true);

    const mismatched = selectResumeRun(unfinished, { manifestDigest: 'other-manifest' });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error).toContain('different manifest');

    const twoRuns = auditJournal({
      records: [makeIntent({ runId: 'run-a' }), makeIntent({ runId: 'run-b', postId: 2 })],
      tornTail: false,
      malformedLines: 0,
    });
    const ambiguous = selectResumeRun(twoRuns, { manifestDigest: 'manifest-1' });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error).toContain('several unfinished runs');
  });
});

describe('pending invalidation retry across invocations', () => {
  it('records a failed invalidation as pending, then resolves it on a later invocation', async () => {
    // ── invocation 1: the switch succeeds but the WS refuses the event ──────
    const first = makeHarness({ invalidate: 'failed' });
    const body = '# retry me\n';
    first.bodies.set('blog:1:en', body);
    const report = await executeBackfill(first.deps, [entry('blog', 1, 'en', body)]);

    expect(report.entries[0].outcome).toBe('REVALIDATION_FAILED');
    expect(report.entries[0].pointerSwitched).toBe(true);
    expect(report.revalidationPending).toEqual(['blog:1']);
    expect(first.pointers.get('blog:1:en')).toBe(report.entries[0].intendedPath);

    const afterFirst = await first.journal.read();
    const pending = pendingRevalidations(afterFirst.records);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ postId: 1, lastStatus: 'failed', attempts: 1 });

    // ── invocation 2: nothing to migrate, but the invalidation is retried ──
    const second = makeHarness({
      invalidate: 'sent',
      journal: first.journal,
    });
    second.bodies.set('blog:1:en', body);
    second.pointers.set('blog:1:en', report.entries[0].intendedPath);

    const retries = await retryPendingRevalidations(second.deps, pending);
    expect(retries).toEqual([
      expect.objectContaining({ outcome: 'REVALIDATED', status: 'sent', postId: 1 }),
    ]);
    // A retry never uploads and never touches a pointer.
    expect(second.uploads).toEqual([]);
    expect(second.casCalls).toEqual([]);
    expect(second.invalidations).toEqual([{ entity: 'blog', ids: [1] }]);

    const afterSecond = await second.journal.read();
    expect(pendingRevalidations(afterSecond.records)).toEqual([]);
  });

  it('treats a skipped invalidation as incomplete work', async () => {
    const h = makeHarness({ invalidate: 'skipped' });
    const body = '# skipped invalidation\n';
    h.bodies.set('blog:2:en', body);
    const report = await executeBackfill(h.deps, [entry('blog', 2, 'en', body)]);

    expect(report.entries[0].outcome).toBe('REVALIDATION_FAILED');
    expect(report.entries[0].revalidation).toBe('skipped');
    const pending = pendingRevalidations((await h.journal.read()).records);
    expect(pending).toHaveLength(1);
    expect(pending[0].lastStatus).toBe('skipped');
  });

  it('resolves a pending invalidation as superseded when the row moved on', async () => {
    const h = makeHarness({ invalidate: 'failed' });
    const body = '# moved on\n';
    h.bodies.set('blog:3:en', body);
    const report = await executeBackfill(h.deps, [entry('blog', 3, 'en', body)]);
    const pending = pendingRevalidations((await h.journal.read()).records);
    expect(pending).toHaveLength(1);
    expect(report.summary.pointerSwitches).toBe(1);

    // A CMS user (or another process) repointed the row afterwards.
    h.pointers.set('blog:3:en', `blog/3/en/${'c'.repeat(64)}.md`);
    const retries = await retryPendingRevalidations(h.deps, pending);
    expect(retries[0]).toMatchObject({ outcome: 'SUPERSEDED', status: 'superseded' });
    expect(pendingRevalidations((await h.journal.read()).records)).toEqual([]);
  });

  it('keeps a retry pending when the WS is still unavailable', async () => {
    const h = makeHarness({ invalidate: 'failed' });
    const body = '# still down\n';
    h.bodies.set('blog:4:en', body);
    await executeBackfill(h.deps, [entry('blog', 4, 'en', body)]);
    const pending = pendingRevalidations((await h.journal.read()).records);

    const retries = await retryPendingRevalidations(h.deps, pending);
    expect(retries[0].outcome).toBe('FAILED');
    expect(pendingRevalidations((await h.journal.read()).records)).toHaveLength(1);
  });

  it('groups the EN and IT retry of one post into a single event', async () => {
    const h = makeHarness({ invalidate: 'failed' });
    const en = '# en\n';
    const it = '# it\n';
    h.bodies.set('blog:5:en', en);
    h.bodies.set('blog:5:it', it);
    await executeBackfill(h.deps, [entry('blog', 5, 'en', en), entry('blog', 5, 'it', it)]);

    const pending = pendingRevalidations((await h.journal.read()).records);
    expect(pending).toHaveLength(2);

    const retryHarness = makeHarness({ invalidate: 'sent', journal: h.journal });
    retryHarness.pointers.set('blog:5:en', `blog/5/en/${sha256Hex(Buffer.from(en, 'utf8'))}.md`);
    retryHarness.pointers.set('blog:5:it', `blog/5/it/${sha256Hex(Buffer.from(it, 'utf8'))}.md`);
    const retries = await retryPendingRevalidations(retryHarness.deps, pending);

    expect(retries).toHaveLength(2);
    expect(retryHarness.invalidations).toHaveLength(1);
    expect(retryHarness.invalidations[0]).toEqual({ entity: 'blog', ids: [5] });
  });
});

describe('ALREADY_CURRENT pointer verification', () => {
  it('fails explicitly when the object matches but the pointer drifted', async () => {
    const h = makeHarness();
    const body = '# drifted pointer\n';
    const planned = entry('blog', 6, 'en', body);
    h.bodies.set('blog:6:en', body);
    h.objects.set(planned.expectedPath as string, Buffer.from(body, 'utf8'));
    // The row no longer holds this key.
    h.pointers.set('blog:6:en', `blog/6/en/${'d'.repeat(64)}.md`);

    const report = await executeBackfill(h.deps, [
      planEntry('blog', 6, 'en', body, planned.expectedPath),
    ]);

    expect(report.entries[0].outcome).toBe('POINTER_VERIFY_FAILED');
    expect(report.entries[0].pointerVerified).toBe(false);
    expect(report.summary.failures).toBe(1);
    expect(report.summary.alreadyCurrent).toBe(0);
    expect(report.revalidationPending).toEqual([]);
    expect(h.invalidations).toEqual([]);
    expect(h.casCalls).toEqual([]);
    expect(h.uploads).toEqual([]);

    const outcomes = (await h.journal.read()).records.filter(
      (record) => record.type === 'outcome'
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: 'POINTER_VERIFY_FAILED', pointerVerified: false });
  });

  it('still reports ALREADY_CURRENT when object and pointer agree', async () => {
    const h = makeHarness();
    const body = '# agree\n';
    const planned = entry('blog', 7, 'en', body);
    h.bodies.set('blog:7:en', body);
    h.objects.set(planned.expectedPath as string, Buffer.from(body, 'utf8'));
    h.pointers.set('blog:7:en', planned.expectedPath);

    const report = await executeBackfill(h.deps, [
      planEntry('blog', 7, 'en', body, planned.expectedPath),
    ]);
    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    expect(report.summary.failures).toBe(0);
  });
});

describe('rollback planning and execution', () => {
  /** Journal records whose recorded source hash matches the given body. */
  async function journalWithSwitches(
    entries: Array<{ postId: number; body: string }>
  ): Promise<ReturnType<typeof createMemoryJournal>> {
    const journal = createMemoryJournal();
    for (const { postId, body } of entries) {
      const hash = sha256Hex(Buffer.from(body, 'utf8'));
      const shared = {
        postId,
        sourceSha256: hash,
        intendedPath: `blog/${postId}/en/${hash}.md`,
      };
      await journal.append(makeIntent(shared));
      await journal.append(makeOutcome(shared));
    }
    return journal;
  }

  it('plans candidates from the verified record in reverse migration order', async () => {
    const one = '# one\n';
    const two = '# two\n';
    const journal = await journalWithSwitches([
      { postId: 1, body: one },
      { postId: 2, body: two },
    ]);
    const h = makeHarness({ journal });
    h.bodies.set('blog:1:en', one);
    h.bodies.set('blog:2:en', two);
    h.pointers.set('blog:1:en', `blog/1/en/${sha256Hex(Buffer.from(one, 'utf8'))}.md`);
    h.pointers.set('blog:2:en', `blog/2/en/${sha256Hex(Buffer.from(two, 'utf8'))}.md`);

    const candidates = await planRollback(h.deps, { runId: 'run-a' });
    expect(candidates.map((candidate) => candidate.postId)).toEqual([2, 1]);
    expect(candidates.map((candidate) => candidate.state)).toEqual(['READY', 'READY']);
    // Planning writes nothing.
    expect(h.casCalls).toEqual([]);
    expect(h.rollbackCalls).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.invalidations).toEqual([]);
  });

  it('refuses a candidate whose body changed, whose pointer drifted, or which is gone', async () => {
    const edited = '# edited by a CMS user\n';
    const gone = '# gone\n';
    const restored = '# restored\n';
    const drifted = '# drifted\n';
    const journal = createMemoryJournal();
    const appendSwitch = async (postId: number, body: string): Promise<void> => {
      const hash = sha256Hex(Buffer.from(body, 'utf8'));
      const shared = {
        postId,
        sourceSha256: hash,
        intendedPath: `blog/${postId}/en/${hash}.md`,
      };
      await journal.append(makeIntent(shared));
      await journal.append(makeOutcome(shared));
    };
    await appendSwitch(11, '# original\n');
    await appendSwitch(12, gone);
    await appendSwitch(13, restored);
    await appendSwitch(14, drifted);

    const h = makeHarness({ journal });
    h.bodies.set('blog:11:en', edited);
    h.pointers.set('blog:11:en', `blog/11/en/${sha256Hex(Buffer.from('# original\n', 'utf8'))}.md`);
    // 12 keeps no body at all -> MISSING
    h.bodies.set('blog:13:en', restored);
    h.pointers.set('blog:13:en', null); // already restored
    h.bodies.set('blog:14:en', drifted);
    h.pointers.set('blog:14:en', `blog/14/en/${'e'.repeat(64)}.md`);

    const states = new Map(
      (await planRollback(h.deps, { runId: 'run-a' })).map((candidate) => [
        candidate.postId,
        candidate.state,
      ])
    );
    expect(states.get(11)).toBe('BODY_CHANGED');
    expect(states.get(12)).toBe('MISSING');
    expect(states.get(13)).toBe('ALREADY_ROLLED_BACK');
    expect(states.get(14)).toBe('POINTER_DRIFTED');
  });

  it('rolls back READY candidates, journals the outcome and revalidates the cache', async () => {
    const one = '# one\n';
    const two = '# two\n';
    const journal = await journalWithSwitches([
      { postId: 1, body: one },
      { postId: 2, body: two },
    ]);
    const h = makeHarness({ journal });
    h.bodies.set('blog:1:en', one);
    h.bodies.set('blog:2:en', two);
    h.pointers.set('blog:1:en', `blog/1/en/${sha256Hex(Buffer.from(one, 'utf8'))}.md`);
    h.pointers.set('blog:2:en', `blog/2/en/${sha256Hex(Buffer.from(two, 'utf8'))}.md`);

    const candidates = await planRollback(h.deps, { runId: 'run-a' });
    expect(candidates.every((candidate) => candidate.state === 'READY')).toBe(true);

    const report = await executeRollback(h.deps, candidates);
    expect(report.summary.rolledBack).toBe(2);
    expect(report.summary.conflicts).toBe(0);
    expect(report.entries.map((entryReport) => entryReport.outcome)).toEqual([
      'ROLLED_BACK',
      'ROLLED_BACK',
    ]);
    // Pointers restored, caches invalidated once per post.
    expect(h.pointers.get('blog:1:en')).toBeNull();
    expect(h.pointers.get('blog:2:en')).toBeNull();
    expect(h.invalidations).toEqual([
      { entity: 'blog', ids: [2] },
      { entity: 'blog', ids: [1] },
    ]);
    // No object was uploaded or removed.
    expect(h.uploads).toEqual([]);
    expect(h.removes).toEqual([]);

    const records = (await h.journal.read()).records;
    const rollbackRecords = records.filter((record) => record.type === 'rollback');
    expect(rollbackRecords).toHaveLength(2);
    expect(rollbackRecords[0]).toMatchObject({ outcome: 'ROLLED_BACK', revalidation: null });
    // The invalidation is recorded separately, one event per post.
    const revalidations = records.filter((record) => record.type === 'revalidation');
    expect(revalidations).toHaveLength(2);
    expect(revalidations.every((record) => record.status === 'sent')).toBe(true);
  });

  it('reports a rollback conflict instead of forcing it', async () => {
    const one = '# one\n';
    const two = '# two\n';
    const journal = await journalWithSwitches([
      { postId: 1, body: one },
      { postId: 2, body: two },
    ]);
    const h = makeHarness({ journal, rollbackOutcome: 'STALE' });
    h.bodies.set('blog:1:en', one);
    h.bodies.set('blog:2:en', two);
    h.pointers.set('blog:1:en', `blog/1/en/${sha256Hex(Buffer.from(one, 'utf8'))}.md`);
    h.pointers.set('blog:2:en', `blog/2/en/${sha256Hex(Buffer.from(two, 'utf8'))}.md`);

    const candidates = await planRollback(h.deps, { runId: 'run-a' });
    const report = await executeRollback(h.deps, candidates);

    // Fail-fast: the first refused rollback stops the run, so the remaining
    // candidate is never attempted.
    expect(report.summary.failed).toBe(1);
    expect(report.stopped).toMatchObject({ postId: 2, state: 'READY' });
    expect(report.entries.map((entryReport) => entryReport.outcome)).toEqual(['STALE']);
    expect(h.invalidations).toEqual([]);
    expect(h.rollbackCalls).toHaveLength(1);
    const rollbackRecords = (await h.journal.read()).records.filter(
      (record) => record.type === 'rollback'
    );
    expect(rollbackRecords).toHaveLength(1);
    expect(rollbackRecords[0]).toMatchObject({ outcome: 'STALE', reason: 'body_changed' });
  });

  it('treats an already-recorded rollback as done when recovering from an interruption', async () => {
    const one = '# one\n';
    const two = '# two\n';
    const hashOf = (body: string) => sha256Hex(Buffer.from(body, 'utf8'));
    const journal = await journalWithSwitches([
      { postId: 1, body: one },
      { postId: 2, body: two },
    ]);
    // A previous rollback attempt completed entry 2 but not entry 1.
    await journal.append({
      type: 'rollback',
      runId: 'run-a',
      manifestDigest: 'manifest-1',
      kind: 'blog',
      postId: 2,
      locale: 'en',
      intendedPath: `blog/2/en/${hashOf(two)}.md`,
      installedPath: `blog/2/en/${hashOf(two)}.md`,
      restoredPath: null,
      outcome: 'ROLLED_BACK',
      reason: null,
      revalidation: 'sent',
      detail: null,
      at: '2026-10-18T10:05:00.000Z',
    });

    const h = makeHarness({ journal });
    h.bodies.set('blog:1:en', one);
    h.bodies.set('blog:2:en', two);
    h.pointers.set('blog:1:en', `blog/1/en/${hashOf(one)}.md`);
    h.pointers.set('blog:2:en', null);

    const candidates = await planRollback(h.deps, { runId: 'run-a' });
    expect(candidates.map((candidate) => [candidate.postId, candidate.state])).toEqual([
      [2, 'ALREADY_ROLLED_BACK'],
      [1, 'READY'],
    ]);

    const report = await executeRollback(h.deps, candidates);
    // Only the outstanding entry is rolled back.
    expect(report.summary.rolledBack).toBe(1);
    expect(h.rollbackCalls).toHaveLength(1);
  });
});

describe('operational gates', () => {
  it('requires an explicit run selection for apply', () => {
    const digest = 'a'.repeat(64);
    expect(parseExecArgs(['--apply', `--confirm-digest=${digest}`, '--expect-project-ref=dev'])).toEqual({
      mode: 'invalid',
      error: '--apply requires an explicit run selection: --new-run or --resume',
    });
    expect(
      parseExecArgs([
        '--apply',
        '--new-run',
        `--confirm-digest=${digest}`,
        '--expect-project-ref=dev',
      ])
    ).toEqual({
      mode: 'apply',
      runSelection: 'new',
      confirmDigest: digest,
      expectProjectRef: 'dev',
    });
    expect(
      parseExecArgs([
        '--apply',
        '--resume',
        `--confirm-digest=${digest}`,
        '--expect-project-ref=dev',
      ])
    ).toMatchObject({ mode: 'apply', runSelection: 'resume' });

    // A run flag without --apply is meaningless and refused.
    expect(parseExecArgs(['--preflight', '--resume']).mode).toBe('invalid');
    expect(parseExecArgs(['--apply', '--resume', '--new-run']).mode).toBe('invalid');
  });

  it('accepts only an approved local DEV revalidation destination', () => {
    expect(validateRevalidationEndpoint('http://localhost:3000/api/internal/content-revalidate')).toBeNull();
    expect(validateRevalidationEndpoint('http://127.0.0.1:3000/api/internal/content-revalidate')).toBeNull();
    expect(validateRevalidationEndpoint('http://[::1]:3000/api/internal/content-revalidate')).toBeNull();

    expect(validateRevalidationEndpoint('')).toMatch(/not configured/);
    expect(validateRevalidationEndpoint('nonsense')).toMatch(/not a valid URL/);
    expect(validateRevalidationEndpoint('ftp://localhost/x')).toMatch(/must be http/);
    expect(validateRevalidationEndpoint('https://okazakee.dev/api/internal/content-revalidate')).toMatch(
      /local DEV host/
    );
    expect(validateRevalidationEndpoint('https://www.okazakee.dev/x')).toMatch(/local DEV host/);
    expect(validateRevalidationEndpoint('http://localhost:3000/other')).toMatch(/path must be/);
  });

  it('defaults rollback to a read-only plan and gates execution', () => {
    expect(parseRollbackArgs([])).toEqual({ mode: 'plan', runId: undefined });
    expect(parseRollbackArgs(['--plan'])).toEqual({ mode: 'plan', runId: undefined });
    expect(parseRollbackArgs(['--run-id=run-a'])).toEqual({ mode: 'plan', runId: 'run-a' });
    expect(parseRollbackArgs(['--apply']).mode).toBe('invalid');
    expect(parseRollbackArgs(['--apply', '--expect-project-ref=dev'])).toEqual({
      mode: 'apply',
      runId: undefined,
      expectProjectRef: 'dev',
    });
    expect(parseRollbackArgs(['--apply', '--plan']).mode).toBe('invalid');
    expect(parseRollbackArgs(['--force']).mode).toBe('invalid');
    expect(ROLLBACK_ACK_ENV).toBe('CMS_BACKFILL_ROLLBACK_ACK');
    expect(ROLLBACK_ACK_VALUE).toBe('yes-rollback-dev-staging');
  });

  it('never writes while planning a rollback', async () => {
    const journal = createMemoryJournal();
    await journal.append(makeIntent({ postId: 21 }));
    await journal.append(makeOutcome({ postId: 21 }));
    const h = makeHarness({ journal });
    h.bodies.set('blog:21:en', HASH);
    h.pointers.set('blog:21:en', `blog/21/en/${HASH}.md`);

    const linesBefore = h.journal.lines.length;
    await planRollback(h.deps, { runId: 'run-a' });

    expect(h.casCalls).toEqual([]);
    expect(h.rollbackCalls).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.removes).toEqual([]);
    expect(h.invalidations).toEqual([]);
    expect(h.journal.lines).toHaveLength(linesBefore);
  });
});

describe('resume wiring', () => {
  it('revalidates an entry whose earlier run left an unresolved intent', async () => {
    const journal = createMemoryJournal();
    const body = '# interrupted before invalidation\n';
    const planned = entry('blog', 30, 'en', body);
    // A previous run switched the pointer and crashed before recording it.
    await journal.append({
      ...makeIntent({ postId: 30 }),
      intendedPath: planned.expectedPath as string,
      sourceSha256: planned.sourceSha256 as string,
    });

    const h = makeHarness({ journal });
    h.bodies.set('blog:30:en', body);
    h.objects.set(planned.expectedPath as string, Buffer.from(body, 'utf8'));
    h.pointers.set('blog:30:en', planned.expectedPath as string);

    const report = await executeBackfill(h.deps, [
      planEntry('blog', 30, 'en', body, planned.expectedPath),
    ]);

    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    // The unresolved intent forces the cache event even though nothing moved.
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [30] }]);
  });

  it('keeps a run.s entry key distinct in the audit for pending retries', async () => {
    const journal = createMemoryJournal();
    await journal.append(makeIntent({ postId: 31 }));
    await journal.append(makeOutcome({ postId: 31, revalidation: 'failed', outcome: 'REVALIDATION_FAILED' }));
    const records = (await journal.read()).records;
    const pending = pendingRevalidations(records);
    expect(pending).toHaveLength(1);
    expect(journalEntryKey(pending[0] as unknown as JournalOutcome)).toContain('run-a|manifest-1');
    expect(slotKey('blog', 31, 'en', `blog/31/en/${HASH}.md`)).toContain('blog|31|en');
  });
});

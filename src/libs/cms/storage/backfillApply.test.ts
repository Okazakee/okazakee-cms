import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sha256Hex,
  type BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';
import {
  planEntry,
  type BackfillPlanEntry,
} from '@/libs/cms/storage/backfillPlan';
import {
  APPLY_ACK_ENV,
  APPLY_ACK_VALUE,
  BACKFILL_OUTCOMES,
  executeBackfill,
  manifestDigest,
  parseExecArgs,
  rollbackEntry,
  type BackfillExecutorDeps,
} from '@/libs/cms/storage/backfillApply';
import {
  createMemoryJournal,
  parseJournalText,
  unresolvedIntents,
  type JournalRecord,
} from '@/libs/cms/storage/backfillJournal';
import type { BackfillCasApi, CasResult, PointerCasArgs, RollbackCasArgs } from '@/libs/cms/storage/backfillCas';
import {
  BACKFILL_CAS_FUNCTION,
  createBackfillCasApi,
  probeCasReadiness,
  validatePointerCasArgs,
  validateRollbackCasArgs,
  type CasRpcClient,
} from '@/libs/cms/storage/backfillCas';

/**
 * Executor tests: every dependency is injected, so the whole flow runs without
 * a network, a database or Storage. The fakes record what the executor asked
 * them to do, which is how "no mutation on a failure path" is proven rather
 * than asserted.
 */

const BODY_EN = '# blog 1 EN 🎉\r\n\r\nünïcodé ✓\r\n';
const BODY_IT = '# blog 1 IT à\n\ncorpo\n';
const SECRET = 'super-secret-service-key';

type StorageCalls = {
  uploads: string[];
  downloads: string[];
  removes: string[];
};

function fakeStorage(
  objects: Map<string, Buffer>,
  calls: StorageCalls,
  options: { failUpload?: string; failDownload?: string; alreadyExistsButDifferent?: boolean } = {}
): BodyContentStorageApi {
  return {
    async upload(path, body) {
      calls.uploads.push(path);
      if (options.failUpload) return { data: null, error: { message: options.failUpload } };
      if (objects.has(path) || options.alreadyExistsButDifferent) {
        if (options.alreadyExistsButDifferent) {
          objects.set(path, Buffer.from('# tampered object', 'utf8'));
        }
        return { data: null, error: { code: 'ResourceAlreadyExists', message: 'already exists' } };
      }
      objects.set(path, Buffer.from(body as Buffer));
      return { data: { path }, error: null };
    },
    async download(path) {
      calls.downloads.push(path);
      if (options.failDownload) return { data: null, error: { message: options.failDownload } };
      const found = objects.get(path);
      return found ? { data: found, error: null } : { data: null, error: { message: 'Object not found' } };
    },
    async remove(paths) {
      calls.removes.push(...paths);
      return { data: null, error: null };
    },
  };
}

type CasCalls = { pointer: PointerCasArgs[]; rollback: RollbackCasArgs[] };

function fakeCas(
  calls: CasCalls,
  results: {
    pointer?: CasResult | (() => CasResult | Promise<CasResult>);
    rollback?: CasResult | (() => CasResult | Promise<CasResult>);
    /** When false, an APPLIED result does not move the stored pointer. */
    applyPointer?: boolean;
  } = {},
  pointers: Map<string, string | null> = new Map()
): BackfillCasApi {
  return {
    async pointerCas(args) {
      // The real client validates locally; the fake must too, otherwise a
      // malformed call would silently look successful.
      const invalid = validatePointerCasArgs(args);
      if (invalid) throw new Error(`[backfill-cas] refusing pointer CAS: ${invalid}`);
      calls.pointer.push(args);

      if (results.pointer !== undefined) {
        const outcome = typeof results.pointer === 'function' ? await results.pointer() : results.pointer;
        if (outcome.outcome === 'APPLIED' && results.applyPointer !== false) {
          pointers.set(`${args.kind}:${args.postId}:${args.locale}`, args.newPath);
        }
        return outcome;
      }

      // Default behaviour mirrors the SQL guard: the pointer moves only when
      // the row still holds the expected previous pointer.
      const current = pointers.get(`${args.kind}:${args.postId}:${args.locale}`) ?? null;
      if (current !== args.expectedPrevious) {
        return { outcome: 'STALE', reason: 'pointer_drift' };
      }
      if (results.applyPointer !== false) {
        pointers.set(`${args.kind}:${args.postId}:${args.locale}`, args.newPath);
      }
      return { outcome: 'APPLIED', reason: null };
    },
    async pointerRollback(args) {
      const invalid = validateRollbackCasArgs(args);
      if (invalid) throw new Error(`[backfill-cas] refusing rollback CAS: ${invalid}`);
      calls.rollback.push(args);
      const next = results.rollback ?? { outcome: 'ROLLED_BACK', reason: null };
      const outcome = typeof next === 'function' ? await next() : next;
      if (outcome.outcome === 'ROLLED_BACK') {
        pointers.set(`${args.kind}:${args.postId}:${args.locale}`, args.previousPath);
      }
      return outcome;
    },
  };
}

type HarnessOptions = {
  db?: Map<string, string | null>;
  pointers?: Map<string, string | null>;
  objects?: Map<string, Buffer>;
  storage?: { failUpload?: string; failDownload?: string; alreadyExistsButDifferent?: boolean };
  cas?: { pointer?: CasResult | (() => CasResult | Promise<CasResult>); rollback?: CasResult; applyPointer?: boolean };
  revalidate?: 'sent' | 'failed' | 'skipped';
  journal?: ReturnType<typeof createMemoryJournal>;
  journalFailureOn?: (record: JournalRecord) => boolean;
};

function key(kind: string, postId: number, locale: string): string {
  return `${kind}:${postId}:${locale}`;
}

function harness(options: HarnessOptions = {}) {
  const db = options.db ?? new Map<string, string | null>();
  const pointers = options.pointers ?? new Map<string, string | null>();
  const objects = options.objects ?? new Map<string, Buffer>();
  const storageCalls: StorageCalls = { uploads: [], downloads: [], removes: [] };
  const casCalls: CasCalls = { pointer: [], rollback: [] };
  const invalidations: Array<{ entity: string; ids: number[] }> = [];
  const journal = options.journal ?? createMemoryJournal(() => new Date('2026-10-18T10:00:00.000Z'));

  const deps: BackfillExecutorDeps = {
    storage: fakeStorage(objects, storageCalls, options.storage ?? {}),
    cas: fakeCas(casCalls, options.cas ?? {}, pointers),
    readCommittedBody: async (kind, postId, locale) => db.get(key(kind, postId, locale)) ?? null,
    readCommittedPointer: async (kind, postId, locale) =>
      pointers.get(key(kind, postId, locale)) ?? null,
    invalidate: async (args) => {
      invalidations.push({ entity: args.entity, ids: args.ids });
      return options.revalidate ?? 'sent';
    },
    journal: {
      async append(record) {
        if (options.journalFailureOn?.(record)) {
          throw new Error('journal write interrupted');
        }
        await journal.append(record);
      },
      read: () => journal.read(),
    },
    now: () => new Date('2026-10-18T10:00:00.000Z'),
    newRunId: () => 'run-1',
  };

  return { deps, db, pointers, objects, storageCalls, casCalls, invalidations, journal };
}

function planEntryFor(
  kind: 'blog' | 'portfolio',
  postId: number,
  locale: 'en' | 'it',
  body: string | null,
  currentPath: string | null = null
): BackfillPlanEntry {
  return planEntry(kind, postId, locale, body, currentPath);
}

describe('executor: happy path', () => {
  it('uploads, verifies, switches the pointer atomically and revalidates once per post', async () => {
    const h = harness();
    h.db.set(key('blog', 1, 'en'), BODY_EN);
    h.db.set(key('blog', 1, 'it'), BODY_IT);

    const plan = [
      planEntryFor('blog', 1, 'en', BODY_EN),
      planEntryFor('blog', 1, 'it', BODY_IT),
    ];
    const report = await executeBackfill(h.deps, plan);

    expect(report.entries.map((e) => e.outcome)).toEqual([
      'UPLOADED_AND_POINTED',
      'UPLOADED_AND_POINTED',
    ]);
    expect(report.summary.pointerSwitches).toBe(2);
    expect(report.summary.uploadedObjects).toBe(2);
    expect(report.orphanCandidates).toEqual([]);
    expect(report.revalidationPending).toEqual([]);

    // Upload happened before the CAS, and the CAS carried the manifest hash
    // and the plan's expected previous pointer.
    const enPath = plan[0].expectedPath as string;
    const cas = h.casCalls.pointer[0];
    expect(h.storageCalls.uploads).toEqual([enPath, plan[1].expectedPath]);
    expect(cas.expectedSha256).toBe(sha256Hex(Buffer.from(BODY_EN, 'utf8')));
    expect(cas.expectedPrevious).toBeNull();
    expect(cas.newPath).toBe(enPath);

    // One signed invalidation for the post, not one per locale.
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [1] }]);

    // Journal: an intent before the upload and a terminal outcome after.
    const { records, tornTail, malformedLines } = await h.journal.read();
    expect(tornTail).toBe(false);
    expect(malformedLines).toBe(0);
    expect(records.filter((r) => r.type === 'intent')).toHaveLength(2);
    expect(records.filter((r) => r.type === 'outcome')).toHaveLength(2);
    expect(unresolvedIntents(records)).toEqual([]);

    // Nothing was deleted.
    expect(h.storageCalls.removes).toEqual([]);
  });

  it('reuses a byte-identical existing object without claiming it', async () => {
    const body = '# existing object\n';
    const entry = planEntryFor('blog', 2, 'en', body);
    const objects = new Map([[entry.expectedPath as string, Buffer.from(body, 'utf8')]]);
    const h = harness({ objects });
    h.db.set(key('blog', 2, 'en'), body);

    const report = await executeBackfill(h.deps, [entry]);

    expect(report.entries[0].outcome).toBe('UPLOADED_AND_POINTED');
    expect(report.entries[0].upload).toBe('existing');
    expect(report.entries[0].objectCreatedByRun).toBe(false);
    expect(report.summary.uploadedObjects).toBe(0);
  });

  it('is idempotent: an already-current entry is re-verified, never re-uploaded', async () => {
    const body = '# already current\n';
    const first = planEntryFor('blog', 3, 'en', body);
    const objects = new Map([[first.expectedPath as string, Buffer.from(body, 'utf8')]]);
    const h = harness({ objects });
    h.db.set(key('blog', 3, 'en'), body);
    h.pointers.set(key('blog', 3, 'en'), first.expectedPath);

    const current = planEntryFor('blog', 3, 'en', body, first.expectedPath);
    const report = await executeBackfill(h.deps, [current]);

    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    expect(report.summary.alreadyCurrent).toBe(1);
    expect(h.storageCalls.uploads).toEqual([]);
    expect(h.casCalls.pointer).toEqual([]);
    expect(h.storageCalls.downloads).toEqual([first.expectedPath]);
    expect(h.invalidations).toEqual([]);
  });
});

describe('executor: failure paths keep the committed state unchanged', () => {
  it('stops before upload when the committed body changed after planning', async () => {
    const h = harness();
    h.db.set(key('blog', 4, 'en'), '# body changed by a CMS user\n');
    const plan = [planEntryFor('blog', 4, 'en', BODY_EN)];

    const report = await executeBackfill(h.deps, plan);

    expect(report.entries[0].outcome).toBe('CAS_STALE');
    expect(report.entries[0].detail).toContain('changed after planning');
    expect(h.storageCalls.uploads).toEqual([]);
    expect(h.casCalls.pointer).toEqual([]);
    expect(report.orphanCandidates).toEqual([]);
  });

  it('reports CAS_STALE when the pointer moved after planning, keeping the object as an orphan candidate', async () => {
    const h = harness({ cas: { pointer: { outcome: 'STALE', reason: 'pointer_drift' } } });
    h.db.set(key('blog', 5, 'en'), BODY_EN);
    // The row already points somewhere else: the plan snapshot says NULL.
    h.pointers.set(key('blog', 5, 'en'), `blog/5/en/${'a'.repeat(64)}.md`);

    const report = await executeBackfill(h.deps, [planEntryFor('blog', 5, 'en', BODY_EN)]);

    expect(report.entries[0].outcome).toBe('CAS_STALE');
    expect(report.entries[0].detail).toContain('pointer_drift');
    expect(report.entries[0].cas).toBe('STALE');
    expect(report.entries[0].pointerVerified).toBe(false);
    expect(report.orphanCandidates).toHaveLength(1);
    // The uploaded object is tracked, never removed.
    expect(h.storageCalls.removes).toEqual([]);
  });

  it('reports CAS_MISSING when the committed body is gone', async () => {
    const h = harness();
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 6, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('CAS_MISSING');
    expect(h.storageCalls.uploads).toEqual([]);
  });

  it('reports MISSING from the CAS when the row disappeared at switch time', async () => {
    const h = harness({ cas: { pointer: { outcome: 'MISSING', reason: null } } });
    h.db.set(key('blog', 7, 'en'), BODY_EN);
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 7, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('CAS_MISSING');
    expect(report.orphanCandidates).toHaveLength(1);
  });

  it('reports UPLOAD_FAILED and never reaches the CAS', async () => {
    const h = harness({ storage: { failUpload: 'network exploded' } });
    h.db.set(key('blog', 8, 'en'), BODY_EN);
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 8, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('UPLOAD_FAILED');
    expect(report.entries[0].detail).toContain('network exploded');
    expect(h.casCalls.pointer).toEqual([]);
    expect(report.summary.failures).toBe(1);
  });

  it('reports VERIFY_FAILED when the download does not match the prepared bytes', async () => {
    const h = harness({ storage: { failDownload: 'storage read failed' } });
    h.db.set(key('blog', 9, 'en'), BODY_EN);
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 9, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('VERIFY_FAILED');
    expect(report.entries[0].upload).toBe('uploaded');
    expect(h.casCalls.pointer).toEqual([]);
    expect(report.orphanCandidates).toHaveLength(1);
  });

  it('treats a pre-existing object with different bytes as an integrity failure, not an upload failure', async () => {
    const h = harness({ storage: { alreadyExistsButDifferent: true } });
    h.db.set(key('blog', 10, 'en'), BODY_EN);
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 10, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('VERIFY_FAILED');
    expect(report.entries[0].detail).toContain('integrity failure');
    expect(h.casCalls.pointer).toEqual([]);
  });

  it('reports POINTER_VERIFY_FAILED when the CAS applied but the committed pointer differs', async () => {
    // The CAS reports APPLIED but the pointer never actually moved (e.g. an
    // external writer won the row): the confirmation read must catch it.
    const h = harness({ cas: { pointer: { outcome: 'APPLIED', reason: null }, applyPointer: false } });
    h.db.set(key('blog', 11, 'en'), BODY_EN);
    h.pointers.set(key('blog', 11, 'en'), `blog/11/en/${'b'.repeat(64)}.md`);

    const report = await executeBackfill(h.deps, [planEntryFor('blog', 11, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('POINTER_VERIFY_FAILED');
    expect(report.entries[0].pointerVerified).toBe(false);
    expect(report.revalidationPending).toEqual([]);
    expect(h.invalidations).toEqual([]);
  });

  it('reports CAS_REFUSED when the database refuses the CAS input', async () => {
    const h = harness({ cas: { pointer: { outcome: 'INVALID_ID', reason: null } } });
    h.db.set(key('blog', 12, 'en'), BODY_EN);
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 12, 'en', BODY_EN)]);
    expect(report.entries[0].outcome).toBe('CAS_REFUSED');
    expect(report.orphanCandidates).toHaveLength(1);
  });

  it('refuses a plan destination that is not canonical for the row', async () => {
    const h = harness();
    h.db.set(key('blog', 24, 'en'), BODY_EN);
    const entry = {
      ...planEntryFor('blog', 24, 'en', BODY_EN),
      expectedPath: `blog/24/it/${'a'.repeat(64)}.md`,
    };

    const report = await executeBackfill(h.deps, [entry]);

    expect(report.entries[0].outcome).toBe('VERIFY_FAILED');
    expect(report.entries[0].detail).toMatch(/does not match the manifest destination/);
    expect(h.storageCalls.uploads).toEqual([]);
    expect(h.casCalls.pointer).toEqual([]);
  });

  it('refuses to execute a plan that carries blockers', async () => {
    const h = harness();
    const blocked = planEntryFor('blog', 13, 'en', null, `blog/13/en/${'c'.repeat(64)}.md`);
    await expect(executeBackfill(h.deps, [blocked])).rejects.toThrow(/blocked plan/);
    expect(h.storageCalls.uploads).toEqual([]);
    expect(h.casCalls.pointer).toEqual([]);
  });

  it('never writes an object or a pointer for an empty locale', async () => {
    const h = harness();
    const report = await executeBackfill(h.deps, [planEntryFor('blog', 14, 'it', null)]);
    expect(report.entries).toEqual([]);
    expect(report.summary.entries).toBe(0);
    expect(h.storageCalls.uploads).toEqual([]);
    expect(h.casCalls.pointer).toEqual([]);
    expect(h.storageCalls.removes).toEqual([]);
  });
});

describe('executor: revalidation', () => {
  it('keeps a failed invalidation visible and retryable', async () => {
    const h = harness({ revalidate: 'failed' });
    h.db.set(key('blog', 15, 'en'), BODY_EN);
    h.db.set(key('blog', 15, 'it'), BODY_IT);

    const report = await executeBackfill(h.deps, [
      planEntryFor('blog', 15, 'en', BODY_EN),
      planEntryFor('blog', 15, 'it', BODY_IT),
    ]);

    expect(report.entries.map((e) => e.outcome)).toEqual([
      'REVALIDATION_FAILED',
      'REVALIDATION_FAILED',
    ]);
    expect(report.entries[0].pointerVerified).toBe(true);
    expect(report.revalidationPending).toEqual(['blog:15']);
    expect(report.summary.revalidationFailed).toBe(2);
    expect(h.invalidations).toEqual([{ entity: 'blog', ids: [15] }]);

    const { records } = await h.journal.read();
    const outcomes = records.filter((r) => r.type === 'outcome');
    expect(outcomes).toHaveLength(2);
    for (const record of outcomes) {
      expect(record).toMatchObject({ revalidation: 'failed', pointerVerified: true });
    }
  });

  it('does not invalidate when no pointer moved', async () => {
    const body = '# no movement\n';
    const entry = planEntryFor('blog', 16, 'en', body);
    const h = harness({ objects: new Map([[entry.expectedPath as string, Buffer.from(body, 'utf8')]]) });
    h.db.set(key('blog', 16, 'en'), body);
    h.pointers.set(key('blog', 16, 'en'), entry.expectedPath);

    const report = await executeBackfill(h.deps, [
      planEntryFor('blog', 16, 'en', body, entry.expectedPath),
    ]);
    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    expect(h.invalidations).toEqual([]);
  });
});

describe('executor: interruption and resume', () => {
  it('leaves an unresolved intent when the run is interrupted before the outcome is durable, and a re-run completes it', async () => {
    const body = '# interrupted run\n';
    const entry = planEntryFor('blog', 17, 'en', body);
    const objects = new Map<string, Buffer>();
    const journal = createMemoryJournal();
    const h = harness({
      objects,
      journal,
      journalFailureOn: (record) => record.type === 'outcome',
    });
    h.db.set(key('blog', 17, 'en'), body);

    await expect(executeBackfill(h.deps, [entry])).rejects.toThrow(/journal write interrupted/);

    // The object was uploaded and the pointer switched, but only the intent is
    // durable: the journal does not claim success.
    const interrupted = await journal.read();
    expect(interrupted.records.filter((r) => r.type === 'intent')).toHaveLength(1);
    expect(interrupted.records.filter((r) => r.type === 'outcome')).toHaveLength(0);
    expect(unresolvedIntents(interrupted.records)).toHaveLength(1);
    expect(h.pointers.get(key('blog', 17, 'en'))).toBe(entry.expectedPath);

    // Resume: the plan is rebuilt from the committed state, so the entry is now
    // already current and is byte-verified rather than re-uploaded.
    const resumed = harness({ objects, pointers: h.pointers });
    resumed.db.set(key('blog', 17, 'en'), body);
    const report = await executeBackfill(resumed.deps, [
      planEntryFor('blog', 17, 'en', body, entry.expectedPath),
    ]);
    expect(report.entries[0].outcome).toBe('ALREADY_CURRENT');
    expect(resumed.storageCalls.uploads).toEqual([]);
    expect(resumed.casCalls.pointer).toEqual([]);
  });

  it('recovers an upload that happened before the crash without a duplicate upload', async () => {
    const body = '# uploaded before crash\n';
    const entry = planEntryFor('blog', 18, 'en', body);
    const objects = new Map([[entry.expectedPath as string, Buffer.from(body, 'utf8')]]);
    const h = harness({ objects });
    h.db.set(key('blog', 18, 'en'), body);

    const report = await executeBackfill(h.deps, [entry]);

    expect(report.entries[0].outcome).toBe('UPLOADED_AND_POINTED');
    expect(report.entries[0].upload).toBe('existing');
    expect(h.storageCalls.uploads).toEqual([entry.expectedPath]);
    expect(objects.size).toBe(1);
  });

  it('does not trust a journal record over the database: a recorded success with a drifted pointer still fails', async () => {
    const body = '# recorded but stale\n';
    const entry = planEntryFor('blog', 19, 'en', body);
    const journal = createMemoryJournal();
    await journal.append({
      type: 'outcome',
      runId: 'previous-run',
      manifestDigest: manifestDigest([entry]),
      kind: 'blog',
      postId: 19,
      locale: 'en',
      previousPath: null,
      intendedPath: entry.expectedPath as string,
      sourceSha256: entry.sourceSha256 as string,
      outcome: 'UPLOADED_AND_POINTED',
      upload: 'uploaded',
      cas: 'APPLIED',
      casReason: null,
      pointerVerified: true,
      pointerSwitched: true,
      objectCreatedByRun: true,
      revalidation: 'sent',
      detail: null,
      at: new Date('2026-10-18T09:00:00.000Z').toISOString(),
    });

    const objects = new Map([[entry.expectedPath as string, Buffer.from(body, 'utf8')]]);
    const h = harness({ journal, objects });
    h.db.set(key('blog', 19, 'en'), body);
    h.pointers.set(key('blog', 19, 'en'), `blog/19/en/${'d'.repeat(64)}.md`);

    const report = await executeBackfill(h.deps, [planEntryFor('blog', 19, 'en', body)]);
    // The plan says NULL previous pointer, the row says otherwise: the CAS loses.
    expect(report.entries[0].outcome).toBe('CAS_STALE');
    expect(report.entries[0].pointerVerified).toBe(false);
  });
});

describe('executor: journal hygiene', () => {
  it('never records body content or credentials', async () => {
    const h = harness();
    h.db.set(key('blog', 20, 'en'), BODY_EN);
    await executeBackfill(h.deps, [planEntryFor('blog', 20, 'en', BODY_EN)]);

    const raw = h.journal.lines.join('');
    expect(raw).not.toContain('ünïcodé');
    expect(raw).not.toContain('# blog');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('SUPABASE');
    for (const line of h.journal.lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(parseJournalText(line).malformedLines).toBe(0);
    }
  });

  it('reports a torn tail instead of treating a partial record as complete', () => {
    const good = '{"type":"intent","runId":"r","manifestDigest":"m","kind":"blog","postId":1,"locale":"en","previousPath":null,"intendedPath":"blog/1/en/x.md","sourceSha256":"h","at":"t"}\n';
    const parsed = parseJournalText(`${good}{"type":"outcome","runId":"r"`);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.tornTail).toBe(true);
    expect(parsed.malformedLines).toBe(0);
  });

  it('counts malformed complete lines and never applies them', () => {
    const parsed = parseJournalText('not json\n{"type":"intent"}\n');
    expect(parsed.records).toEqual([]);
    expect(parsed.malformedLines).toBe(2);
    expect(parsed.tornTail).toBe(false);
  });
});

describe('executor: rollback wiring', () => {
  it('passes the recorded baseline to the rollback CAS', async () => {
    const h = harness({ cas: { rollback: { outcome: 'ROLLED_BACK', reason: null } } });
    const path = `blog/21/en/${'e'.repeat(64)}.md`;
    const result = await rollbackEntry(h.deps, {
      kind: 'blog',
      postId: 21,
      locale: 'en',
      installedPath: path,
      sourceSha256: 'f'.repeat(64),
      previousPath: null,
    });
    expect(result.outcome).toBe('ROLLED_BACK');
    expect(h.casCalls.rollback[0]).toMatchObject({ installedPath: path, previousPath: null });
  });

  it('returns a conflict instead of forcing a rollback', async () => {
    const stale = harness({ cas: { rollback: { outcome: 'STALE', reason: 'body_changed' } } });
    const result = await rollbackEntry(stale.deps, {
      kind: 'blog',
      postId: 21,
      locale: 'en',
      installedPath: `blog/21/en/${'e'.repeat(64)}.md`,
      sourceSha256: 'f'.repeat(64),
      previousPath: null,
    });
    expect(result).toEqual({ outcome: 'STALE', reason: 'body_changed' });

    const drift = harness({ cas: { rollback: { outcome: 'STALE', reason: 'pointer_drift' } } });
    const second = await rollbackEntry(drift.deps, {
      kind: 'blog',
      postId: 21,
      locale: 'en',
      installedPath: `blog/21/en/${'e'.repeat(64)}.md`,
      sourceSha256: 'f'.repeat(64),
      previousPath: null,
    });
    expect(second.reason).toBe('pointer_drift');
  });

  it('refuses a malformed rollback locally, before any call', async () => {
    const h = harness();
    await expect(
      rollbackEntry(h.deps, {
        kind: 'blog',
        postId: 21,
        locale: 'en',
        installedPath: 'not-canonical',
        sourceSha256: 'f'.repeat(64),
        previousPath: null,
      })
    ).rejects.toThrow(/refusing rollback CAS/);
    expect(h.casCalls.rollback).toEqual([]);
  });
});

describe('executor: manifest digest', () => {
  it('is stable for the same plan and changes with the plan', () => {
    const plan = [planEntryFor('blog', 22, 'en', BODY_EN)];
    expect(manifestDigest(plan)).toBe(manifestDigest([planEntryFor('blog', 22, 'en', BODY_EN)]));
    expect(manifestDigest(plan)).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestDigest(plan)).not.toBe(
      manifestDigest([planEntryFor('blog', 22, 'en', `${BODY_EN}!`)])
    );
    expect(manifestDigest(plan)).not.toBe(
      manifestDigest([planEntryFor('blog', 22, 'it', BODY_EN)])
    );
  });

  it('is the digest the report carries', async () => {
    const h = harness();
    h.db.set(key('blog', 23, 'en'), BODY_EN);
    const plan = [planEntryFor('blog', 23, 'en', BODY_EN)];
    const report = await executeBackfill(h.deps, plan);
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          [
            plan[0].kind,
            plan[0].postId,
            plan[0].locale,
            plan[0].sourceSha256,
            plan[0].sizeBytes,
            plan[0].expectedPath,
            plan[0].currentPath,
          ],
        ]),
        'utf8'
      )
      .digest('hex');
    expect(report.manifestDigest).toBe(expected);
  });
});

describe('CAS client: argument mapping, refusal and readiness', () => {
  const HASH = 'a'.repeat(64);
  const valid = {
    kind: 'blog' as const,
    postId: 1,
    locale: 'en' as const,
    expectedSha256: HASH,
    expectedPrevious: null,
    newPath: `blog/1/en/${HASH}.md`,
  };

  it('maps camelCase arguments to the SQL parameter names and parses the outcome row', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpc: CasRpcClient = {
      async rpc(fn, args) {
        calls.push({ fn, args });
        return { data: [{ outcome: 'APPLIED', reason: null }], error: null };
      },
    };
    const result = await createBackfillCasApi(rpc).pointerCas(valid);

    expect(result).toEqual({ outcome: 'APPLIED', reason: null });
    expect(calls[0].fn).toBe(BACKFILL_CAS_FUNCTION);
    expect(calls[0].args).toEqual({
      p_kind: 'blog',
      p_post_id: 1,
      p_locale: 'en',
      p_expected_sha256: HASH,
      p_expected_previous: null,
      p_new_path: valid.newPath,
    });
  });

  it('refuses malformed arguments locally, before any rpc call', async () => {
    let called = 0;
    const rpc: CasRpcClient = {
      async rpc() {
        called += 1;
        return { data: [], error: null };
      },
    };
    const api = createBackfillCasApi(rpc);

    await expect(
      api.pointerCas({ ...valid, postId: 0, newPath: `blog/0/en/${HASH}.md` })
    ).rejects.toThrow(/invalid post id/);
    await expect(
      api.pointerCas({ ...valid, locale: 'fr' as never, newPath: `blog/1/fr/${HASH}.md` })
    ).rejects.toThrow(/invalid locale/);
    await expect(
      api.pointerCas({ ...valid, kind: 'career' as never })
    ).rejects.toThrow(/invalid entity/);
    await expect(
      api.pointerCas({ ...valid, expectedSha256: 'short' })
    ).rejects.toThrow(/invalid expected sha256/);
    await expect(
      api.pointerCas({ ...valid, newPath: `portfolio/1/en/${HASH}.md` })
    ).rejects.toThrow(/not canonical/);
    await expect(
      api.pointerCas({ ...valid, expectedPrevious: `blog/2/en/${HASH}.md` })
    ).rejects.toThrow(/previous pointer is not canonical/);
    await expect(
      api.pointerRollback({
        kind: 'blog',
        postId: 1,
        locale: 'en',
        installedPath: 'not-canonical',
        expectedSha256: HASH,
        previousPath: null,
      })
    ).rejects.toThrow(/installed path is not canonical/);
    await expect(
      api.pointerRollback({
        kind: 'blog',
        postId: 1,
        locale: 'en',
        installedPath: valid.newPath,
        expectedSha256: HASH,
        previousPath: valid.newPath,
      })
    ).rejects.toThrow(/equals the installed pointer/);

    expect(called).toBe(0);
  });

  it('surfaces an rpc error and a missing outcome row', async () => {
    const erroring: CasRpcClient = {
      async rpc() {
        return { data: null, error: { message: 'function not found' } };
      },
    };
    await expect(createBackfillCasApi(erroring).pointerCas(valid)).rejects.toThrow(
      /function not found/
    );

    const empty: CasRpcClient = {
      async rpc() {
        return { data: [], error: null };
      },
    };
    await expect(createBackfillCasApi(empty).pointerCas(valid)).rejects.toThrow(
      /no outcome row/
    );
  });

  it('probes readiness with a call the SQL refuses before it can write', async () => {
    const ready: CasRpcClient = {
      async rpc(_fn, args) {
        // The probe must never be able to name a real entity.
        expect(args.p_kind).toBe('__probe__');
        return { data: [{ outcome: 'INVALID_ENTITY', reason: null }], error: null };
      },
    };
    expect(await probeCasReadiness(ready)).toEqual({ state: 'ready' });

    const missing: CasRpcClient = {
      async rpc() {
        return { data: null, error: { message: 'Could not find the function' } };
      },
    };
    expect((await probeCasReadiness(missing)).state).toBe('missing');

    const odd: CasRpcClient = {
      async rpc() {
        return { data: [{ outcome: 'APPLIED', reason: null }], error: null };
      },
    };
    expect((await probeCasReadiness(odd)).state).toBe('unexpected');
  });
});

describe('executor CLI arguments', () => {
  it('requires an explicit mode', () => {
    expect(parseExecArgs([])).toEqual({ mode: 'invalid', error: 'a mode is required (--preflight)' });
  });

  it('accepts preflight and its alias', () => {
    expect(parseExecArgs(['--preflight'])).toEqual({ mode: 'preflight' });
    expect(parseExecArgs(['--dry-run'])).toEqual({ mode: 'preflight' });
  });

  it('rejects unknown flags and conflicting modes', () => {
    for (const argv of [
      ['--preflight', '--unknown'],
      ['--apply', '--preflight'],
      ['--cleanup'],
      ['--rollback'],
      ['--yes'],
    ]) {
      const parsed = parseExecArgs(argv);
      expect(parsed.mode, argv.join(' ')).toBe('invalid');
    }
  });

  it('requires a digest and a project reference for --apply', () => {
    expect(parseExecArgs(['--apply']).mode).toBe('invalid');
    expect(parseExecArgs(['--apply', '--expect-project-ref=abc']).mode).toBe('invalid');
    expect(parseExecArgs(['--apply', '--confirm-digest=zz']).mode).toBe('invalid');
    expect(
      parseExecArgs([
        '--apply',
        `--confirm-digest=${'a'.repeat(64)}`,
        '--expect-project-ref=dev',
      ])
    ).toEqual({ mode: 'apply', confirmDigest: 'a'.repeat(64), expectProjectRef: 'dev' });
  });

  it('documents the operator acknowledgement required to arm an apply', () => {
    expect(APPLY_ACK_ENV).toBe('CMS_BACKFILL_APPLY_ACK');
    expect(APPLY_ACK_VALUE).toBe('yes-apply-to-dev-staging');
  });

  it('exposes the outcome vocabulary it reports', () => {
    expect(BACKFILL_OUTCOMES).toContain('UPLOADED_AND_POINTED');
    expect(BACKFILL_OUTCOMES).toContain('CAS_STALE');
    expect(BACKFILL_OUTCOMES).toContain('REVALIDATION_FAILED');
    expect(new Set(BACKFILL_OUTCOMES).size).toBe(BACKFILL_OUTCOMES.length);
  });
});

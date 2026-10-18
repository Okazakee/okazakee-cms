/**
 * Markdown body backfill executor (Phase 11B.1; recovery hardened in 11B.2) —
 * DEV only.
 *
 * Drives the reviewed plan entry by entry, in the plan's deterministic order,
 * and keeps upload success strictly separate from pointer success:
 *
 *   1. read the COMMITTED legacy body and re-check it against the manifest
 *      SHA-256 (a CMS edit after planning stops the entry here, before upload);
 *   2. prepare the canonical immutable object from that committed text;
 *   3. upload with `upsert: false` (or byte-verify the identical existing key);
 *   4. download the object and verify exact bytes AND the SHA-256;
 *   5. atomic CAS: the pointer moves only inside the SQL guard (body hash +
 *      previous pointer), never from a stale read;
 *   6. re-read the committed pointer to confirm the switch;
 *   7. group by post and send ONE signed revalidation event per post.
 *
 * A verified pointer switch whose invalidation did not return `sent` is
 * incomplete work: it is reported as REVALIDATION_FAILED, journalled, and left
 * retryable across process invocations (`retryPendingRevalidations`).
 *
 * Interruptions are recoverable in every window: before upload, after upload
 * before the CAS, after the CAS before the outcome is durable, and after the
 * switch before the invalidation. Recovery always re-reads the database and
 * re-verifies Storage; the journal never proves a completed migration.
 *
 * Nothing here deletes: an object that exists without a pointer is reported as
 * an orphan candidate and left alone. Markdown is never rewritten — the bytes
 * come from the committed column, so Unicode, newlines and image URLs are
 * preserved exactly.
 */
import {
  prepareBodyContent,
  readBodyContentBytes,
  sha256Hex,
  uploadBodyContent,
  type BodyContentKind,
  type BodyContentLocale,
  type BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';
import type { BackfillCasApi, CasOutcome } from '@/libs/cms/storage/backfillCas';
import type { BackfillPlanEntry } from '@/libs/cms/storage/backfillPlan';
import {
  isSuccessfulOutcome,
  journalEntryKey,
  journalEntrySlot,
  recordedManifest,
  unresolvedIntents,
  type BackfillJournal,
  type BackfillRunOutcome,
  type JournalManifest,
  type JournalManifestEntry,
  type JournalOutcome,
  type JournalRecord,
  type JournalRevalidationStatus,
  type JournalRollback,
  type JournalUploadStatus,
  type PendingRevalidation,
  type PendingRollbackRevalidation,
} from '@/libs/cms/storage/backfillJournal';

export type RevalidationStatus = 'sent' | 'skipped' | 'failed';

export type BackfillEntryReport = {
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  intendedPath: string;
  previousPath: string | null;
  sourceSha256: string;
  outcome: BackfillRunOutcome;
  /** Short non-sensitive explanation; never body content. */
  detail: string | null;
  upload: JournalUploadStatus;
  cas: CasOutcome | null;
  casReason: string | null;
  pointerVerified: boolean;
  /** 1-based attempt ordinal this report describes (0 when not attempted). */
  attempt: number;
  /** True only when THIS run's CAS moved the pointer (drives revalidation). */
  pointerSwitched: boolean;
  /** True only when THIS run performed the upload (never inferred from existence). */
  objectCreatedByRun: boolean;
  revalidation: JournalRevalidationStatus | null;
};

export type BackfillRunReport = {
  runId: string;
  manifestDigest: string;
  entries: BackfillEntryReport[];
  /** Objects that exist but are not referenced by any committed pointer. Never deleted here. */
  orphanCandidates: string[];
  /** Posts whose pointer moved but whose signed revalidation is not acknowledged. */
  revalidationPending: string[];
  /** Set when fail-fast stopped the run: the entry that failed. */
  stopped: {
    kind: BodyContentKind;
    postId: number;
    locale: BodyContentLocale;
    outcome: BackfillRunOutcome;
    detail: string | null;
  } | null;
  /** Entries not attempted because the run stopped (in plan order). */
  remaining: Array<{
    kind: BodyContentKind;
    postId: number;
    locale: BodyContentLocale;
    expectedPath: string;
  }>;
  summary: {
    entries: number;
    byOutcome: Record<BackfillRunOutcome, number>;
    pointerSwitches: number;
    uploadedObjects: number;
    alreadyCurrent: number;
    failures: number;
    revalidationFailed: number;
  };
};

export type BackfillExecutorDeps = {
  storage: BodyContentStorageApi;
  cas: BackfillCasApi;
  /** Committed legacy body for one locale, read from the database at execution time. */
  readCommittedBody(
    kind: BodyContentKind,
    postId: number,
    locale: BodyContentLocale
  ): Promise<string | null>;
  /** Committed pointer for one locale (used to confirm a switch, never to decide one). */
  readCommittedPointer(
    kind: BodyContentKind,
    postId: number,
    locale: BodyContentLocale
  ): Promise<string | null>;
  /** Signed public-site revalidation (the existing contract's client). */
  invalidate(args: {
    entity: BodyContentKind;
    operation: 'publish';
    ids: number[];
  }): Promise<RevalidationStatus>;
  journal: BackfillJournal;
  now(): Date;
  newRunId(): string;
};

export const BACKFILL_OUTCOMES: BackfillRunOutcome[] = [
  'UPLOADED_AND_POINTED',
  'ALREADY_CURRENT',
  'SKIPPED_EMPTY',
  'UPLOAD_FAILED',
  'VERIFY_FAILED',
  'CAS_STALE',
  'CAS_MISSING',
  'CAS_REFUSED',
  'POINTER_VERIFY_FAILED',
  'REVALIDATION_FAILED',
];

/** Whether an invalidation result leaves the entry incomplete. */
export function isIncompleteRevalidation(status: JournalRevalidationStatus): boolean {
  return status === 'failed' || status === 'skipped';
}

/**
 * Stable digest of a plan: entity, id, locale, source hash, size, destination
 * and the pointer the switch expects. Used by the apply gate so an operator
 * confirms the exact plan that was reviewed.
 */
export function manifestDigest(entries: BackfillPlanEntry[]): string {
  const canonical = entries.map((entry) => [
    entry.kind,
    entry.postId,
    entry.locale,
    entry.sourceSha256,
    entry.sizeBytes,
    entry.expectedPath,
    entry.currentPath,
  ]);
  return sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function postKey(kind: BodyContentKind, postId: number): string {
  return `${kind}:${postId}`;
}

function isFailure(outcome: BackfillRunOutcome): boolean {
  return (
    outcome === 'UPLOAD_FAILED' ||
    outcome === 'VERIFY_FAILED' ||
    outcome === 'CAS_STALE' ||
    outcome === 'CAS_MISSING' ||
    outcome === 'CAS_REFUSED' ||
    outcome === 'POINTER_VERIFY_FAILED' ||
    outcome === 'REVALIDATION_FAILED'
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The immutable execution identity of a run. It is recorded in the journal
 * BEFORE the first mutation and is what a resume and a rollback work from: a
 * digest recomputed after the first switch would classify that entry
 * ALREADY_CURRENT and no longer match the run.
 */
export type ExecutionManifest = {
  runId: string;
  manifestDigest: string;
  entries: JournalManifestEntry[];
};

/** Builds the immutable manifest for a plan about to be executed. */
export function executionManifest(
  runId: string,
  plan: BackfillPlanEntry[]
): ExecutionManifest {
  return {
    runId,
    manifestDigest: manifestDigest(plan),
    // Skipped locales are not work: the manifest lists exactly the entries a
    // completed run must produce an outcome for.
    entries: plan
      .filter((entry) => entry.action !== 'SKIP_EMPTY' && entry.expectedPath !== null)
      .map((entry) => ({
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        sourceSha256: entry.sourceSha256 ?? '',
        sizeBytes: entry.sizeBytes,
        expectedPath: entry.expectedPath as string,
        previousPath: entry.currentPath,
      })),
  };
}

/**
 * Rebuilds work from the recorded manifest, classified against the CURRENT
 * committed pointer for each entry: an entry whose pointer already holds the
 * recorded destination is verify-only, everything else is attempted (the CAS
 * still guards against a stale source or a moved pointer).
 */
export function planFromManifest(
  manifest: JournalManifest,
  observedPointers: Array<string | null>
): BackfillPlanEntry[] {
  return manifest.entries.map((entry, index) => ({
    kind: entry.kind as BodyContentKind,
    postId: entry.postId,
    locale: entry.locale as BodyContentLocale,
    sourceSha256: entry.sourceSha256,
    sizeBytes: entry.sizeBytes,
    expectedPath: entry.expectedPath,
    currentPath: entry.previousPath,
    action: observedPointers[index] === entry.expectedPath ? 'ALREADY_CURRENT' : 'UPLOAD_AND_POINT',
    blockers: [],
  }));
}

/**
 * Executes a plan. Throws before doing anything when the plan itself carries a
 * blocker: a blocked plan is never partially applied.
 *
 * `failFast` (the default) stops at the first unexpected failure: later entries
 * are not attempted, the already-committed pointer changes are preserved, the
 * audit for everything observed is flushed, and the report names the stopped
 * entry and the remaining work. Nothing is rolled back and nothing is deleted.
 */
export async function executeBackfill(
  deps: BackfillExecutorDeps,
  plan: BackfillPlanEntry[],
  options: {
    runId?: string;
    revalidate?: boolean;
    failFast?: boolean;
    /** Immutable identity to execute under (required for a resume). */
    manifest?: ExecutionManifest;
  } = {}
): Promise<BackfillRunReport> {
  const blocked = plan.filter((entry) => entry.action === 'BLOCKED');
  if (blocked.length > 0) {
    throw new Error(
      `[backfill-exec] refusing to execute a blocked plan (${blocked.length} blocked entries)`
    );
  }

  const runId = options.runId ?? deps.newRunId();
  const revalidate = options.revalidate ?? true;
  const failFast = options.failFast ?? true;
  const digest = options.manifest?.manifestDigest ?? manifestDigest(plan);
  const reports: BackfillEntryReport[] = [];
  const orphanCandidates = new Set<string>();
  const revalidationPending = new Set<string>();
  let stopped: BackfillRunReport['stopped'] = null;
  let remainingFrom = plan.length;

  const toStop = (report: BackfillEntryReport): NonNullable<BackfillRunReport['stopped']> => ({
    kind: report.kind,
    postId: report.postId,
    locale: report.locale,
    outcome: report.outcome,
    detail: report.detail,
  });

  // Entries an earlier interrupted run left unresolved: the journal is not
  // trusted for the decision, but it tells us that this post may already have
  // been switched without its cache being invalidated.
  const priorUnresolved = new Set(
    unresolvedIntents((await deps.journal.read()).records).map((intent) =>
      journalEntrySlot(intent)
    )
  );

  // Latest recorded outcome per entry identity: the attempt ordinal to use for
  // a retry, and whether the entry is already done.
  const priorOutcomeState = new Map<string, { attempt: number; success: boolean }>();
  for (const record of (await deps.journal.read()).records) {
    if (record.type !== 'outcome') continue;
    const key = journalEntryKey(record);
    const previous = priorOutcomeState.get(key);
    if (!previous || record.attempt >= previous.attempt) {
      priorOutcomeState.set(key, {
        attempt: record.attempt,
        success: isSuccessfulOutcome(record.outcome),
      });
    }
  }

  /** Runs the signed revalidation for one post and applies the result to its entries. */
  const flushPost = async (group: BackfillEntryReport[]): Promise<void> => {
    if (group.length === 0) return;
    const needsRevalidation = group.some(
      (entry) =>
        entry.pointerSwitched ||
        priorUnresolved.has(journalEntrySlot(entry))
    );
    if (!needsRevalidation) {
      for (const entry of group) entry.revalidation = null;
      return;
    }
    if (!revalidate) {
      // No attempt was made (dry run): nothing is claimed and nothing pending.
      for (const entry of group) entry.revalidation = null;
      return;
    }

    const status = await deps.invalidate({
      entity: group[0].kind,
      operation: 'publish',
      ids: [group[0].postId],
    });

    for (const entry of group) {
      entry.revalidation = status;
      await deps.journal.append({
        type: 'revalidation',
        runId,
        manifestDigest: digest,
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        intendedPath: entry.intendedPath,
        status,
        observedPointer: entry.pointerVerified ? entry.intendedPath : null,
        detail: null,
        at: deps.now().toISOString(),
      });
      if (!entry.pointerVerified) continue;
      if (isIncompleteRevalidation(status)) {
        entry.outcome = 'REVALIDATION_FAILED';
        entry.detail = `pointer switched but signed revalidation is ${status}`;
        revalidationPending.add(postKey(entry.kind, entry.postId));
      }
    }
  };

  let currentPost = '';
  let group: BackfillEntryReport[] = [];

  const recordOutcome = async (report: BackfillEntryReport): Promise<void> => {
    const identityKey = journalEntryKey({
      runId,
      manifestDigest: digest,
      kind: report.kind,
      postId: report.postId,
      locale: report.locale,
      intendedPath: report.intendedPath,
    });
    // Already-done entries are re-verified but never re-recorded; a failed
    // attempt is followed by a NEW attempt ordinal, so the retry is auditable
    // without contradicting the failure it superseded.
    if (priorOutcomeState.get(identityKey)?.success) return;
    const record: JournalRecord = {
      type: 'outcome',
      attempt: report.attempt,
      runId,
      manifestDigest: digest,
      kind: report.kind,
      postId: report.postId,
      locale: report.locale,
      previousPath: report.previousPath,
      intendedPath: report.intendedPath,
      sourceSha256: report.sourceSha256,
      outcome: report.outcome,
      upload: report.upload,
      cas: report.cas,
      casReason: report.casReason,
      pointerVerified: report.pointerVerified,
      pointerSwitched: report.pointerSwitched,
      objectCreatedByRun: report.objectCreatedByRun,
      revalidation: report.revalidation,
      detail: report.detail,
      at: deps.now().toISOString(),
    };
    await deps.journal.append(record);
    priorOutcomeState.set(identityKey, {
      attempt: report.attempt,
      success: isSuccessfulOutcome(report.outcome),
    });
  };

  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    if (entry.action === 'SKIP_EMPTY') {
      continue;
    }

    // Flush the previous post's group before moving on (entries are ordered by
    // post, so EN/IT of one post are revalidated with a single event).
    const key = postKey(entry.kind, entry.postId);
    if (key !== currentPost && group.length > 0) {
      await flushPost(group);
      for (const report of group) await recordOutcome(report);
      const flushedFailure = failFast
        ? group.find((report) => isFailure(report.outcome))
        : undefined;
      group = [];
      if (flushedFailure) {
        // The post just finished could not be invalidated: stop before any
        // further mutation rather than continuing on a stale public cache.
        stopped = toStop(flushedFailure);
        remainingFrom = index;
        break;
      }
    }
    currentPost = key;

    const report: BackfillEntryReport = {
      kind: entry.kind,
      postId: entry.postId,
      locale: entry.locale,
      intendedPath: entry.expectedPath ?? '',
      previousPath: entry.currentPath,
      sourceSha256: entry.sourceSha256 ?? '',
      outcome: 'ALREADY_CURRENT',
      detail: null,
      upload: 'skipped',
      cas: null,
      casReason: null,
      pointerVerified: false,
      attempt: 0,
      pointerSwitched: false,
      objectCreatedByRun: false,
      revalidation: null,
    };

    if (entry.expectedPath === null || entry.sourceSha256 === null) {
      continue;
    }

    const identity = {
      runId,
      manifestDigest: digest,
      kind: entry.kind,
      postId: entry.postId,
      locale: entry.locale,
      intendedPath: entry.expectedPath,
    };
    const prior = priorOutcomeState.get(journalEntryKey(identity));
    const attempt = prior ? prior.attempt + 1 : 1;
    report.attempt = attempt;

    if (!prior?.success) {
      // A retry after a recorded failure is a new attempt; an entry that
      // already succeeded is only re-verified, never rewritten.
      await deps.journal.append({
        type: 'intent',
        ...identity,
        attempt,
        previousPath: entry.currentPath,
        sourceSha256: entry.sourceSha256,
        at: deps.now().toISOString(),
      });
    }

    try {
      if (entry.action === 'ALREADY_CURRENT') {
        // Never trust the recorded state: re-verify the object bytes AND the
        // committed pointer. A pointer that no longer holds this key is an
        // explicit failure, never a successful outcome.
        try {
          const bytes = await readBodyContentBytes(deps.storage, entry.expectedPath);
          if (sha256Hex(bytes) !== entry.sourceSha256) {
            report.outcome = 'VERIFY_FAILED';
            report.detail = 'existing object bytes do not match the manifest hash';
          } else {
            const pointer = await deps.readCommittedPointer(
              entry.kind,
              entry.postId,
              entry.locale
            );
            if (pointer === entry.expectedPath) {
              report.outcome = 'ALREADY_CURRENT';
              report.pointerVerified = true;
            } else {
              report.outcome = 'POINTER_VERIFY_FAILED';
              report.detail =
                'object matches but the committed pointer does not hold this key';
            }
          }
        } catch (error) {
          report.outcome = 'VERIFY_FAILED';
          report.detail = errorDetail(error);
        }
      } else {
        // 1. committed body, re-checked against the manifest
        const committed = await deps.readCommittedBody(entry.kind, entry.postId, entry.locale);
        if (committed === null) {
          report.outcome = 'CAS_MISSING';
          report.detail = 'committed legacy body is missing';
        } else if (sha256Hex(Buffer.from(committed, 'utf8')) !== entry.sourceSha256) {
          report.outcome = 'CAS_STALE';
          report.detail = 'committed legacy body changed after planning';
        } else {
          // 2. prepare from the committed bytes (identical to the plan's)
          const prepared = prepareBodyContent(
            entry.kind,
            entry.postId,
            entry.locale,
            committed
          );
          if (prepared.path !== entry.expectedPath) {
            report.outcome = 'VERIFY_FAILED';
            report.detail = 'prepared key does not match the manifest destination';
          } else {
            // 3. immutable upload (or the byte-identical existing object)
            try {
              const uploaded = await uploadBodyContent(deps.storage, prepared);
              report.upload = uploaded.status === 'uploaded' ? 'uploaded' : 'existing';
              report.objectCreatedByRun = uploaded.status === 'uploaded';
            } catch (error) {
              const detail = errorDetail(error);
              report.upload = 'failed';
              // A pre-existing object whose bytes differ is an integrity
              // failure, not a transport/upload failure.
              report.outcome = /integrity failure/.test(detail)
                ? 'VERIFY_FAILED'
                : 'UPLOAD_FAILED';
              report.detail = detail;
            }

            // 4. download and verify exact bytes + hash
            if (report.outcome !== 'UPLOAD_FAILED' && report.outcome !== 'VERIFY_FAILED') {
              try {
                const bytes = await readBodyContentBytes(deps.storage, prepared.path);
                if (!bytes.equals(prepared.bytes) || sha256Hex(bytes) !== entry.sourceSha256) {
                  report.outcome = 'VERIFY_FAILED';
                  report.detail = 'downloaded object does not match the prepared bytes';
                }
              } catch (error) {
                report.outcome = 'VERIFY_FAILED';
                report.detail = errorDetail(error);
              }
            }

            // 5. atomic CAS
            if (report.outcome !== 'UPLOAD_FAILED' && report.outcome !== 'VERIFY_FAILED') {
              const cas = await deps.cas.pointerCas({
                kind: entry.kind,
                postId: entry.postId,
                locale: entry.locale,
                expectedSha256: entry.sourceSha256,
                expectedPrevious: entry.currentPath,
                newPath: prepared.path,
              });
              report.cas = cas.outcome;
              report.casReason = cas.reason;

              if (cas.outcome === 'APPLIED' || cas.outcome === 'ALREADY_CURRENT') {
                // 6. confirm the committed pointer
                const pointer = await deps.readCommittedPointer(
                  entry.kind,
                  entry.postId,
                  entry.locale
                );
                if (pointer === prepared.path) {
                  report.outcome = 'UPLOADED_AND_POINTED';
                  report.pointerVerified = true;
                  // Only a CAS that actually moved the pointer needs a cache
                  // invalidation; ALREADY_CURRENT was already in place.
                  report.pointerSwitched = cas.outcome === 'APPLIED';
                } else {
                  report.outcome = 'POINTER_VERIFY_FAILED';
                  report.detail = 'CAS reported success but the committed pointer differs';
                }
              } else if (cas.outcome === 'STALE') {
                report.outcome = 'CAS_STALE';
                report.detail = `CAS lost: ${cas.reason ?? 'stale'}`;
              } else if (cas.outcome === 'MISSING') {
                report.outcome = 'CAS_MISSING';
                report.detail = 'row missing at CAS time';
              } else {
                report.outcome = 'CAS_REFUSED';
                report.detail = `CAS refused: ${cas.outcome}`;
              }
            }
          }
        }
      }
    } catch (error) {
      report.outcome = 'VERIFY_FAILED';
      report.detail = errorDetail(error);
    }

    // An object that exists without a committed pointer is a candidate orphan:
    // reported, never removed.
    if (!report.pointerVerified && report.upload !== 'skipped' && report.upload !== 'failed') {
      orphanCandidates.add(report.intendedPath);
    }

    reports.push(report);
    group.push(report);

    if (failFast && isFailure(report.outcome)) {
      stopped = toStop(report);
      remainingFrom = index + 1;
      break;
    }
  }

  if (group.length > 0) {
    await flushPost(group);
    for (const report of group) await recordOutcome(report);
    if (!stopped && failFast) {
      const flushedFailure = group.find((report) => isFailure(report.outcome));
      if (flushedFailure) {
        stopped = toStop(flushedFailure);
        remainingFrom = plan.length;
      }
    }
  }

  const byOutcome = Object.fromEntries(
    BACKFILL_OUTCOMES.map((outcome) => [outcome, 0])
  ) as Record<BackfillRunOutcome, number>;
  for (const report of reports) byOutcome[report.outcome] += 1;

  return {
    runId,
    manifestDigest: digest,
    entries: reports,
    orphanCandidates: [...orphanCandidates].sort(),
    revalidationPending: [...revalidationPending].sort(),
    stopped,
    remaining: plan
      .slice(remainingFrom)
      .filter((entry) => entry.action !== 'SKIP_EMPTY')
      .map((entry) => ({
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        expectedPath: entry.expectedPath ?? '',
      })),
    summary: {
      entries: reports.length,
      byOutcome,
      pointerSwitches: reports.filter((r) => r.pointerSwitched).length,
      uploadedObjects: reports.filter((r) => r.objectCreatedByRun).length,
      alreadyCurrent: byOutcome.ALREADY_CURRENT,
      failures: reports.filter((r) => isFailure(r.outcome)).length,
      revalidationFailed: byOutcome.REVALIDATION_FAILED,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Pending invalidation retry                                                  */
/* -------------------------------------------------------------------------- */

export type RevalidationRetryOutcome = 'REVALIDATED' | 'SUPERSEDED' | 'FAILED' | 'MISSING';

export type RevalidationRetryReport = {
  kind: string;
  postId: number;
  locale: string;
  intendedPath: string;
  outcome: RevalidationRetryOutcome;
  status: JournalRevalidationStatus | null;
  observedPointer: string | null;
  detail: string | null;
};

/**
 * Retries invalidations the journal still holds as pending: a previous run
 * switched the pointer but the public cache was never acknowledged (the WS was
 * unreachable, the event failed, or it was skipped).
 *
 * It never uploads and never rewrites a pointer: the committed pointer is
 * re-read and must still hold the key this run installed. When it does not, the
 * row has moved on and whatever changed it owns that cache, so the entry is
 * recorded as `superseded` instead of being retried. Entries are grouped by
 * post so EN/IT send a single event.
 */
export async function retryPendingRevalidations(
  deps: Pick<
    BackfillExecutorDeps,
    'readCommittedPointer' | 'invalidate' | 'journal' | 'now'
  >,
  pending: PendingRevalidation[]
): Promise<RevalidationRetryReport[]> {
  const reports: RevalidationRetryReport[] = [];
  const groups = new Map<string, PendingRevalidation[]>();
  for (const entry of pending) {
    const key = `${entry.runId}|${entry.manifestDigest}|${entry.kind}|${entry.postId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    // Each locale has its own pointer: compare per entry, never one locale's
    // value against another's key.
    const observed = await Promise.all(
      group.map(async (entry) => ({
        entry,
        pointer: await deps.readCommittedPointer(
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        ),
      }))
    );
    const allMatch = observed.every(({ entry, pointer }) => pointer === entry.intendedPath);

    if (!allMatch) {
      for (const { entry, pointer } of observed) {
        const status: JournalRevalidationStatus = 'superseded';
        await deps.journal.append({
          type: 'revalidation',
          runId: entry.runId,
          manifestDigest: entry.manifestDigest,
          kind: entry.kind,
          postId: entry.postId,
          locale: entry.locale,
          intendedPath: entry.intendedPath,
          status,
          observedPointer: pointer,
          detail: 'committed pointer no longer holds the migrated key',
          at: deps.now().toISOString(),
        });
        reports.push({
          kind: entry.kind,
          postId: entry.postId,
          locale: entry.locale,
          intendedPath: entry.intendedPath,
          outcome: 'SUPERSEDED',
          status,
          observedPointer: pointer,
          detail: 'committed pointer no longer holds the migrated key',
        });
      }
      continue;
    }

    const status = await deps.invalidate({
      entity: first.kind as BodyContentKind,
      operation: 'publish',
      ids: [first.postId],
    });
    const outcome: RevalidationRetryOutcome = status === 'sent' ? 'REVALIDATED' : 'FAILED';

    for (const { entry, pointer } of observed) {
      await deps.journal.append({
        type: 'revalidation',
        runId: entry.runId,
        manifestDigest: entry.manifestDigest,
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        intendedPath: entry.intendedPath,
        status,
        observedPointer: pointer,
        detail: null,
        at: deps.now().toISOString(),
      });
      reports.push({
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        intendedPath: entry.intendedPath,
        outcome,
        status,
        observedPointer: pointer,
        detail: null,
      });
    }
  }

  return reports;
}

/* -------------------------------------------------------------------------- */
/* Rollback                                                                    */
/* -------------------------------------------------------------------------- */

export type RollbackCandidateState =
  | 'READY'
  | 'ALREADY_ROLLED_BACK'
  | 'MISSING'
  | 'POINTER_DRIFTED'
  | 'BODY_CHANGED';

export type RollbackCandidate = {
  runId: string;
  manifestDigest: string;
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  installedPath: string;
  previousPath: string | null;
  sourceSha256: string;
  state: RollbackCandidateState;
  observedPointer: string | null;
  detail: string | null;
};

export type RollbackDeps = Pick<
  BackfillExecutorDeps,
  'cas' | 'readCommittedBody' | 'readCommittedPointer' | 'invalidate' | 'journal' | 'now'
>;

/**
 * Builds rollback candidates from the verified execution record (never from a
 * fresh plan digest, which after a successful backfill describes the migrated
 * state rather than the original one) plus the CURRENT database state.
 *
 * Candidates come only from entries whose switch this journal verified
 * (`pointerSwitched`), in reverse migration order, and each is classified
 * against the live row: the committed pointer must still be the key the run
 * installed and the committed body must still hash to the recorded source.
 * Nothing is written.
 */
export async function planRollback(
  deps: RollbackDeps,
  selection: { runId?: string; manifestDigest?: string } = {}
): Promise<RollbackCandidate[]> {
  const { records } = await deps.journal.read();

  // Candidate identities come from the immutable manifest when one is recorded
  // (it survives an interruption that never wrote an outcome) plus any outcome
  // record that actually witnessed a switch.
  const manifestLookup = recordedManifest(records, selection.runId);
  const manifestDigestOf = manifestLookup.ok ? manifestLookup.manifest.manifestDigest : null;
  const manifestRunId = manifestLookup.ok ? manifestLookup.manifest.runId : null;
  const ordered: JournalManifestEntry[] = [];
  const seen = new Set<string>();
  if (manifestLookup.ok) {
    for (const entry of manifestLookup.manifest.entries) {
      const key = `${entry.kind}|${entry.postId}|${entry.locale}|${entry.expectedPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(entry);
    }
  }
  const switched = records.filter(
    (record): record is JournalOutcome => record.type === 'outcome' && record.pointerSwitched
  );
  for (const record of switched) {
    const key = `${record.kind}|${record.postId}|${record.locale}|${record.intendedPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({
      kind: record.kind,
      postId: record.postId,
      locale: record.locale,
      sourceSha256: record.sourceSha256,
      sizeBytes: 0,
      expectedPath: record.intendedPath,
      previousPath: record.previousPath ?? null,
    });
  }

  const selected = ordered.filter(
    (entry) =>
      (!selection.manifestDigest ||
        selection.manifestDigest === manifestDigestOf) &&
      (!selection.runId ||
        selection.runId === manifestRunId ||
        switched.some(
          (record) =>
            record.runId === selection.runId &&
            record.kind === entry.kind &&
            record.postId === entry.postId &&
            record.locale === entry.locale &&
            record.intendedPath === entry.expectedPath
        ))
  );

  const rolledBack = new Set(
    records
      .filter(
        (record): record is JournalRollback =>
          record.type === 'rollback' && record.outcome === 'ROLLED_BACK'
      )
      .map(
        (record) => `${record.kind}|${record.postId}|${record.locale}|${record.installedPath}`
      )
  );

  // Reverse migration order: the last switch is rolled back first.
  const reversed = [...selected].reverse();
  const candidates: RollbackCandidate[] = [];

  for (const record of reversed) {
    const kind = record.kind as BodyContentKind;
    const locale = record.locale as BodyContentLocale;
    const key = `${record.kind}|${record.postId}|${record.locale}|${record.expectedPath}`;
    const base = {
      runId: manifestLookup.ok ? manifestLookup.manifest.runId : (selection.runId ?? ''),
      manifestDigest: manifestLookup.ok ? manifestLookup.manifest.manifestDigest : '',
      kind,
      postId: record.postId,
      locale,
      installedPath: record.expectedPath,
      previousPath: record.previousPath ?? null,
      sourceSha256: record.sourceSha256,
    };

    if (rolledBack.has(key)) {
      candidates.push({
        ...base,
        state: 'ALREADY_ROLLED_BACK',
        observedPointer: null,
        detail: 'this run already recorded a rollback for the entry',
      });
      continue;
    }

    const [pointer, body] = await Promise.all([
      deps.readCommittedPointer(kind, record.postId, locale),
      deps.readCommittedBody(kind, record.postId, locale),
    ]);

    if (body === null) {
      candidates.push({
        ...base,
        state: 'MISSING',
        observedPointer: pointer,
        detail: 'row or legacy body is gone',
      });
      continue;
    }
    if (sha256Hex(Buffer.from(body, 'utf8')) !== record.sourceSha256) {
      candidates.push({
        ...base,
        state: 'BODY_CHANGED',
        observedPointer: pointer,
        detail: 'legacy body changed after the migration; refusing to force a rollback',
      });
      continue;
    }
    if (pointer !== record.expectedPath) {
      // Either we already restored it, or someone else moved it. Distinguish:
      // holding the previous value again means there is nothing left to do,
      // and the write is never retried.
      if (pointer === (record.previousPath ?? null)) {
        candidates.push({
          ...base,
          state: 'ALREADY_ROLLED_BACK',
          observedPointer: pointer,
          detail: 'committed pointer already holds the previous value',
        });
        continue;
      }
      candidates.push({
        ...base,
        state: 'POINTER_DRIFTED',
        observedPointer: pointer,
        detail: 'committed pointer is no longer the migrated key',
      });
      continue;
    }
    candidates.push({
      ...base,
      state: 'READY',
      observedPointer: pointer,
      detail: null,
    });
  }

  return candidates;
}

export type RollbackReport = {
  runId: string | null;
  manifestDigest: string | null;
  candidates: RollbackCandidate[];
  entries: Array<{
    kind: string;
    postId: number;
    locale: string;
    installedPath: string;
    outcome: string;
    reason: string | null;
    revalidation: JournalRevalidationStatus | null;
  }>;
  revalidationPending: string[];
  /** Set when the rollback stopped at the first unexpected conflict. */
  stopped: {
    kind: string;
    postId: number;
    locale: string;
    state: RollbackCandidateState;
    detail: string | null;
  } | null;
  /** True while any restored post has an unacknowledged invalidation. */
  incomplete: boolean;
  summary: {
    planned: number;
    ready: number;
    rolledBack: number;
    skipped: number;
    conflicts: number;
    failed: number;
  };
};

/**
 * Executes a rollback over the READY candidates only, in the order given
 * (reverse migration order). Each entry goes through the atomic rollback CAS,
 * which refuses when the pointer or the legacy body changed; the outcome is
 * journalled, and a successful rollback is invalidated per post after every
 * applicable locale has been restored.
 *
 * With `failFast` (the default) the first unexpected conflict stops the run:
 * nothing further is rolled back, and the entries already restored keep their
 * committed pointer change and are still invalidated.
 *
 * Nothing is uploaded, no object is removed, and `body_en` / `body_it` are
 * never written.
 */
export async function executeRollback(
  deps: RollbackDeps,
  candidates: RollbackCandidate[],
  options: { failFast?: boolean } = {}
): Promise<RollbackReport> {
  const failFast = options.failFast ?? true;
  const entries: RollbackReport['entries'] = [];
  const revalidationPending = new Set<string>();
  const restored = new Map<
    string,
    Array<{ candidate: RollbackCandidate; entryIndex: number }>
  >();
  let stopped: RollbackReport['stopped'] = null;
  let rolledBack = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (candidate.state !== 'READY') {
      entries.push({
        kind: candidate.kind,
        postId: candidate.postId,
        locale: candidate.locale,
        installedPath: candidate.installedPath,
        outcome: candidate.state,
        reason: candidate.detail,
        revalidation: null,
      });
      if (failFast && candidate.state !== 'ALREADY_ROLLED_BACK') {
        stopped = {
          kind: candidate.kind,
          postId: candidate.postId,
          locale: candidate.locale,
          state: candidate.state,
          detail: candidate.detail,
        };
        break;
      }
      continue;
    }

    const result = await deps.cas.pointerRollback({
      kind: candidate.kind,
      postId: candidate.postId,
      locale: candidate.locale,
      installedPath: candidate.installedPath,
      expectedSha256: candidate.sourceSha256,
      previousPath: candidate.previousPath,
    });

    entries.push({
      kind: candidate.kind,
      postId: candidate.postId,
      locale: candidate.locale,
      installedPath: candidate.installedPath,
      outcome: result.outcome,
      reason: result.reason,
      revalidation: null,
    });
    const entryIndex = entries.length - 1;

    if (result.outcome === 'ROLLED_BACK') {
      rolledBack += 1;
      const post = postKey(candidate.kind, candidate.postId);
      restored.set(post, [...(restored.get(post) ?? []), { candidate, entryIndex }]);
    } else if (result.outcome !== 'ALREADY_CURRENT') {
      failed += 1;
    }

    await deps.journal.append({
      type: 'rollback',
      runId: candidate.runId,
      manifestDigest: candidate.manifestDigest,
      kind: candidate.kind,
      postId: candidate.postId,
      locale: candidate.locale,
      intendedPath: candidate.installedPath,
      installedPath: candidate.installedPath,
      restoredPath: result.outcome === 'ROLLED_BACK' ? candidate.previousPath : null,
      outcome: result.outcome,
      reason: result.reason,
      revalidation: null,
      detail: candidate.detail,
      at: deps.now().toISOString(),
    });

    if (failFast && result.outcome !== 'ROLLED_BACK' && result.outcome !== 'ALREADY_CURRENT') {
      stopped = {
        kind: candidate.kind,
        postId: candidate.postId,
        locale: candidate.locale,
        state: 'READY',
        detail: `rollback CAS refused: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`,
      };
      break;
    }
  }

  // Invalidate once per post, after every restored locale of that post has been
  // verified by its CAS. A failed or skipped event leaves the rollback
  // incomplete and retryable.
  for (const [post, group] of restored) {
    const first = group[0].candidate;
    const status = await deps.invalidate({
      entity: first.kind,
      operation: 'publish',
      ids: [first.postId],
    });
    for (const { candidate, entryIndex } of group) {
      entries[entryIndex].revalidation = status;
      await deps.journal.append({
        type: 'revalidation',
        runId: candidate.runId,
        manifestDigest: candidate.manifestDigest,
        kind: candidate.kind,
        postId: candidate.postId,
        locale: candidate.locale,
        intendedPath: candidate.installedPath,
        status,
        observedPointer: candidate.previousPath,
        detail: 'rollback invalidation',
        at: deps.now().toISOString(),
      });
      if (isIncompleteRevalidation(status)) revalidationPending.add(post);
    }
  }

  return {
    runId: candidates[0]?.runId ?? null,
    manifestDigest: candidates[0]?.manifestDigest ?? null,
    candidates,
    entries,
    revalidationPending: [...revalidationPending].sort(),
    stopped,
    incomplete: revalidationPending.size > 0,
    summary: {
      planned: candidates.length,
      ready: candidates.filter((candidate) => candidate.state === 'READY').length,
      rolledBack,
      skipped: candidates.filter((candidate) => candidate.state === 'ALREADY_ROLLED_BACK').length,
      conflicts: candidates.filter(
        (candidate) => candidate.state !== 'READY' && candidate.state !== 'ALREADY_ROLLED_BACK'
      ).length,
      failed,
    },
  };
}

export type RollbackRevalidationRetry = {
  kind: string;
  postId: number;
  locale: string;
  installedPath: string;
  outcome: 'REVALIDATED' | 'SUPERSEDED' | 'FAILED';
  status: JournalRevalidationStatus;
};

/**
 * Retries rollback invalidations the journal still holds as pending. The
 * restored pointer is re-read (it must still be the value the rollback put
 * back) before a single signed event per post is sent; nothing is uploaded and
 * no pointer is written.
 */
export async function retryRollbackRevalidations(
  deps: Pick<
    RollbackDeps,
    'readCommittedPointer' | 'invalidate' | 'journal' | 'now'
  >,
  pending: PendingRollbackRevalidation[]
): Promise<RollbackRevalidationRetry[]> {
  const groups = new Map<string, PendingRollbackRevalidation[]>();
  for (const entry of pending) {
    const key = `${entry.kind}|${entry.postId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const reports: RollbackRevalidationRetry[] = [];
  for (const group of groups.values()) {
    const observed = await Promise.all(
      group.map(async (entry) => ({
        entry,
        pointer: await deps.readCommittedPointer(
          entry.kind as BodyContentKind,
          entry.postId,
          entry.locale as BodyContentLocale
        ),
      }))
    );
    const allRestored = observed.every(
      ({ entry, pointer }) => pointer === (entry.restoredPath ?? null)
    );

    const status: JournalRevalidationStatus = allRestored
      ? await deps.invalidate({
          entity: group[0].kind as BodyContentKind,
          operation: 'publish',
          ids: [group[0].postId],
        })
      : 'superseded';

    for (const { entry, pointer } of observed) {
      await deps.journal.append({
        type: 'revalidation',
        runId: entry.runId,
        manifestDigest: entry.manifestDigest,
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        intendedPath: entry.installedPath,
        status,
        observedPointer: pointer,
        detail: allRestored ? 'rollback invalidation retry' : 'pointer no longer restored',
        at: deps.now().toISOString(),
      });
      reports.push({
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        installedPath: entry.installedPath,
        outcome:
          status === 'sent' ? 'REVALIDATED' : status === 'superseded' ? 'SUPERSEDED' : 'FAILED',
        status,
      });
    }
  }
  return reports;
}

/* -------------------------------------------------------------------------- */
/* CLI argument contract                                                       */
/* -------------------------------------------------------------------------- */

/** Exact acknowledgement an operator must set in the environment to arm `--apply`. */
export const APPLY_ACK_ENV = 'CMS_BACKFILL_APPLY_ACK';
export const APPLY_ACK_VALUE = 'yes-apply-to-dev-staging';

/** Acknowledgement required to arm rollback execution. */
export const ROLLBACK_ACK_ENV = 'CMS_BACKFILL_ROLLBACK_ACK';
export const ROLLBACK_ACK_VALUE = 'yes-rollback-dev-staging';

/** The only local DEV revalidation destination apply/rollback may target. */
export const APPROVED_REVALIDATION_PATH = '/api/internal/content-revalidate';

/**
 * Validates the configured revalidation endpoint as an explicitly approved
 * local DEV destination. Anything else — a production host, a remote host, a
 * different path, a non-http scheme — is refused before any mutation.
 */
export function validateRevalidationEndpoint(rawUrl: string): string | null {
  if (!rawUrl) return 'WEBSITE_REVALIDATION_URL is not configured';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `WEBSITE_REVALIDATION_URL '${rawUrl}' is not a valid URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `WEBSITE_REVALIDATION_URL must be http(s), got '${url.protocol}'`;
  }
  const host = url.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!isLocal) {
    return `WEBSITE_REVALIDATION_URL must target a local DEV host, got '${host}'`;
  }
  if (url.pathname !== APPROVED_REVALIDATION_PATH) {
    return `WEBSITE_REVALIDATION_URL path must be '${APPROVED_REVALIDATION_PATH}', got '${url.pathname}'`;
  }
  return null;
}

export type ExecArgs =
  | { mode: 'preflight' }
  | {
      mode: 'apply';
      confirmDigest: string;
      expectProjectRef: string;
      runSelection: 'new' | 'resume';
    }
  | { mode: 'invalid'; error: string };

/**
 * Strict flag parsing for the execution CLI: every unknown or malformed flag is
 * refused, `--apply` needs an explicit digest, project reference and run
 * selection (new or resume), and there is no default mode (silence is never an
 * apply).
 */
export function parseExecArgs(argv: string[]): ExecArgs {
  let mode: 'preflight' | 'apply' | null = null;
  let confirmDigest = '';
  let expectProjectRef = '';
  let runSelection: 'new' | 'resume' | null = null;

  for (const arg of argv) {
    if (arg === '--preflight' || arg === '--dry-run') {
      if (mode) return { mode: 'invalid', error: `conflicting mode flag '${arg}'` };
      mode = 'preflight';
      continue;
    }
    if (arg === '--apply') {
      if (mode) return { mode: 'invalid', error: `conflicting mode flag '${arg}'` };
      mode = 'apply';
      continue;
    }
    if (arg === '--resume') {
      if (runSelection) return { mode: 'invalid', error: `conflicting run flag '${arg}'` };
      runSelection = 'resume';
      continue;
    }
    if (arg === '--new-run') {
      if (runSelection) return { mode: 'invalid', error: `conflicting run flag '${arg}'` };
      runSelection = 'new';
      continue;
    }
    if (arg.startsWith('--confirm-digest=')) {
      confirmDigest = arg.slice('--confirm-digest='.length);
      continue;
    }
    if (arg.startsWith('--expect-project-ref=')) {
      expectProjectRef = arg.slice('--expect-project-ref='.length);
      continue;
    }
    return { mode: 'invalid', error: `unknown argument '${arg}'` };
  }

  if (!mode) return { mode: 'invalid', error: 'a mode is required (--preflight)' };
  if (mode === 'apply') {
    if (!/^[0-9a-f]{64}$/.test(confirmDigest)) {
      return { mode: 'invalid', error: '--apply requires --confirm-digest=<64 lowercase hex>' };
    }
    if (!expectProjectRef) {
      return { mode: 'invalid', error: '--apply requires --expect-project-ref=<ref>' };
    }
    if (!runSelection) {
      return {
        mode: 'invalid',
        error: '--apply requires an explicit run selection: --new-run or --resume',
      };
    }
    return { mode: 'apply', confirmDigest, expectProjectRef, runSelection };
  }
  if (runSelection) {
    return { mode: 'invalid', error: `--${runSelection === 'new' ? 'new-run' : 'resume'} requires --apply` };
  }
  return { mode: 'preflight' };
}

export type RollbackArgs =
  | { mode: 'plan'; runId?: string }
  | { mode: 'apply'; runId?: string; expectProjectRef: string }
  | { mode: 'invalid'; error: string };

/**
 * Strict flag parsing for the rollback CLI. The default (no flags) is the
 * read-only plan; execution additionally needs an explicit project reference
 * and the operator acknowledgement from the environment.
 */
export function parseRollbackArgs(argv: string[]): RollbackArgs {
  let mode: 'plan' | 'apply' = 'plan';
  let runId: string | undefined;
  let expectProjectRef = '';

  for (const arg of argv) {
    if (arg === '--plan' || arg === '--dry-run') {
      if (mode === 'apply') return { mode: 'invalid', error: `conflicting mode flag '${arg}'` };
      mode = 'plan';
      continue;
    }
    if (arg === '--apply') {
      if (mode === 'apply') return { mode: 'invalid', error: "conflicting mode flag '--apply'" };
      mode = 'apply';
      continue;
    }
    if (arg.startsWith('--run-id=')) {
      runId = arg.slice('--run-id='.length);
      if (!runId) return { mode: 'invalid', error: '--run-id requires a value' };
      continue;
    }
    if (arg.startsWith('--expect-project-ref=')) {
      expectProjectRef = arg.slice('--expect-project-ref='.length);
      continue;
    }
    return { mode: 'invalid', error: `unknown argument '${arg}'` };
  }

  if (mode === 'apply') {
    if (!expectProjectRef) {
      return { mode: 'invalid', error: '--apply requires --expect-project-ref=<ref>' };
    }
    return { mode: 'apply', runId, expectProjectRef };
  }
  return { mode: 'plan', runId };
}

/** Runs the rollback CAS for a single entry (used by CLI and tests). */
export async function rollbackEntry(
  deps: Pick<BackfillExecutorDeps, 'cas'>,
  args: {
    kind: BodyContentKind;
    postId: number;
    locale: BodyContentLocale;
    installedPath: string;
    sourceSha256: string;
    previousPath: string | null;
  }
): Promise<{ outcome: CasOutcome; reason: string | null }> {
  return deps.cas.pointerRollback({
    kind: args.kind,
    postId: args.postId,
    locale: args.locale,
    installedPath: args.installedPath,
    expectedSha256: args.sourceSha256,
    previousPath: args.previousPath,
  });
}

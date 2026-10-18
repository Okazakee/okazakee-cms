/**
 * Markdown body backfill executor (Phase 11B.1) — DEV only.
 *
 * Drives the reviewed plan from `backfillPlan.ts` entry by entry, in the plan's
 * deterministic order, and keeps upload success strictly separate from pointer
 * success:
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
 * Nothing here deletes: an object that exists without a pointer is reported as
 * an orphan candidate and left alone. Markdown is never rewritten — the bytes
 * come from the committed column, so Unicode, newlines and image URLs are
 * preserved exactly.
 *
 * Every dependency is injected, so the whole executor is testable without a
 * network or a database, and no code path in this module can reach a mutation
 * other than the CAS RPC and the object upload it is given.
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
  unresolvedIntents,
  type BackfillJournal,
  type BackfillRunOutcome,
  type JournalRecord,
  type JournalUploadStatus,
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
  /** True only when THIS run's CAS moved the pointer (drives revalidation). */
  pointerSwitched: boolean;
  /** True only when THIS run performed the upload (never inferred from existence). */
  objectCreatedByRun: boolean;
  revalidation: RevalidationStatus | null;
};

export type BackfillRunReport = {
  runId: string;
  manifestDigest: string;
  entries: BackfillEntryReport[];
  /** Objects that exist but are not referenced by any committed pointer. Never deleted here. */
  orphanCandidates: string[];
  /** Posts whose pointer moved but whose signed revalidation did not succeed. */
  revalidationPending: string[];
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
 * Executes a plan. Throws before doing anything when the plan itself carries a
 * blocker: a blocked plan is never partially applied.
 */
export async function executeBackfill(
  deps: BackfillExecutorDeps,
  plan: BackfillPlanEntry[],
  options: { runId?: string; revalidate?: boolean } = {}
): Promise<BackfillRunReport> {
  const blocked = plan.filter((entry) => entry.action === 'BLOCKED');
  if (blocked.length > 0) {
    throw new Error(
      `[backfill-exec] refusing to execute a blocked plan (${blocked.length} blocked entries)`
    );
  }

  const runId = options.runId ?? deps.newRunId();
  const revalidate = options.revalidate ?? true;
  const digest = manifestDigest(plan);
  const reports: BackfillEntryReport[] = [];
  const orphanCandidates = new Set<string>();
  const revalidationPending = new Set<string>();

  // Entries an earlier interrupted run left unresolved: the journal is not
  // trusted for the decision, but it tells us that this post may already have
  // been switched without its cache being invalidated.
  const priorUnresolved = new Set(
    unresolvedIntents((await deps.journal.read()).records).map(
      (intent) => `${intent.kind}:${intent.postId}:${intent.locale}:${intent.intendedPath}`
    )
  );

  /** Runs the signed revalidation for one post and applies the result to its entries. */
  const flushPost = async (group: BackfillEntryReport[]): Promise<void> => {
    if (group.length === 0) return;
    // A pointer that moved in THIS run needs invalidation. An entry the
    // journal left unresolved may have moved the pointer in an interrupted
    // run without invalidating, so it needs the same treatment even though it
    // now looks already-current.
    const needsRevalidation = group.some(
      (entry) =>
        entry.pointerSwitched ||
        priorUnresolved.has(`${entry.kind}:${entry.postId}:${entry.locale}:${entry.intendedPath}`)
    );
    if (!needsRevalidation) {
      for (const entry of group) entry.revalidation = null;
      return;
    }
    if (!revalidate) {
      for (const entry of group) entry.revalidation = 'skipped';
      return;
    }
    const status = await deps.invalidate({
      entity: group[0].kind,
      operation: 'publish',
      ids: [group[0].postId],
    });
    for (const entry of group) {
      if (!entry.pointerVerified) continue;
      entry.revalidation = status;
      if (status === 'failed') {
        entry.outcome = 'REVALIDATION_FAILED';
        entry.detail = 'pointer switched but signed revalidation failed';
        revalidationPending.add(postKey(entry.kind, entry.postId));
      }
    }
  };

  let currentPost = '';
  let group: BackfillEntryReport[] = [];

  const recordOutcome = async (report: BackfillEntryReport): Promise<void> => {
    const record: JournalRecord = {
      type: 'outcome',
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
  };

  for (const entry of plan) {
    if (entry.action === 'SKIP_EMPTY') {
      continue;
    }

    // Flush the previous post's group before moving on (entries are ordered by
    // post, so EN/IT of one post are revalidated with a single event).
    const key = postKey(entry.kind, entry.postId);
    if (key !== currentPost && group.length > 0) {
      await flushPost(group);
      for (const report of group) await recordOutcome(report);
      group = [];
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
      pointerSwitched: false,
      objectCreatedByRun: false,
      revalidation: null,
    };

    if (entry.expectedPath === null || entry.sourceSha256 === null) {
      continue;
    }

    await deps.journal.append({
      type: 'intent',
      runId,
      manifestDigest: digest,
      kind: entry.kind,
      postId: entry.postId,
      locale: entry.locale,
      previousPath: entry.currentPath,
      intendedPath: entry.expectedPath,
      sourceSha256: entry.sourceSha256,
      at: deps.now().toISOString(),
    });

    try {
      if (entry.action === 'ALREADY_CURRENT') {
        // Never trust the recorded state: re-verify the object bytes.
        const bytes = await readBodyContentBytes(deps.storage, entry.expectedPath);
        if (sha256Hex(bytes) !== entry.sourceSha256) {
          report.outcome = 'VERIFY_FAILED';
          report.detail = 'existing object bytes do not match the manifest hash';
        } else {
          report.outcome = 'ALREADY_CURRENT';
          report.pointerVerified = (await deps.readCommittedPointer(
            entry.kind,
            entry.postId,
            entry.locale
          )) === entry.expectedPath;
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
  }

  if (group.length > 0) {
    await flushPost(group);
    for (const report of group) await recordOutcome(report);
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
    summary: {
      entries: reports.length,
      byOutcome,
      pointerSwitches: reports.filter((r) => r.outcome === 'UPLOADED_AND_POINTED').length,
      uploadedObjects: reports.filter((r) => r.objectCreatedByRun).length,
      alreadyCurrent: byOutcome.ALREADY_CURRENT,
      failures: reports.filter((r) => isFailure(r.outcome)).length,
      revalidationFailed: byOutcome.REVALIDATION_FAILED,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* CLI argument contract                                                       */
/* -------------------------------------------------------------------------- */

/** Exact acknowledgement an operator must set in the environment to arm `--apply`. */
export const APPLY_ACK_ENV = 'CMS_BACKFILL_APPLY_ACK';
export const APPLY_ACK_VALUE = 'yes-apply-to-dev-staging';

export type ExecArgs =
  | { mode: 'preflight' }
  | { mode: 'apply'; confirmDigest: string; expectProjectRef: string }
  | { mode: 'invalid'; error: string };

/**
 * Strict flag parsing for the execution CLI: every unknown or malformed flag is
 * refused, `--apply` needs an explicit digest and project reference, and there
 * is no default mode (silence is never an apply).
 */
export function parseExecArgs(argv: string[]): ExecArgs {
  let mode: 'preflight' | 'apply' | null = null;
  let confirmDigest = '';
  let expectProjectRef = '';

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
    return { mode: 'apply', confirmDigest, expectProjectRef };
  }
  return { mode: 'preflight' };
}

/**
 * Runs the rollback CAS for a previously applied entry. It restores the
 * recorded previous pointer only while the row still holds exactly the pointer
 * this run installed and its committed body still matches the recorded hash;
 * otherwise the conflict is returned and nothing is written.
 */
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

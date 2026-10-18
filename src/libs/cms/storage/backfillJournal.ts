/**
 * Durable, append-only execution journal for the Markdown body backfill
 * (Phase 11B.1, hardened in 11B.2).
 *
 * The journal is an audit trail, NOT a source of truth: a repeated or resumed
 * execution re-reads the committed pointer and re-downloads the object, and
 * never trusts a recorded outcome. Its job is to make an interrupted run
 * legible — in particular a run interrupted *after* uploading an object, after
 * switching a pointer, or after a pointer switch whose cache invalidation never
 * succeeded.
 *
 * Records are one JSON object per line and contain only non-sensitive facts:
 * run/manifest identity, ids, locale, object keys, SHA-256 hashes, outcome
 * codes and timestamps. Raw Markdown, credentials, cookies and session
 * material are never written.
 *
 * Identity: an entry is `runId + manifestDigest + kind + postId + locale +
 * intendedPath`. Outcomes therefore can never complete an intent from another
 * run or another manifest.
 *
 * Write safety: each record is appended with a single write followed by
 * `fsync`, and the byte count is verified, so the only possible torn state is a
 * truncated FINAL line. The parser reports that (`tornTail`) and drops the
 * partial record; malformed complete lines are counted and surfaced, never
 * silently ignored, and any damaged journal refuses resume.
 */
import { dirname } from 'node:path';

/** Terminal vocabulary for one plan entry (durable reporting). */
export type BackfillRunOutcome =
  | 'UPLOADED_AND_POINTED'
  | 'ALREADY_CURRENT'
  | 'SKIPPED_EMPTY'
  | 'UPLOAD_FAILED'
  | 'VERIFY_FAILED'
  | 'CAS_STALE'
  | 'CAS_MISSING'
  | 'CAS_REFUSED'
  | 'POINTER_VERIFY_FAILED'
  | 'REVALIDATION_FAILED';

export type JournalUploadStatus = 'uploaded' | 'existing' | 'skipped' | 'failed';

/**
 * Invalidation outcome. `superseded` means the committed pointer no longer
 * holds the key this run installed, so the row's cache is owned by whatever
 * changed it (the CMS emits its own event) and no retry is required.
 */
export type JournalRevalidationStatus = 'sent' | 'failed' | 'skipped' | 'superseded';

/** Fields that identify one unit of work across runs, manifests and records. */
type JournalIdentityFields = {
  runId: string;
  manifestDigest: string;
  kind: string;
  postId: number;
  locale: string;
  intendedPath: string;
};

/** Written before any object is uploaded for an entry. */
export type JournalIntent = JournalIdentityFields & {
  type: 'intent';
  /**
   * Monotonic attempt ordinal for this entry: a retry after a recorded failure
   * is a NEW attempt, so it can be recorded without contradicting the earlier
   * one. Absent in old journals, where it reads as 1.
   */
  attempt: number;
  previousPath: string | null;
  sourceSha256: string;
  at: string;
};

/** Written only after the committed state has been observed and verified. */
export type JournalOutcome = JournalIdentityFields & {
  type: 'outcome';
  /** Attempt ordinal of this observation (see JournalIntent.attempt). */
  attempt: number;
  previousPath: string | null;
  sourceSha256: string;
  outcome: BackfillRunOutcome;
  upload: JournalUploadStatus;
  cas: string | null;
  casReason: string | null;
  pointerVerified: boolean;
  /** True only when this run's CAS moved the pointer. */
  pointerSwitched: boolean;
  objectCreatedByRun: boolean;
  revalidation: JournalRevalidationStatus | null;
  detail: string | null;
  at: string;
};

/** Written for every signed invalidation attempt, including retries. */
export type JournalRevalidation = JournalIdentityFields & {
  type: 'revalidation';
  status: JournalRevalidationStatus;
  /** Committed pointer observed at attempt time (null when the row vanished). */
  observedPointer: string | null;
  detail: string | null;
  at: string;
};

/** Written for every rollback attempt. */
export type JournalRollback = JournalIdentityFields & {
  type: 'rollback';
  installedPath: string;
  restoredPath: string | null;
  outcome: string;
  reason: string | null;
  revalidation: JournalRevalidationStatus | null;
  detail: string | null;
  at: string;
};

/** One entry of the immutable execution manifest. */
export type JournalManifestEntry = {
  kind: string;
  postId: number;
  locale: string;
  sourceSha256: string;
  sizeBytes: number;
  expectedPath: string;
  previousPath: string | null;
};

/**
 * The immutable execution identity of a run, written BEFORE the first mutation.
 *
 * A resumed run must not recompute its digest from the current database: once a
 * pointer is switched the planner classifies that entry ALREADY_CURRENT, which
 * changes the derived digest and would make a valid partial run look like a
 * different manifest. This record is the authoritative identity instead.
 */
export type JournalManifest = {
  type: 'manifest';
  runId: string;
  manifestDigest: string;
  entries: JournalManifestEntry[];
  at: string;
};

export type JournalRecord =
  | JournalIntent
  | JournalOutcome
  | JournalRevalidation
  | JournalRollback
  | JournalManifest;

/** Full identity key: runs and manifests are part of it. */
export function journalEntryKey(record: JournalIdentityFields): string {
  return [
    record.runId,
    record.manifestDigest,
    record.kind,
    record.postId,
    record.locale,
    record.intendedPath,
  ].join('|');
}

/**
 * Run-independent slot for one entry (entity/id/locale/destination). Used to
 * relate work across runs — e.g. an earlier run's unresolved intent for the
 * same entry — without ever confusing two runs' *outcomes*.
 */
export function journalEntrySlot(
  record: Pick<JournalIdentityFields, 'kind' | 'postId' | 'locale' | 'intendedPath'>
): string {
  return [record.kind, record.postId, record.locale, record.intendedPath].join('|');
}

/** One attempt of one entry: identity plus its attempt ordinal. */
export function journalAttemptKey(
  record: JournalIdentityFields & { attempt: number }
): string {
  return `${journalEntryKey(record)}|${record.attempt}`;
}

/**
 * Outcomes that mean the migration work for an entry is DONE (a switch whose
 * invalidation is still outstanding is tracked separately as a pending
 * invalidation). Everything else is a failure that must be retried.
 */
export const SUCCESSFUL_BACKFILL_OUTCOMES: BackfillRunOutcome[] = [
  'UPLOADED_AND_POINTED',
  'ALREADY_CURRENT',
  'REVALIDATION_FAILED',
];

export function isSuccessfulOutcome(outcome: BackfillRunOutcome): boolean {
  return SUCCESSFUL_BACKFILL_OUTCOMES.includes(outcome);
}

/** Serializes one record as a single JSON line (throws on embedded newlines). */
export function serializeJournalRecord(record: JournalRecord): string {
  const line = JSON.stringify(record);
  if (line.includes('\n')) {
    throw new Error('[backfill-journal] refusing to write a multi-line record');
  }
  return `${line}\n`;
}

export type ParsedJournal = {
  records: JournalRecord[];
  /** True when the file ends mid-record (interrupted append). */
  tornTail: boolean;
  /** Complete lines that were not valid records — never silently applied. */
  malformedLines: number;
};

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function revalidationStatus(value: unknown): JournalRevalidationStatus {
  if (value === 'sent' || value === 'failed' || value === 'skipped' || value === 'superseded') {
    return value;
  }
  return 'failed';
}

/**
 * Parses one line into a typed record, or null when the value is not a journal
 * record. The shared identity fields are validated with `typeof`; the
 * type-specific closed unions are then read from the parsed object, which the
 * writer produced.
 */
export function parseJournalRecord(value: unknown): JournalRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (raw.type === 'manifest') {
    if (typeof raw.runId !== 'string' || typeof raw.manifestDigest !== 'string') {
      return null;
    }
    if (!Array.isArray(raw.entries)) return null;
    const entries: JournalManifestEntry[] = [];
    for (const candidate of raw.entries) {
      if (typeof candidate !== 'object' || candidate === null) return null;
      const entry = candidate as Record<string, unknown>;
      const postId = Number(entry.postId);
      if (
        typeof entry.kind !== 'string' ||
        !Number.isInteger(postId) ||
        postId <= 0 ||
        typeof entry.locale !== 'string' ||
        typeof entry.sourceSha256 !== 'string' ||
        typeof entry.expectedPath !== 'string'
      ) {
        return null;
      }
      entries.push({
        kind: entry.kind,
        postId,
        locale: entry.locale,
        sourceSha256: entry.sourceSha256,
        sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0,
        expectedPath: entry.expectedPath,
        previousPath: nullableString(entry.previousPath),
      });
    }
    return {
      type: 'manifest',
      runId: raw.runId,
      manifestDigest: raw.manifestDigest,
      entries,
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  }

  if (
    raw.type !== 'intent' &&
    raw.type !== 'outcome' &&
    raw.type !== 'revalidation' &&
    raw.type !== 'rollback'
  ) {
    return null;
  }

  const postId = Number(raw.postId);
  if (typeof raw.runId !== 'string' || typeof raw.manifestDigest !== 'string') {
    return null;
  }
  if (typeof raw.kind !== 'string' || typeof raw.locale !== 'string') return null;
  if (typeof raw.intendedPath !== 'string') return null;
  if (!Number.isInteger(postId) || postId <= 0) return null;

  const identity = {
    runId: raw.runId,
    manifestDigest: raw.manifestDigest,
    kind: raw.kind,
    postId,
    locale: raw.locale,
    intendedPath: raw.intendedPath,
    at: typeof raw.at === 'string' ? raw.at : '',
  };
  // Absent in pre-attempt journals, where every recorded observation is 1.
  const attempt =
    typeof raw.attempt === 'number' && Number.isInteger(raw.attempt) && raw.attempt > 0
      ? raw.attempt
      : 1;

  if (raw.type === 'intent') {
    return {
      type: 'intent',
      ...identity,
      attempt,
      previousPath: nullableString(raw.previousPath),
      sourceSha256: typeof raw.sourceSha256 === 'string' ? raw.sourceSha256 : '',
    };
  }

  if (raw.type === 'revalidation') {
    return {
      type: 'revalidation',
      ...identity,
      status: revalidationStatus(raw.status),
      observedPointer: nullableString(raw.observedPointer),
      detail: nullableString(raw.detail),
    };
  }

  if (raw.type === 'rollback') {
    return {
      type: 'rollback',
      ...identity,
      installedPath: typeof raw.installedPath === 'string' ? raw.installedPath : '',
      restoredPath: nullableString(raw.restoredPath),
      outcome: typeof raw.outcome === 'string' ? raw.outcome : 'UNKNOWN',
      reason: nullableString(raw.reason),
      revalidation: raw.revalidation === null ? null : revalidationStatus(raw.revalidation),
      detail: nullableString(raw.detail),
    };
  }

  return {
    type: 'outcome',
    ...identity,
    attempt,
    previousPath: nullableString(raw.previousPath),
    sourceSha256: typeof raw.sourceSha256 === 'string' ? raw.sourceSha256 : '',
    outcome: raw.outcome as BackfillRunOutcome,
    upload: raw.upload as JournalUploadStatus,
    cas: nullableString(raw.cas),
    casReason: nullableString(raw.casReason),
    pointerVerified: raw.pointerVerified === true,
    pointerSwitched: raw.pointerSwitched === true,
    objectCreatedByRun: raw.objectCreatedByRun === true,
    revalidation: raw.revalidation === null ? null : revalidationStatus(raw.revalidation),
    detail: nullableString(raw.detail),
  };
}

/**
 * Parses a journal. Only complete lines (terminated by a newline) count as
 * records; a truncated trailing line is reported through `tornTail` and
 * discarded, and anything else unparseable is counted, never applied.
 */
export function parseJournalText(text: string): ParsedJournal {
  const records: JournalRecord[] = [];
  const tornTail = text.length > 0 && !text.endsWith('\n');
  const complete = tornTail ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  let malformedLines = 0;
  for (const line of complete.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const record = parseJournalRecord(parsed);
    if (record) records.push(record);
    else malformedLines += 1;
  }
  return { records, tornTail, malformedLines };
}

/* -------------------------------------------------------------------------- */
/* Audit: runs, conflicts, unresolved work, pending invalidations              */
/* -------------------------------------------------------------------------- */

export type PendingRevalidation = {
  runId: string;
  manifestDigest: string;
  kind: string;
  postId: number;
  locale: string;
  intendedPath: string;
  sourceSha256: string;
  previousPath: string | null;
  lastStatus: 'failed' | 'skipped';
  attempts: number;
};

export type JournalRunSummary = {
  runId: string;
  manifestDigest: string;
  intents: number;
  outcomes: number;
  revalidations: number;
  rollbacks: number;
  /** Immutable manifest records for this run (0 or 1 in a healthy journal). */
  manifests: number;
  /** Entries declared by the immutable manifest, when present. */
  manifestEntries: number;
  /** Entries whose switch was verified by an outcome record. */
  switched: number;
  /** Entries the manifest (or the outcomes, when absent) declares. */
  entriesTotal: number;
  /** Entries whose LATEST attempt recorded a successful outcome. */
  entriesSucceeded: number;
  /** Entries whose latest attempt recorded a failure — retry candidates. */
  entriesFailed: number;
  /** Manifest entries with no outcome at all — never attempted. */
  entriesMissing: number;
  unresolved: JournalIntent[];
  pendingRevalidations: PendingRevalidation[];
};

export type JournalAudit = {
  runs: JournalRunSummary[];
  /** Identical identities carrying conflicting facts — a damaged journal. */
  conflicts: string[];
  /** True only when the journal can be trusted *as an audit trail*. */
  trustworthy: boolean;
  /** Blocking problems; a non-empty list refuses resume or rollback. */
  problems: string[];
  /**
   * Non-blocking observations. A torn tail is recoverable: the partial record
   * is discarded and the affected work is re-verified from the database, so it
   * is reported rather than treated as corruption.
   */
  warnings: string[];
};

/** Intents with no outcome for the same attempt (run + manifest + entry + attempt). */
export function unresolvedIntents(records: JournalRecord[]): JournalIntent[] {
  const completed = new Set<string>();
  for (const record of records) {
    if (record.type === 'outcome') completed.add(journalAttemptKey(record));
  }
  return records.filter(
    (record): record is JournalIntent =>
      record.type === 'intent' && !completed.has(journalAttemptKey(record))
  );
}

/**
 * Entries whose pointer switch was verified but whose signed invalidation was
 * never acknowledged, including `skipped` ones (an invalidation that was
 * required but not performed is incomplete work, not success).
 *
 * The latest `revalidation` record per identity decides: `sent` resolves it,
 * `superseded` resolves it (the row moved on and the CMS owns that cache),
 * while `failed`/`skipped` — or no record at all — keep it pending.
 */
export function pendingRevalidations(records: JournalRecord[]): PendingRevalidation[] {
  const switchedByKey = new Map<string, JournalOutcome>();
  const attempts = new Map<string, { status: JournalRevalidationStatus; count: number }>();

  for (const record of records) {
    if (record.type === 'outcome' && record.pointerSwitched) {
      switchedByKey.set(journalEntryKey(record), record);
    }
    if (record.type === 'revalidation') {
      const key = journalEntryKey(record);
      const previous = attempts.get(key);
      attempts.set(key, {
        status: record.status,
        count: (previous?.count ?? 0) + 1,
      });
    }
  }

  const pending: PendingRevalidation[] = [];
  for (const [key, outcome] of switchedByKey) {
    const attempt = attempts.get(key);
    if (attempt && (attempt.status === 'sent' || attempt.status === 'superseded')) continue;
    // The outcome record itself is evidence: a switch recorded as acknowledged
    // is not pending even when the separate attempt record is absent.
    if (
      !attempt &&
      (outcome.revalidation === 'sent' || outcome.revalidation === 'superseded')
    ) {
      continue;
    }
    // No attempt recorded for a switch: the run stopped before revalidating,
    // which is exactly the case this list exists for.
    const lastStatus = attempt?.status === 'skipped' ? 'skipped' : 'failed';
    pending.push({
      runId: outcome.runId,
      manifestDigest: outcome.manifestDigest,
      kind: outcome.kind,
      postId: outcome.postId,
      locale: outcome.locale,
      intendedPath: outcome.intendedPath,
      sourceSha256: outcome.sourceSha256,
      previousPath: outcome.previousPath,
      lastStatus,
      attempts: attempt?.count ?? (outcome.revalidation === 'sent' ? 1 : 0),
    });
  }
  return pending.sort((a, b) => journalEntryKey(a).localeCompare(journalEntryKey(b)));
}

/**
 * Conflicting evidence for one identity: two outcomes that disagree about the
 * switch, or two intents that disagree about the source. Such a journal cannot
 * be resumed or rolled back from.
 */
export function detectConflicts(records: JournalRecord[]): string[] {
  const outcomes = new Map<string, Set<string>>();
  const intents = new Map<string, Set<string>>();
  const manifests = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.type === 'manifest') {
      const seen = manifests.get(record.runId) ?? new Set<string>();
      seen.add(JSON.stringify([record.manifestDigest, record.entries]));
      manifests.set(record.runId, seen);
      continue;
    }
    // Contradictions are judged per attempt: a retry is a new attempt, not a
    // disagreement with the failed one.
    const fingerprint = JSON.stringify(record);
    if (record.type === 'outcome') {
      const key = journalAttemptKey(record);
      const seen = outcomes.get(key) ?? new Set<string>();
      seen.add(fingerprint);
      outcomes.set(key, seen);
    } else if (record.type === 'intent') {
      const key = journalAttemptKey(record);
      const seen = intents.get(key) ?? new Set<string>();
      seen.add(`${record.previousPath}|${record.sourceSha256}`);
      intents.set(key, seen);
    }
  }
  const conflicts: string[] = [];
  for (const [key, seen] of outcomes) {
    if (seen.size > 1) conflicts.push(`conflicting outcome records for ${key}`);
  }
  for (const [key, seen] of intents) {
    if (seen.size > 1) conflicts.push(`conflicting intent records for ${key}`);
  }
  for (const [runId, seen] of manifests) {
    if (seen.size > 1) conflicts.push(`conflicting manifest records for run ${runId}`);
  }
  return conflicts.sort();
}
export function auditJournal(parsed: ParsedJournal): JournalAudit {
  const runs = new Map<string, JournalRunSummary>();
  const summaryFor = (runId: string, manifestDigest: string): JournalRunSummary => {
    const existing = runs.get(runId);
    if (existing) {
      if (existing.manifestDigest !== manifestDigest) {
        existing.manifestDigest = `${existing.manifestDigest}+${manifestDigest}`;
      }
      return existing;
    }
    const created: JournalRunSummary = {
      runId,
      manifestDigest,
      intents: 0,
      outcomes: 0,
      revalidations: 0,
      rollbacks: 0,
      manifests: 0,
      manifestEntries: 0,
      switched: 0,
      entriesTotal: 0,
      entriesSucceeded: 0,
      entriesFailed: 0,
      entriesMissing: 0,
      unresolved: [],
      pendingRevalidations: [],
    };
    runs.set(runId, created);
    return created;
  };

  for (const record of parsed.records) {
    const run = summaryFor(record.runId, record.manifestDigest);
    if (record.type === 'manifest') {
      run.manifests += 1;
      run.manifestEntries = record.entries.length;
    }
    if (record.type === 'intent') run.intents += 1;
    if (record.type === 'outcome') {
      run.outcomes += 1;
      if (record.pointerSwitched) run.switched += 1;
    }
    if (record.type === 'revalidation') run.revalidations += 1;
    if (record.type === 'rollback') run.rollbacks += 1;
  }

  for (const intent of unresolvedIntents(parsed.records)) {
    summaryFor(intent.runId, intent.manifestDigest).unresolved.push(intent);
  }
  for (const pending of pendingRevalidations(parsed.records)) {
    summaryFor(pending.runId, pending.manifestDigest).pendingRevalidations.push(pending);
  }

  // Entry-level status from the LATEST attempt of each entry: a run is only
  // finished when every declared entry's latest attempt succeeded.
  const latestByEntry = new Map<
    string,
    { attempt: number; success: boolean }
  >();
  for (const record of parsed.records) {
    if (record.type !== 'outcome') continue;
    const key = journalEntryKey(record);
    const previous = latestByEntry.get(key);
    if (!previous || record.attempt >= previous.attempt) {
      latestByEntry.set(key, {
        attempt: record.attempt,
        success: isSuccessfulOutcome(record.outcome),
      });
    }
  }

  for (const run of runs.values()) {
    const manifest = parsed.records.find(
      (record): record is JournalManifest =>
        record.type === 'manifest' && record.runId === run.runId
    );
    const keys = manifest
      ? manifest.entries.map((entry) =>
          journalEntryKey({
            runId: run.runId,
            manifestDigest: manifest.manifestDigest,
            kind: entry.kind,
            postId: entry.postId,
            locale: entry.locale,
            intendedPath: entry.expectedPath,
          })
        )
      : [...latestByEntry.keys()].filter((key) => key.startsWith(`${run.runId}|`));
    run.entriesTotal = keys.length;
    for (const key of keys) {
      const latest = latestByEntry.get(key);
      if (!latest) run.entriesMissing += 1;
      else if (latest.success) run.entriesSucceeded += 1;
      else run.entriesFailed += 1;
    }
  }

  const conflicts = detectConflicts(parsed.records);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (parsed.malformedLines > 0) {
    problems.push(`${parsed.malformedLines} malformed journal line(s)`);
  }
  if (parsed.tornTail) {
    warnings.push('journal ends with a partial record (interrupted append) — that record is ignored');
  }
  problems.push(...conflicts);

  return {
    runs: [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId)),
    conflicts,
    trustworthy: problems.length === 0,
    problems,
    warnings,
  };
}

/** A rollback whose cache invalidation was never acknowledged. */
export type PendingRollbackRevalidation = {
  runId: string;
  manifestDigest: string;
  kind: string;
  postId: number;
  locale: string;
  /** The pointer this run installed (the rollback identity). */
  installedPath: string;
  /** The pointer the rollback restored (usually NULL). */
  restoredPath: string | null;
  attempts: number;
};

/**
 * Rollbacks whose signed invalidation is still outstanding. Resolution is
 * order-aware: a `sent`/`superseded` revalidation record only settles the
 * rollback when it was written AFTER the rollback record — a `sent` from the
 * original migration cannot silence a rollback that was never invalidated.
 */
export function pendingRollbackRevalidations(
  records: JournalRecord[]
): PendingRollbackRevalidation[] {
  const latestRevalidation = new Map<
    string,
    { index: number; status: JournalRevalidationStatus }
  >();
  const latestRollback = new Map<string, { index: number; record: JournalRollback }>();

  records.forEach((record, index) => {
    if (record.type === 'revalidation') {
      latestRevalidation.set(journalEntryKey(record), { index, status: record.status });
    }
    if (record.type === 'rollback' && record.outcome === 'ROLLED_BACK') {
      latestRollback.set(journalEntryKey(record), { index, record });
    }
  });

  const pending: PendingRollbackRevalidation[] = [];
  for (const [key, { index, record }] of latestRollback) {
    const attempt = latestRevalidation.get(key);
    const resolved =
      attempt !== undefined &&
      attempt.index > index &&
      (attempt.status === 'sent' || attempt.status === 'superseded');
    if (resolved) continue;
    pending.push({
      runId: record.runId,
      manifestDigest: record.manifestDigest,
      kind: record.kind,
      postId: record.postId,
      locale: record.locale,
      installedPath: record.installedPath,
      restoredPath: record.restoredPath ?? null,
      attempts: attempt && attempt.index > index ? 1 : 0,
    });
  }
  const slot = (entry: PendingRollbackRevalidation) =>
    `${entry.kind}|${entry.postId}|${entry.locale}|${entry.installedPath}`;
  return pending.sort((a, b) => slot(a).localeCompare(slot(b)));
}

export type ManifestLookup =
  | { ok: true; manifest: JournalManifest }
  | { ok: false; error: string };

/**
 * The immutable execution manifest recorded for a run. This — not a digest
 * recomputed from the current database — is what a resume and a rollback must
 * work from, because switching a pointer changes how the planner classifies its
 * entry.
 */
export function recordedManifest(
  records: JournalRecord[],
  runId?: string
): ManifestLookup {
  const manifests = records.filter(
    (record): record is JournalManifest =>
      record.type === 'manifest' && (!runId || record.runId === runId)
  );
  if (manifests.length === 0) {
    return {
      ok: false,
      error: runId
        ? `no immutable manifest recorded for run ${runId}`
        : 'no immutable manifest recorded in the journal',
    };
  }
  if (manifests.length > 1) {
    return {
      ok: false,
      error: `several immutable manifests recorded (${manifests
        .map((manifest) => manifest.runId)
        .join(', ')}); name one run explicitly`,
    };
  }
  return { ok: true, manifest: manifests[0] };
}

export type ResumeSelection =
  | { ok: true; run: JournalRunSummary; mode: 'resume' }
  | { ok: false; error: string };

/**
 * Chooses the run a resume may continue. The requested manifest must match the
 * journal's, and the run must have unresolved work or pending invalidations —
 * otherwise there is nothing to resume and the operator must ask for a new run.
 */
export function selectResumeRun(
  audit: JournalAudit,
  requested: { manifestDigest?: string }
): ResumeSelection {
  if (!audit.trustworthy) {
    return { ok: false, error: `journal is damaged: ${audit.problems.join('; ')}` };
  }
  const candidates = audit.runs.filter(
    (run) =>
      // A run is unfinished while any declared entry's LATEST attempt is a
      // failure, any entry was never attempted, an intent is unanswered, or an
      // invalidation is unacknowledged.
      run.entriesFailed > 0 ||
      run.entriesMissing > 0 ||
      run.unresolved.length > 0 ||
      run.pendingRevalidations.length > 0
  );
  if (candidates.length === 0) {
    return { ok: false, error: 'journal has no unfinished run to resume' };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: `journal holds several unfinished runs (${candidates
        .map((run) => run.runId)
        .join(', ')}); name one explicitly`,
    };
  }
  const run = candidates[0];
  // The digest is optional: a resume takes its identity from the run's own
  // immutable manifest, so the current planner digest is not authoritative.
  if (requested.manifestDigest && run.manifestDigest !== requested.manifestDigest) {
    return {
      ok: false,
      error: `unfinished run ${run.runId} belongs to a different manifest (journal ${run.manifestDigest}, requested ${requested.manifestDigest})`,
    };
  }
  return { ok: true, run, mode: 'resume' };
}

/* -------------------------------------------------------------------------- */
/* Filesystem journal                                                          */
/* -------------------------------------------------------------------------- */

export type JournalFileHandle = {
  write(data: Buffer): Promise<{ bytesWritten?: number }>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
};

export type JournalFsApi = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: 'a', mode?: number): Promise<JournalFileHandle>;
  /** MUST be called with 'utf8' so the parser always receives a string. */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ mode: number }>;
};

export type BackfillJournal = {
  /** Appends one record and resolves only once it is durable (fsync). */
  append(record: JournalRecord): Promise<void>;
  read(): Promise<ParsedJournal>;
  readonly path: string;
};

function filesystemErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * File-backed append-only journal.
 *
 * - reads explicitly as UTF-8, so the parser never sees a Buffer;
 * - ENOENT is a new journal, any other read error (EACCES, EIO, ...) propagates;
 * - creates the file with 0600 and refuses an existing file that is readable by
 *   group or others;
 * - one write per record, verifying the full byte count, then fsync.
 */
export function createFileJournal(
  path: string,
  fs: JournalFsApi,
  now: () => Date = () => new Date()
): BackfillJournal {
  return {
    path,
    async append(record) {
      const line = serializeJournalRecord({ ...record, at: now().toISOString() });
      const buffer = Buffer.from(line, 'utf8');
      await fs.mkdir(dirname(path), { recursive: true });
      const handle = await fs.open(path, 'a', 0o600);
      try {
        const result = await handle.write(buffer);
        const written = typeof result?.bytesWritten === 'number' ? result.bytesWritten : buffer.length;
        if (written !== buffer.length) {
          throw new Error(
            `[backfill-journal] short write: ${written} of ${buffer.length} bytes — record not committed`
          );
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async read() {
      let text: string;
      try {
        text = await fs.readFile(path, 'utf8');
      } catch (error) {
        if (filesystemErrorCode(error) === 'ENOENT') {
          return { records: [], tornTail: false, malformedLines: 0 };
        }
        throw error;
      }
      if (typeof text !== 'string') {
        throw new Error('[backfill-journal] journal read did not return UTF-8 text');
      }
      return parseJournalText(text);
    },
  };
}

/** An in-memory journal for tests and dry runs (same append semantics). */
export function createMemoryJournal(now: () => Date = () => new Date()): BackfillJournal & {
  lines: string[];
} {
  const lines: string[] = [];
  return {
    path: ':memory:',
    lines,
    async append(record) {
      lines.push(serializeJournalRecord({ ...record, at: now().toISOString() }));
    },
    async read() {
      return parseJournalText(lines.join(''));
    },
  };
}

/**
 * Validates a journal destination for a mutating run: absolute, outside the
 * repository (and any configured sibling root), and not group/world readable
 * when it already exists.
 *
 * `additionalRoots` exists for the production tooling: the CMS checkout is the
 * only root the process can infer, but the operator also works in the public
 * site checkout, and a journal must never land in either. Every root is
 * normalised the same way, so `/srv/repo/` and `/srv/repo` behave identically.
 */
export async function assertJournalDestination(
  path: string,
  fs: JournalFsApi,
  options: { repositoryRoot: string; additionalRoots?: string[] }
): Promise<void> {
  if (!path.startsWith('/')) {
    throw new Error(`[backfill-journal] BACKFILL_JOURNAL_PATH must be an absolute path, got '${path}'`);
  }
  const roots = [options.repositoryRoot, ...(options.additionalRoots ?? [])]
    .filter((root) => root !== '')
    .map((root) => root.replace(/\/+$/, ''));
  if (roots.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error('[backfill-journal] the journal must live outside the repository');
  }
  if (path.endsWith('/')) {
    throw new Error('[backfill-journal] BACKFILL_JOURNAL_PATH must name a file');
  }
  try {
    const stats = await fs.stat(path);
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `[backfill-journal] refusing a journal readable beyond its owner (mode ${mode.toString(8)}): ${path}`
      );
    }
  } catch (error) {
    if (filesystemErrorCode(error) !== 'ENOENT') throw error;
    // A missing file is fine: the first append creates it with 0600.
  }
}

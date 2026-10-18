/**
 * Durable, append-only execution journal for the Markdown body backfill
 * (Phase 11B.1).
 *
 * The journal is an audit trail, NOT a source of truth: a repeated or resumed
 * execution re-reads the committed pointer and re-downloads the object, and
 * never trusts a recorded outcome. Its job is to make an interrupted run
 * legible — in particular a run interrupted *after* uploading an object but
 * *before* switching the pointer.
 *
 * Records are one JSON object per line and contain only non-sensitive facts:
 * ids, locale, object keys, SHA-256 hashes, outcome codes and timestamps. Raw
 * Markdown, credentials, cookies and session material are never written.
 *
 * Write safety: each record is appended with a single write followed by
 * `fsync`, so the only possible torn state is a truncated FINAL line. The
 * parser reports that (`tornTail`) and drops the partial record instead of
 * treating it as complete, so an interrupted write can never look like a
 * successful migration.
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

/** Written before any object is uploaded for an entry. */
export type JournalIntent = {
  type: 'intent';
  runId: string;
  manifestDigest: string;
  kind: string;
  postId: number;
  locale: string;
  previousPath: string | null;
  intendedPath: string;
  sourceSha256: string;
  at: string;
};

/** Written only after the committed state has been observed and verified. */
export type JournalOutcome = {
  type: 'outcome';
  runId: string;
  manifestDigest: string;
  kind: string;
  postId: number;
  locale: string;
  previousPath: string | null;
  intendedPath: string;
  sourceSha256: string;
  outcome: BackfillRunOutcome;
  upload: JournalUploadStatus;
  cas: string | null;
  casReason: string | null;
  pointerVerified: boolean;
  /** True only when this run's CAS moved the pointer. */
  pointerSwitched: boolean;
  objectCreatedByRun: boolean;
  revalidation: 'sent' | 'skipped' | 'failed' | null;
  detail: string | null;
  at: string;
};

export type JournalRecord = JournalIntent | JournalOutcome;

/** Entry key shared by intents and outcomes. */
export function journalEntryKey(
  record: Pick<JournalRecord, 'kind' | 'postId' | 'locale' | 'intendedPath'>
): string {
  return `${record.kind}:${record.postId}:${record.locale}:${record.intendedPath}`;
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
  /** Complete lines that were not valid records (never silently ignored). */
  malformedLines: number;
};

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
  if (raw.type !== 'intent' && raw.type !== 'outcome') return null;

  const postId = Number(raw.postId);
  if (typeof raw.runId !== 'string' || typeof raw.manifestDigest !== 'string') {
    return null;
  }
  if (typeof raw.kind !== 'string' || typeof raw.locale !== 'string') return null;
  if (typeof raw.intendedPath !== 'string') return null;
  if (typeof raw.sourceSha256 !== 'string') return null;
  if (!Number.isInteger(postId) || postId <= 0) return null;

  const base = {
    runId: raw.runId,
    manifestDigest: raw.manifestDigest,
    kind: raw.kind,
    postId,
    locale: raw.locale,
    previousPath: nullableString(raw.previousPath),
    intendedPath: raw.intendedPath,
    sourceSha256: raw.sourceSha256,
    at: typeof raw.at === 'string' ? raw.at : '',
  };

  if (raw.type === 'intent') {
    return { type: 'intent', ...base };
  }

  return {
    type: 'outcome',
    ...base,
    outcome: raw.outcome as BackfillRunOutcome,
    upload: raw.upload as JournalUploadStatus,
    cas: nullableString(raw.cas),
    casReason: nullableString(raw.casReason),
    pointerVerified: raw.pointerVerified === true,
    pointerSwitched: raw.pointerSwitched === true,
    objectCreatedByRun: raw.objectCreatedByRun === true,
    revalidation:
      raw.revalidation === 'sent' || raw.revalidation === 'skipped' || raw.revalidation === 'failed'
        ? raw.revalidation
        : null,
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

/** Narrow filesystem surface; the node implementation is injected by default. */
export type JournalFsApi = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(
    path: string,
    flags: 'a'
  ): Promise<{
    write(data: string): Promise<unknown>;
    sync(): Promise<unknown>;
    close(): Promise<unknown>;
  }>;
  readFile(path: string): Promise<string>;
};

export type BackfillJournal = {
  /** Appends one record and resolves only once it is durable (fsync). */
  append(record: JournalRecord): Promise<void>;
  read(): Promise<ParsedJournal>;
};

/**
 * File-backed append-only journal. `append` mkdirs the parent, writes the whole
 * line in one call and fsyncs before returning, so a crash can only truncate
 * the final line (reported as `tornTail` on read).
 */
export function createFileJournal(
  path: string,
  fs: JournalFsApi,
  now: () => Date = () => new Date()
): BackfillJournal {
  return {
    async append(record) {
      const line = serializeJournalRecord({ ...record, at: now().toISOString() });
      await fs.mkdir(dirname(path), { recursive: true });
      const handle = await fs.open(path, 'a');
      try {
        await handle.write(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async read() {
      let text = '';
      try {
        text = await fs.readFile(path);
      } catch {
        return { records: [], tornTail: false, malformedLines: 0 };
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
 * Entries with an intent but no matching outcome — i.e. interrupted between
 * upload and pointer switch (or before the outcome was durable). Recovery must
 * re-verify these from the database and Storage; it must never complete them
 * from the journal alone.
 */
export function unresolvedIntents(records: JournalRecord[]): JournalIntent[] {
  const completed = new Set<string>();
  for (const record of records) {
    if (record.type === 'outcome') completed.add(journalEntryKey(record));
  }
  return records.filter(
    (record): record is JournalIntent =>
      record.type === 'intent' && !completed.has(journalEntryKey(record))
  );
}

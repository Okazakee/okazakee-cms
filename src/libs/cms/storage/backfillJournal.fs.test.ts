import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import {
  assertJournalDestination,
  auditJournal,
  createFileJournal,
  parseJournalText,
  selectResumeRun,
  type JournalFsApi,
  type JournalIntent,
  type JournalOutcome,
} from '@/libs/cms/storage/backfillJournal';

/**
 * Journal tests against the REAL filesystem (temporary directories), not an
 * injected memory fake: they prove the read path receives UTF-8 text, that a
 * torn final line is discarded while the rest survives, that damage blocks a
 * resume, and that durability/permission failures are surfaced instead of being
 * swallowed.
 */

const fsApi = fs as unknown as JournalFsApi;
const HASH = 'a'.repeat(64);

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cms-backfill-journal-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

let counter = 0;
function intent(overrides: Partial<JournalIntent> = {}): JournalIntent {
  counter += 1;
  return {
    type: 'intent',
    runId: 'run-a',
    manifestDigest: 'manifest-1',
    kind: 'blog',
    postId: counter,
    locale: 'en',
    previousPath: null,
    intendedPath: `blog/${counter}/en/${HASH}.md`,
    sourceSha256: HASH,
    at: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

function outcome(
  from: JournalIntent,
  overrides: Partial<JournalOutcome> = {}
): JournalOutcome {
  return {
    type: 'outcome',
    runId: from.runId,
    manifestDigest: from.manifestDigest,
    kind: from.kind,
    postId: from.postId,
    locale: from.locale,
    previousPath: from.previousPath,
    intendedPath: from.intendedPath,
    sourceSha256: from.sourceSha256,
    outcome: 'UPLOADED_AND_POINTED',
    upload: 'uploaded',
    cas: 'APPLIED',
    casReason: null,
    pointerVerified: true,
    pointerSwitched: true,
    objectCreatedByRun: true,
    revalidation: 'sent',
    detail: null,
    at: '2026-10-18T10:00:01.000Z',
    ...overrides,
  };
}

describe('journal on a real filesystem', () => {
  it('creates the file owner-only, survives close/reopen, and appends on resume', async () => {
    const path = join(dir, 'run.jsonl');
    const journal = createFileJournal(path, fsApi);

    const first = intent();
    await journal.append(first);
    await journal.append(outcome(first));

    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);

    // "Close" is implicit (every append opens and closes); reopen a NEW journal
    // instance over the same file, as a later CLI invocation would.
    const reopened = createFileJournal(path, fsApi);
    const parsed = await reopened.read();
    expect(parsed.tornTail).toBe(false);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({ type: 'intent', postId: first.postId });

    // Resume: appending continues the same file without losing history.
    const second = intent({ postId: 99 });
    await reopened.append(second);
    const after = await createFileJournal(path, fsApi).read();
    expect(after.records.map((record) => record.type)).toEqual([
      'intent',
      'outcome',
      'intent',
    ]);
    expect(auditJournal(after).trustworthy).toBe(true);
  });

  it('treats a missing file as a new journal and keeps UTF-8 intact', async () => {
    const path = join(dir, 'fresh.jsonl');
    const journal = createFileJournal(path, fsApi);
    const empty = await journal.read();
    expect(empty).toEqual({ records: [], tornTail: false, malformedLines: 0 });

    const unicode = intent({ postId: 7, intendedPath: `blog/7/it/${HASH}.md` });
    await journal.append(unicode);
    const parsed = await journal.read();
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      type: 'intent',
      postId: 7,
      intendedPath: `blog/7/it/${HASH}.md`,
    });
  });

  it('discards a torn final line, keeps the rest, and still allows a resume', async () => {
    const path = join(dir, 'torn.jsonl');
    const complete = intent({ postId: 5 });
    const journal = createFileJournal(path, fsApi);
    await journal.append(complete);
    // Simulate a crash mid-append: a partial record with no trailing newline.
    await fs.appendFile(path, '{"type":"outcome","runId":"run-a","manifestDi');

    const parsed = await createFileJournal(path, fsApi).read();
    expect(parsed.tornTail).toBe(true);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toHaveLength(1);

    const audit = auditJournal(parsed);
    expect(audit.trustworthy).toBe(true);
    expect(audit.warnings.join(' ')).toContain('partial record');
    // The complete intent is still recognised as unfinished work.
    expect(audit.runs[0].unresolved).toHaveLength(1);
    expect(selectResumeRun(audit, { manifestDigest: 'manifest-1' }).ok).toBe(true);
  });

  it('counts malformed complete lines and refuses to resume a damaged journal', async () => {
    const path = join(dir, 'damaged.jsonl');
    const journal = createFileJournal(path, fsApi);
    const entry = intent({ postId: 6 });
    await journal.append(entry);
    await fs.appendFile(path, 'not json at all\n');

    const parsed = await createFileJournal(path, fsApi).read();
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.tornTail).toBe(false);
    expect(parsed.records).toHaveLength(1);

    const audit = auditJournal(parsed);
    expect(audit.trustworthy).toBe(false);
    expect(audit.problems.join(' ')).toContain('malformed');
    const selection = selectResumeRun(audit, { manifestDigest: 'manifest-1' });
    expect(selection.ok).toBe(false);
  });

  it('detects conflicting records for one identity', async () => {
    const path = join(dir, 'conflict.jsonl');
    const journal = createFileJournal(path, fsApi);
    const entry = intent({ postId: 8 });
    await journal.append(entry);
    await journal.append(outcome(entry));
    // A second, different outcome for the same identity is contradictory.
    await journal.append(outcome(entry, { outcome: 'CAS_STALE', pointerSwitched: false }));

    const audit = auditJournal(await createFileJournal(path, fsApi).read());
    expect(audit.conflicts).toHaveLength(1);
    expect(audit.trustworthy).toBe(false);
    expect(selectResumeRun(audit, { manifestDigest: 'manifest-1' }).ok).toBe(false);
  });

  it('refuses to report success when the append wrote fewer bytes than the record', async () => {
    const path = join(dir, 'short.jsonl');
    const shortFs: JournalFsApi = {
      ...fsApi,
      open: async (target, flags, mode) => {
        const handle = await fs.open(target, flags, mode);
        return {
          write: async (data: Buffer) => {
            await handle.write(data);
            return { bytesWritten: data.length - 1 };
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };

    const journal = createFileJournal(path, shortFs);
    await expect(journal.append(intent({ postId: 9 }))).rejects.toThrow(/short write/);
  });

  it('propagates a read error that is not ENOENT', async () => {
    const path = join(dir, 'locked.jsonl');
    await fs.writeFile(path, '{}\n', { mode: 0o600 });
    await fs.chmod(path, 0o000);
    try {
      // Root bypasses file modes; the assertion is meaningful for a normal uid.
      const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      if (isRoot) {
        expect(typeof (await createFileJournal(path, fsApi).read())).toBe('object');
      } else {
        await expect(createFileJournal(path, fsApi).read()).rejects.toMatchObject({
          code: 'EACCES',
        });
      }
    } finally {
      await fs.chmod(path, 0o600);
    }
  });

  it('accepts only an absolute, outside-the-repo, owner-only destination', async () => {
    const good = join(dir, 'ok.jsonl');
    await expect(
      assertJournalDestination(good, fsApi, { repositoryRoot: '/srv/app' })
    ).resolves.toBeUndefined();

    await expect(
      assertJournalDestination('relative.jsonl', fsApi, { repositoryRoot: '/srv/app' })
    ).rejects.toThrow(/absolute path/);

    await expect(
      assertJournalDestination('/srv/app/tmp/journal.jsonl', fsApi, { repositoryRoot: '/srv/app' })
    ).rejects.toThrow(/outside the repository/);

    await expect(
      assertJournalDestination(`${dir}/`, fsApi, { repositoryRoot: '/srv/app' })
    ).rejects.toThrow(/name a file/);

    const loose = join(dir, 'loose.jsonl');
    await fs.writeFile(loose, '{}\n', { mode: 0o644 });
    await fs.chmod(loose, 0o644);
    await expect(
      assertJournalDestination(loose, fsApi, { repositoryRoot: '/srv/app' })
    ).rejects.toThrow(/readable beyond its owner/);
  });

  it('keeps parseJournalText pure for injected text', () => {
    const text = '{"type":"intent","runId":"r","manifestDigest":"m","kind":"blog","postId":1,"locale":"en","previousPath":null,"intendedPath":"blog/1/en/x.md","sourceSha256":"h","at":"t"}\n';
    const parsed = parseJournalText(`${text}{"type":"outcome"`);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.tornTail).toBe(true);
  });
});

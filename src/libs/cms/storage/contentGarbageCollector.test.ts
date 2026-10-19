import { describe, expect, it } from 'vitest';
import type {
  PostBodyReader,
  PostBodyRow,
} from '@/libs/cms/storage/backfillPlan';
import {
  ASSET_BUCKET_DEV,
  CONTENT_BUCKET_DEV,
} from '@/libs/cms/storage/contentBucket';
import {
  assertContentGcAllowed,
  assertContentGcApplyAcknowledged,
  CONTENT_GC_COMMAND,
  type ContentGcEnv,
  type ContentObjectApi,
  type ContentObjectRow,
  contentGcExitCode,
  DEFAULT_RETENTION_DAYS,
  GC_APP_ENV,
  GC_APPLY_ACK_ENV,
  GC_APPLY_ACK_VALUE,
  GC_BUCKET,
  GC_DELETE_BATCH_SIZE,
  GC_PROJECT_REF,
  GC_SCHEMA,
  humanContentGcLines,
  listContentObjects,
  MIN_RETENTION_DAYS,
  parseContentGcArgs,
  parseContentObjectKey,
  planContentGc,
  readContentGcApplyAck,
  readContentReferences,
  runContentGc,
  validateGcRetention,
} from '@/libs/cms/storage/contentGarbageCollector';
import { BLOG_ASSET_ROOT, CAREER_ASSET_ROOT } from '@/libs/cms/storage/paths';

/**
 * Unit tests for the production Markdown garbage collector, against fake
 * Storage and row surfaces — no network, no project, no deletion.
 *
 * The two real production orphans of the deleted portfolio post 27 are the
 * detection fixtures (same paths, same 45 790 bytes): they are mirrored into
 * the fake bucket and asserted to be the only candidates, so the suite proves
 * the live dry run's expected result. Nothing here ever touches Storage.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

/** The two real orphans (fixtures — never deleted by any test or run). */
const ORPHAN_HASH =
  'a33585f97b99f98c0f44410f4caeb7d032f25dd630d447900576c2c15d357960';
const ORPHAN_EN = `portfolio/27/en/${ORPHAN_HASH}.md`;
const ORPHAN_IT = `portfolio/27/it/${ORPHAN_HASH}.md`;
const ORPHAN_BYTES = 45_790;
const SUPERSEDED_EN = `${BLOG_ASSET_ROOT}/12/en/${'b'.repeat(64)}.md`;

const blogContentKey = (id: number, locale: 'en' | 'it', hash: string) =>
  `${BLOG_ASSET_ROOT}/${id}/${locale}/${hash}.md`;
const REFERENCED_EN = blogContentKey(12, 'en', 'c'.repeat(64));
const REFERENCED_IT = blogContentKey(12, 'it', 'd'.repeat(64));

const PROD_ENV: ContentGcEnv = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: `https://${GC_PROJECT_REF}.supabase.co`,
  hasServerSecret: true,
};

type FakeObject = {
  path: string;
  size: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type FakeStorage = {
  api: ContentObjectApi;
  listCalls: { prefix: string; limit: number; offset: number }[];
  removeCalls: string[][];
  remaining: () => string[];
};

function objectAt(
  path: string,
  ageDays: number,
  size: number | null = 1024
): FakeObject {
  const createdAt = new Date(NOW - ageDays * DAY).toISOString();
  return { path, size, createdAt, updatedAt: createdAt };
}

function fakeStorage(
  initial: FakeObject[],
  options: { removeError?: string } = {}
): FakeStorage {
  const objects = new Map(initial.map((object) => [object.path, object]));
  const listCalls: FakeStorage['listCalls'] = [];
  const removeCalls: string[][] = [];
  const api: ContentObjectApi = {
    async list(path, listOptions) {
      const limit = listOptions?.limit ?? 100;
      const offset = listOptions?.offset ?? 0;
      listCalls.push({ prefix: path, limit, offset });
      const prefix = path === '' ? '' : `${path}/`;
      const children = new Map<string, ContentObjectRow>();
      for (const object of objects.values()) {
        if (!object.path.startsWith(prefix)) continue;
        const rest = object.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          children.set(rest, {
            name: rest,
            id: `id:${object.path}`,
            created_at: object.createdAt,
            updated_at: object.updatedAt,
            metadata: { size: object.size },
          });
          continue;
        }
        const folder = rest.slice(0, slash);
        if (!children.has(folder)) {
          // Storage reports a folder as an entry with a null id.
          children.set(folder, { name: folder, id: null });
        }
      }
      const names = [...children.keys()].sort();
      return {
        data: names
          .slice(offset, offset + limit)
          .map((name) => children.get(name) as ContentObjectRow),
        error: null,
      };
    },
    async remove(paths) {
      removeCalls.push([...paths]);
      if (options.removeError) {
        return { data: null, error: { message: options.removeError } };
      }
      for (const path of paths) objects.delete(path);
      return { data: paths.map((path) => ({ name: path })), error: null };
    },
  };
  return {
    api,
    listCalls,
    removeCalls,
    remaining: () => [...objects.keys()].sort(),
  };
}

type FakeReader = { reader: PostBodyReader; reads: () => number };

/**
 * A reader that returns one snapshot per pair of calls, so a test can change
 * the references between the planning read and the pre-delete re-check.
 */
function fakeReader(
  snapshots: Partial<Record<'blog' | 'portfolio', PostBodyRow[]>>[]
): FakeReader {
  let calls = 0;
  return {
    reads: () => calls,
    reader: {
      async listPostBodies(kind) {
        const index = Math.min(Math.floor(calls / 2), snapshots.length - 1);
        calls += 1;
        return snapshots[index][kind] ?? [];
      },
    },
  };
}

function row(
  id: number,
  pointers: { en?: string | null; it?: string | null } = {}
): PostBodyRow {
  return {
    id,
    body_en: null,
    body_it: null,
    body_en_path: pointers.en ?? null,
    body_it_path: pointers.it ?? null,
  };
}

function pathsOf(list: { path: string }[]): string[] {
  return list.map((entry) => entry.path);
}

describe('content key parsing', () => {
  it('accepts only the canonical immutable key', () => {
    expect(parseContentObjectKey(ORPHAN_EN)).toEqual({
      kind: 'portfolio',
      postId: 27,
      locale: 'en',
      hash: ORPHAN_HASH,
    });
    for (const path of [
      'portfolio/27/en/notahash.md',
      `portfolio/27/en/${ORPHAN_HASH}.txt`,
      `portfolio/0/en/${ORPHAN_HASH}.md`,
      `career/${ORPHAN_HASH}.md`,
      `blog/staging/${ORPHAN_HASH}.md`,
      `portfolio/27/en/${ORPHAN_HASH}.md/extra`,
    ]) {
      expect(parseContentObjectKey(path)).toBeNull();
    }
  });
});

describe('garbage collection targeting', () => {
  it('pins the production bucket, schema, project and environment', () => {
    expect(GC_BUCKET).toBe('website-content');
    expect(GC_SCHEMA).toBe('public');
    expect(GC_APP_ENV).toBe('production');
    expect(GC_PROJECT_REF).toBe('mtvwynyikouqzmhqespl');
    expect(GC_BUCKET).not.toBe(CONTENT_BUCKET_DEV);
    expect(GC_BUCKET).not.toBe(ASSET_BUCKET_DEV);
    expect(GC_BUCKET).not.toBe('website');
    expect(GC_BUCKET).not.toBe('website-dev');
  });
});

describe('storage enumeration', () => {
  it('walks folders, paginates a large folder and sorts by path', async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      objectAt(`blob/file-${String(index).padStart(3, '0')}.md`, 30)
    );
    const objects = [
      ...many,
      objectAt(ORPHAN_EN, 30, ORPHAN_BYTES),
      objectAt(ORPHAN_IT, 30, ORPHAN_BYTES),
      objectAt(`${CAREER_ASSET_ROOT}/logo.svg`, 30, 900),
    ];
    const storage = fakeStorage(objects);
    const listed = await listContentObjects(storage.api, { now: NOW });

    expect(listed).toHaveLength(objects.length);
    expect(pathsOf(listed)).toEqual([...objects.map((o) => o.path)].sort());
    // The `blob` folder holds 120 objects, so its second page is requested.
    expect(storage.listCalls).toContainEqual({
      prefix: 'blob',
      limit: 100,
      offset: 100,
    });
    expect(storage.listCalls).toContainEqual({
      prefix: '',
      limit: 100,
      offset: 0,
    });
  });

  it('fails closed when Storage reports an error', async () => {
    const api: ContentObjectApi = {
      async list() {
        return { data: null, error: { message: 'permission denied' } };
      },
      async remove() {
        return { data: null, error: null };
      },
    };
    await expect(listContentObjects(api, { now: NOW })).rejects.toThrow(
      /listing '\/' failed: permission denied/
    );
  });

  it('treats an object without a parseable timestamp as age-unknown', async () => {
    const storage = fakeStorage([
      { path: ORPHAN_EN, size: null, createdAt: null, updatedAt: null },
    ]);
    const listed = await listContentObjects(storage.api, { now: NOW });
    expect(listed[0]).toMatchObject({
      path: ORPHAN_EN,
      sizeBytes: null,
      createdAt: null,
      ageMs: null,
    });
  });
});

describe('references', () => {
  it('collects both pointer columns of both tables', async () => {
    const { reader } = fakeReader([
      {
        blog: [row(12, { en: REFERENCED_EN, it: REFERENCED_IT })],
        portfolio: [row(27, {})],
      },
    ]);
    const references = await readContentReferences(reader);
    expect([...references.paths].sort()).toEqual([
      REFERENCED_EN,
      REFERENCED_IT,
    ]);
    expect(references.rowCounts).toEqual({ blog: 1, portfolio: 1 });
    expect(references.pointerCount).toBe(2);
    expect(references.distinctPointerCount).toBe(2);
    expect(references.byKind.get('portfolio')?.get(27)).toEqual({
      en: null,
      it: null,
    });
  });
});

describe('orphan detection', () => {
  it('finds exactly the two real orphans and nothing else', () => {
    const plan = planContentGc({
      objects: [
        {
          path: ORPHAN_EN,
          sizeBytes: ORPHAN_BYTES,
          createdAt: new Date(NOW - 30 * DAY).toISOString(),
          updatedAt: new Date(NOW - 30 * DAY).toISOString(),
          ageMs: 30 * DAY,
        },
        {
          path: ORPHAN_IT,
          sizeBytes: ORPHAN_BYTES,
          createdAt: new Date(NOW - 30 * DAY).toISOString(),
          updatedAt: new Date(NOW - 30 * DAY).toISOString(),
          ageMs: 30 * DAY,
        },
      ],
      references: {
        paths: new Set([REFERENCED_EN, REFERENCED_IT]),
        byKind: new Map([
          ['blog', new Map([[12, { en: REFERENCED_EN, it: REFERENCED_IT }]])],
          ['portfolio', new Map()],
        ]),
        rowCounts: { blog: 1, portfolio: 0 },
        pointerCount: 2,
        distinctPointerCount: 2,
      },
      retentionMs: 14 * DAY,
      now: NOW,
    });

    expect(pathsOf(plan.candidates)).toEqual([ORPHAN_EN, ORPHAN_IT]);
    expect(pathsOf(plan.deferred)).toEqual([]);
    expect(plan.protectedPaths).toEqual([]);
    expect(plan.candidates.map((c) => c.classification)).toEqual([
      'orphan',
      'orphan',
    ]);
    expect(plan.candidates.map((c) => c.sizeBytes)).toEqual([
      ORPHAN_BYTES,
      ORPHAN_BYTES,
    ]);
  });
});

describe('candidate classification', () => {
  it('protects referenced objects and unmanaged files', async () => {
    const storage = fakeStorage([
      objectAt(REFERENCED_EN, 30),
      objectAt(ORPHAN_EN, 30, ORPHAN_BYTES),
      objectAt(`${CAREER_ASSET_ROOT}/logo.svg`, 30),
      objectAt(`${BLOG_ASSET_ROOT}/staging/photo.webp`, 30),
    ]);
    const { reader } = fakeReader([
      { blog: [row(12, { en: REFERENCED_EN })], portfolio: [] },
    ]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });

    expect(pathsOf(report.candidates)).toEqual([ORPHAN_EN]);
    expect(report.protectedPaths).toEqual([REFERENCED_EN]);
    expect(report.unmanaged).toEqual([
      `${BLOG_ASSET_ROOT}/staging/photo.webp`,
      `${CAREER_ASSET_ROOT}/logo.svg`,
    ]);
    expect(report.summary).toMatchObject({
      candidates: 1,
      deferred: 0,
      referenced: 1,
      unmanaged: 2,
      mutations: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
    });
    expect(storage.removeCalls).toEqual([]);
  });

  it('calls a version superseded once its post points at another hash', async () => {
    const storage = fakeStorage([
      objectAt(REFERENCED_EN, 1),
      objectAt(SUPERSEDED_EN, 30),
    ]);
    const { reader } = fakeReader([
      { blog: [row(12, { en: REFERENCED_EN })], portfolio: [] },
    ]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });

    expect(pathsOf(report.candidates)).toEqual([SUPERSEDED_EN]);
    expect(report.candidates[0].classification).toBe('superseded');
    expect(report.candidates[0].key).toMatchObject({
      kind: 'blog',
      postId: 12,
      locale: 'en',
    });
  });

  it('reports a pointer whose object is absent from the bucket', async () => {
    const missing = blogContentKey(99, 'en', 'e'.repeat(64));
    const storage = fakeStorage([objectAt(ORPHAN_EN, 30, ORPHAN_BYTES)]);
    const { reader } = fakeReader([{ blog: [row(99, { en: missing })] }]);
    const { report, exitCode } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });

    expect(report.missingReferences).toEqual([missing]);
    expect(report.summary.candidates).toBe(1);
    expect(exitCode).toBe(1);
  });
});

describe('retention and grace period', () => {
  it('defers an object that is younger than the retention window', async () => {
    const storage = fakeStorage([objectAt(ORPHAN_EN, 3, ORPHAN_BYTES)]);
    const { reader } = fakeReader([{ portfolio: [] }]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });

    expect(report.candidates).toEqual([]);
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({
      path: ORPHAN_EN,
      disposition: 'deferred',
      classification: 'orphan',
      hold: 'grace-period',
      retentionRemainingMs: 11 * DAY,
    });
    expect(report.ok).toBe(true);
    expect(storage.removeCalls).toEqual([]);
  });

  it('collects exactly at the retention boundary', async () => {
    const storage = fakeStorage([objectAt(ORPHAN_EN, 14, ORPHAN_BYTES)]);
    const { reader } = fakeReader([{ portfolio: [] }]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });
    expect(pathsOf(report.candidates)).toEqual([ORPHAN_EN]);
    expect(report.deferred).toEqual([]);
  });

  it('protects an object re-uploaded inside the window', async () => {
    const storage = fakeStorage([
      {
        path: ORPHAN_EN,
        size: ORPHAN_BYTES,
        createdAt: new Date(NOW - 40 * DAY).toISOString(),
        updatedAt: new Date(NOW - 2 * DAY).toISOString(),
      },
    ]);
    const { reader } = fakeReader([{ portfolio: [] }]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });
    expect(report.candidates).toEqual([]);
    expect(report.deferred[0].hold).toBe('grace-period');
    expect(report.deferred[0].ageMs).toBe(2 * DAY);
  });

  it('never collects an object whose age is unknown', async () => {
    const storage = fakeStorage([
      { path: ORPHAN_EN, size: ORPHAN_BYTES, createdAt: null, updatedAt: null },
    ]);
    const { reader } = fakeReader([{ portfolio: [] }]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader,
      options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 14 },
      now: () => NOW,
    });
    expect(report.candidates).toEqual([]);
    expect(report.deferred[0].hold).toBe('unknown-age');
    expect(storage.removeCalls).toEqual([]);
  });

  it('validates the retention configuration, floor included', () => {
    expect(validateGcRetention(0, false)).toBeNull();
    expect(validateGcRetention(0, true)).toMatch(/at least 1 day/);
    expect(validateGcRetention(MIN_RETENTION_DAYS, true)).toBeNull();
    expect(validateGcRetention(-1, false)).toMatch(/non-negative integer/);
    expect(validateGcRetention(1.5, false)).toMatch(/non-negative integer/);
    expect(parseContentGcArgs([])).toEqual({
      mode: 'dry-run',
      retentionDays: DEFAULT_RETENTION_DAYS,
      json: false,
    });
    expect(parseContentGcArgs(['--retention-days=30', '--json'])).toEqual({
      mode: 'dry-run',
      retentionDays: 30,
      json: true,
    });
    expect(parseContentGcArgs(['--apply'])).toMatchObject({ mode: 'apply' });
    expect(parseContentGcArgs(['--apply', '--retention-days=0'])).toMatchObject(
      {
        mode: 'invalid',
      }
    );
    expect(parseContentGcArgs(['--apply', '--apply'])).toMatchObject({
      mode: 'invalid',
    });
    expect(parseContentGcArgs(['--cleanup'])).toEqual({
      mode: 'invalid',
      error: 'unexpected argument: --cleanup',
    });
    expect(parseContentGcArgs(['--retention-days=abc'])).toMatchObject({
      mode: 'invalid',
    });
    expect(parseContentGcArgs(['--help'])).toEqual({ mode: 'help' });
  });
});

describe('dry run', () => {
  it('performs zero API mutations and reports both orphans', async () => {
    const storage = fakeStorage([
      objectAt(REFERENCED_EN, 30),
      objectAt(ORPHAN_EN, 30, ORPHAN_BYTES),
      objectAt(ORPHAN_IT, 30, ORPHAN_BYTES),
      objectAt(`${CAREER_ASSET_ROOT}/logo.svg`, 30),
    ]);
    const fake = fakeReader([
      { blog: [row(12, { en: REFERENCED_EN })], portfolio: [] },
    ]);
    const { report, exitCode } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });

    expect(report.mode).toBe('dry-run');
    expect(pathsOf(report.candidates)).toEqual([ORPHAN_EN, ORPHAN_IT]);
    expect(report.summary).toMatchObject({
      candidates: 2,
      mutations: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      recheckReads: 0,
    });
    expect(report.deletions).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
    expect(storage.remaining()).toHaveLength(4);
    expect(exitCode).toBe(1);

    const lines = humanContentGcLines(report);
    expect(lines.some((line) => line.includes(ORPHAN_EN))).toBe(true);
    expect(lines.some((line) => line.includes(ORPHAN_IT))).toBe(true);
    expect(
      lines.some((line) => line.includes('no mutation was performed'))
    ).toBe(true);

    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(Object.keys(roundTripped).sort()).toEqual(
      [
        'bucket',
        'candidates',
        'command',
        'deferred',
        'deletions',
        'failures',
        'generatedAt',
        'inventory',
        'missingReferences',
        'mode',
        'ok',
        'protectedPaths',
        'references',
        'retentionDays',
        'schema',
        'summary',
        'unmanaged',
        'appEnv',
        'projectRef',
      ].sort()
    );
    expect(roundTripped.command).toBe(CONTENT_GC_COMMAND);
    expect(roundTripped.retentionDays).toBe(14);
    expect(roundTripped.generatedAt).toBe(new Date(NOW).toISOString());
    expect(roundTripped.references).toMatchObject({
      rows: { blog: 1, portfolio: 0 },
      pointers: 1,
      distinctPointers: 1,
    });
    expect(roundTripped.inventory).toMatchObject({
      objects: 4,
      unsizedObjects: 0,
    });
  });

  it('settles with exit code 0 when nothing is collectable', async () => {
    const storage = fakeStorage([objectAt(REFERENCED_EN, 30)]);
    const fake = fakeReader([
      { blog: [row(12, { en: REFERENCED_EN })], portfolio: [] },
    ]);
    const { report, exitCode } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: false, ack: undefined, retentionDays: 14 },
      now: () => NOW,
    });
    expect(report.ok).toBe(true);
    expect(exitCode).toBe(0);
    expect(contentGcExitCode(report)).toBe(0);
  });
});

describe('apply', () => {
  it('deletes only the candidates and records the audit trail', async () => {
    const storage = fakeStorage([
      objectAt(REFERENCED_EN, 30),
      objectAt(ORPHAN_EN, 30, ORPHAN_BYTES),
      objectAt(ORPHAN_IT, 30, ORPHAN_BYTES),
      objectAt(`${CAREER_ASSET_ROOT}/logo.svg`, 30),
    ]);
    const fake = fakeReader([
      { blog: [row(12, { en: REFERENCED_EN })], portfolio: [] },
    ]);
    const { report, exitCode } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 14 },
      now: () => NOW,
    });

    expect(storage.removeCalls).toEqual([[ORPHAN_EN, ORPHAN_IT]]);
    expect(storage.remaining()).toEqual([
      REFERENCED_EN,
      `${CAREER_ASSET_ROOT}/logo.svg`,
    ]);
    expect(report.mode).toBe('apply');
    expect(report.summary).toMatchObject({
      candidates: 2,
      mutations: 1,
      recheckReads: 1,
      deleted: 2,
      failed: 0,
      skipped: 0,
    });
    expect(report.deletions).toEqual([
      {
        path: ORPHAN_EN,
        outcome: 'deleted',
        reason: null,
        at: new Date(NOW).toISOString(),
      },
      {
        path: ORPHAN_IT,
        outcome: 'deleted',
        reason: null,
        at: new Date(NOW).toISOString(),
      },
    ]);
    expect(exitCode).toBe(0);
    // One planning snapshot (2 reads) plus one re-check (2 reads).
    expect(fake.reads()).toBe(4);
  });

  it('skips a candidate that is referenced again before the delete call', async () => {
    const storage = fakeStorage([
      objectAt(ORPHAN_EN, 30, ORPHAN_BYTES),
      objectAt(ORPHAN_IT, 30, ORPHAN_BYTES),
    ]);
    // Planning sees an empty portfolio table; the re-check sees row 27 with the
    // EN object freshly committed as its pointer.
    const fake = fakeReader([
      { blog: [], portfolio: [] },
      { blog: [], portfolio: [row(27, { en: ORPHAN_EN })] },
    ]);
    const { report, exitCode } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 14 },
      now: () => NOW,
    });

    expect(report.summary.candidates).toBe(2);
    expect(report.deletions).toEqual([
      {
        path: ORPHAN_EN,
        outcome: 'skipped',
        reason: 'referenced-on-recheck',
        at: new Date(NOW).toISOString(),
      },
      {
        path: ORPHAN_IT,
        outcome: 'deleted',
        reason: null,
        at: new Date(NOW).toISOString(),
      },
    ]);
    expect(storage.removeCalls).toEqual([[ORPHAN_IT]]);
    expect(storage.remaining()).toEqual([ORPHAN_EN]);
    expect(report.summary).toMatchObject({ deleted: 1, skipped: 1, failed: 0 });
    expect(exitCode).toBe(1);
  });

  it('makes no call at all when the re-check removes every candidate', async () => {
    const storage = fakeStorage([objectAt(ORPHAN_EN, 30, ORPHAN_BYTES)]);
    const fake = fakeReader([
      { blog: [], portfolio: [] },
      { blog: [], portfolio: [row(27, { en: ORPHAN_EN })] },
    ]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 14 },
      now: () => NOW,
    });
    expect(storage.removeCalls).toEqual([]);
    expect(report.summary).toMatchObject({ mutations: 0, skipped: 1 });
    expect(report.failures).toEqual([]);
  });

  it('surfaces a Storage delete failure without losing the report', async () => {
    const storage = fakeStorage([objectAt(ORPHAN_EN, 30, ORPHAN_BYTES)], {
      removeError: 'Object not found',
    });
    const fake = fakeReader([{ blog: [], portfolio: [] }]);
    const { report, exitCode } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 14 },
      now: () => NOW,
    });

    expect(report.failures).toEqual([
      { paths: [ORPHAN_EN], message: 'Object not found' },
    ]);
    expect(report.deletions[0]).toMatchObject({
      path: ORPHAN_EN,
      outcome: 'failed',
      reason: 'Object not found',
    });
    expect(report.summary).toMatchObject({
      deleted: 0,
      failed: 1,
      mutations: 1,
    });
    expect(report.ok).toBe(false);
    expect(exitCode).toBe(1);
    expect(storage.remaining()).toEqual([ORPHAN_EN]);
  });

  it('batches the delete calls', async () => {
    const objects = Array.from(
      { length: GC_DELETE_BATCH_SIZE + 1 },
      (_, index) =>
        objectAt(`portfolio/${index + 1}/en/${'f'.repeat(64)}.md`, 30)
    );
    const storage = fakeStorage(objects);
    const fake = fakeReader([{ blog: [], portfolio: [] }]);
    const { report } = await runContentGc({
      env: PROD_ENV,
      storage: storage.api,
      reader: fake.reader,
      options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 14 },
      now: () => NOW,
    });
    expect(storage.removeCalls.map((call) => call.length)).toEqual([
      GC_DELETE_BATCH_SIZE,
      1,
    ]);
    expect(report.summary).toMatchObject({
      mutations: 2,
      recheckReads: 2,
      deleted: GC_DELETE_BATCH_SIZE + 1,
    });
    expect(storage.remaining()).toEqual([]);
  });
});

describe('environment gate', () => {
  const cases: { name: string; env: ContentGcEnv; pattern: RegExp }[] = [
    {
      name: 'dev application environment',
      env: { ...PROD_ENV, appEnv: 'development' },
      pattern: /APP_ENV must be exactly 'production'/,
    },
    {
      name: 'dev schema',
      env: { ...PROD_ENV, schema: 'dev_staging' },
      pattern: /must be 'public'/,
    },
    {
      name: 'another project',
      env: {
        ...PROD_ENV,
        supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      },
      pattern: /project mismatch/,
    },
    {
      name: 'unusable URL',
      env: { ...PROD_ENV, supabaseUrl: 'http://localhost:54321' },
      pattern: /not a usable/,
    },
    {
      name: 'missing URL',
      env: { ...PROD_ENV, supabaseUrl: '' },
      pattern: /missing NEXT_PUBLIC_SUPABASE_URL/,
    },
    {
      name: 'missing server secret',
      env: { ...PROD_ENV, hasServerSecret: false },
      pattern: /missing SUPABASE_SECRET_KEY/,
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name} before any read`, async () => {
      const storage = fakeStorage([objectAt(ORPHAN_EN, 30, ORPHAN_BYTES)]);
      const fake = fakeReader([{ portfolio: [] }]);
      expect(() => assertContentGcAllowed(testCase.env)).toThrow(
        testCase.pattern
      );
      await expect(
        runContentGc({
          env: testCase.env,
          storage: storage.api,
          reader: fake.reader,
          options: { apply: false, ack: undefined, retentionDays: 14 },
          now: () => NOW,
        })
      ).rejects.toThrow(testCase.pattern);
      expect(storage.listCalls).toEqual([]);
      expect(fake.reads()).toBe(0);
    });
  }

  it('refuses an apply without the production acknowledgement, before any read', async () => {
    const storage = fakeStorage([objectAt(ORPHAN_EN, 30, ORPHAN_BYTES)]);
    const fake = fakeReader([{ portfolio: [] }]);
    expect(() => assertContentGcApplyAcknowledged(undefined)).toThrow(
      new RegExp(`${GC_APPLY_ACK_ENV}=${GC_APPLY_ACK_VALUE}`)
    );
    expect(() =>
      assertContentGcApplyAcknowledged('yes-apply-to-production')
    ).toThrow(/refusing to delete/);
    await expect(
      runContentGc({
        env: PROD_ENV,
        storage: storage.api,
        reader: fake.reader,
        options: { apply: true, ack: undefined, retentionDays: 14 },
        now: () => NOW,
      })
    ).rejects.toThrow(/refusing to delete/);
    expect(storage.listCalls).toEqual([]);
    expect(fake.reads()).toBe(0);
    expect(
      readContentGcApplyAck({ [GC_APPLY_ACK_ENV]: GC_APPLY_ACK_VALUE })
    ).toBe(GC_APPLY_ACK_VALUE);
    expect(readContentGcApplyAck({})).toBeUndefined();
  });

  it('refuses a deletion run inside the retention floor before any read', async () => {
    const storage = fakeStorage([]);
    const fake = fakeReader([{ blog: [], portfolio: [] }]);
    await expect(
      runContentGc({
        env: PROD_ENV,
        storage: storage.api,
        reader: fake.reader,
        options: { apply: true, ack: GC_APPLY_ACK_VALUE, retentionDays: 0 },
        now: () => NOW,
      })
    ).rejects.toThrow(/at least 1 day\(s\) of grace/);
    expect(storage.listCalls).toEqual([]);
  });

  it('surfaces a row-read failure', async () => {
    const storage = fakeStorage([]);
    const reader: PostBodyReader = {
      async listPostBodies() {
        throw new Error('[content-gc] reading public.blog_posts failed: boom');
      },
    };
    await expect(
      runContentGc({
        env: PROD_ENV,
        storage: storage.api,
        reader,
        options: { apply: false, ack: undefined, retentionDays: 14 },
        now: () => NOW,
      })
    ).rejects.toThrow(/reading public\.blog_posts failed: boom/);
    expect(storage.removeCalls).toEqual([]);
  });
});

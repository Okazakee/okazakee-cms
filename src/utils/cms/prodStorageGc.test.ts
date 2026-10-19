import { describe, expect, it, vi } from 'vitest';
import type {
  PostBodyReader,
  PostBodyRow,
} from '@/libs/cms/storage/backfillPlan';
import {
  CONTENT_GC_COMMAND,
  type ContentGcEnv,
  type ContentGcReport,
  type ContentObjectApi,
  type ContentObjectRow,
  GC_APPLY_ACK_ENV,
  GC_APPLY_ACK_VALUE,
  GC_BUCKET,
  GC_PROJECT_REF,
  PROD_STORAGE_GC_USAGE,
} from '@/libs/cms/storage/contentGarbageCollector';
import {
  FORBIDDEN_GC_BUCKETS,
  PROD_STORAGE_GC_BUCKET,
  type ProdStorageGcCliDeps,
  runProdStorageGcCli,
} from '@/utils/cms/prodStorageGc';

/**
 * CLI gate/exit-code suite for the production GC. Every case injects fakes, so
 * no network, database or Storage is ever touched and the two real orphan
 * fixtures are only ever read from an in-memory bucket.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const ORPHAN_HASH =
  'a33585f97b99f98c0f44410f4caeb7d032f25dd630d447900576c2c15d357960';
const ORPHAN_EN = `portfolio/27/en/${ORPHAN_HASH}.md`;
const ORPHAN_IT = `portfolio/27/it/${ORPHAN_HASH}.md`;
const ORPHAN_BYTES = 45_790;
const REFERENCED_EN = `blog/12/en/${'c'.repeat(64)}.md`;

const PROD_ENV: ContentGcEnv = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: `https://${GC_PROJECT_REF}.supabase.co`,
  hasServerSecret: true,
};

/** The production bucket as the tests model it: both orphans plus one live body. */
const BUCKET: { path: string; size: number; ageDays: number }[] = [
  { path: ORPHAN_EN, size: ORPHAN_BYTES, ageDays: 30 },
  { path: ORPHAN_IT, size: ORPHAN_BYTES, ageDays: 30 },
  { path: REFERENCED_EN, size: 512, ageDays: 30 },
];

type FakeStorage = {
  api: ContentObjectApi;
  removeCalls: string[][];
  remaining: () => string[];
};

function fakeStorage(
  options: { objects?: typeof BUCKET; removeError?: string } = {}
): FakeStorage {
  const objects = new Map(
    (options.objects ?? BUCKET).map((object) => [object.path, object])
  );
  const removeCalls: string[][] = [];
  const api: ContentObjectApi = {
    async list(path, listOptions) {
      const limit = listOptions?.limit ?? 100;
      const offset = listOptions?.offset ?? 0;
      const prefix = path === '' ? '' : `${path}/`;
      const children = new Map<string, ContentObjectRow>();
      for (const object of objects.values()) {
        if (!object.path.startsWith(prefix)) continue;
        const rest = object.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          const created = new Date(NOW - object.ageDays * DAY).toISOString();
          children.set(rest, {
            name: rest,
            id: `id:${object.path}`,
            created_at: created,
            updated_at: created,
            metadata: { size: object.size },
          });
          continue;
        }
        const folder = rest.slice(0, slash);
        if (!children.has(folder)) {
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
      return { data: null, error: null };
    },
  };
  return { api, removeCalls, remaining: () => [...objects.keys()].sort() };
}

/** Points blog post 12 at REFERENCED_EN; the portfolio table is empty. */
function referencedReader(): PostBodyReader {
  const rows: PostBodyRow[] = [
    {
      id: 12,
      body_en: null,
      body_it: null,
      body_en_path: REFERENCED_EN,
      body_it_path: null,
    },
  ];
  return {
    async listPostBodies(kind) {
      return kind === 'blog' ? rows : [];
    },
  };
}

type Harness = ProdStorageGcCliDeps & {
  storage: FakeStorage;
  opened: { storage: number; reader: number };
};

function deps(
  argv: string[],
  overrides: Partial<ProdStorageGcCliDeps> = {},
  storageOptions: { objects?: typeof BUCKET; removeError?: string } = {}
): Harness {
  const storage = fakeStorage(storageOptions);
  const opened = { storage: 0, reader: 0 };
  return {
    argv,
    observed: PROD_ENV,
    env: { [GC_APPLY_ACK_ENV]: GC_APPLY_ACK_VALUE },
    openStorage: () => {
      opened.storage += 1;
      return storage.api;
    },
    openReader: () => {
      opened.reader += 1;
      return referencedReader();
    },
    now: () => NOW,
    storage,
    opened,
    ...overrides,
  };
}

function orphanPaths(report: ContentGcReport | null): string[] {
  return (report?.candidates ?? []).map((candidate) => candidate.path);
}

describe('production GC CLI', () => {
  it('pins a bucket no GC run may cross', () => {
    expect(PROD_STORAGE_GC_BUCKET).toBe('website-content');
    expect(PROD_STORAGE_GC_BUCKET).toBe(GC_BUCKET);
    expect(FORBIDDEN_GC_BUCKETS).toEqual([
      'website-content-dev',
      'website-dev',
      'website',
    ]);
    expect(FORBIDDEN_GC_BUCKETS).not.toContain(PROD_STORAGE_GC_BUCKET);
  });

  it('dry runs by default: reports both orphans and mutates nothing', async () => {
    const harness = deps(['--retention-days=30']);
    const outcome = await runProdStorageGcCli(harness);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBeNull();
    expect(outcome.report?.mode).toBe('dry-run');
    expect(outcome.report?.command).toBe(CONTENT_GC_COMMAND);
    expect(outcome.report?.retentionDays).toBe(30);
    expect(orphanPaths(outcome.report)).toEqual([ORPHAN_EN, ORPHAN_IT]);
    expect(outcome.report?.summary).toMatchObject({
      candidates: 2,
      mutations: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
    });
    expect(harness.storage.removeCalls).toEqual([]);
    expect(harness.storage.remaining()).toHaveLength(3);
    expect(harness.opened).toEqual({ storage: 1, reader: 1 });

    const lines = outcome.lines.join('\n');
    expect(lines).toContain(ORPHAN_EN);
    expect(lines).toContain(ORPHAN_IT);
    expect(lines).toContain('referenced=1');
    expect(lines).toContain('no mutation was performed');
    expect(JSON.parse(JSON.stringify(outcome.report))).toMatchObject({
      bucket: 'website-content',
      projectRef: GC_PROJECT_REF,
    });
  });

  it('prints only the JSON report with --json', async () => {
    const outcome = await runProdStorageGcCli(deps(['--json']));
    expect(outcome.report).not.toBeNull();
    expect(outcome.lines).toEqual([]);
  });

  it('exits 0 when nothing is collectable', async () => {
    const outcome = await runProdStorageGcCli(
      deps([], {}, { objects: [{ ...BUCKET[2] }] })
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.ok).toBe(true);
    expect(outcome.report?.summary).toMatchObject({ candidates: 0 });
    expect(outcome.lines.join('\n')).toContain('nothing to delete');
  });

  it('deletes exactly the candidates when armed', async () => {
    const harness = deps(['--apply', '--retention-days=30']);
    const outcome = await runProdStorageGcCli(harness);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.mode).toBe('apply');
    expect(harness.storage.removeCalls).toEqual([[ORPHAN_EN, ORPHAN_IT]]);
    expect(harness.storage.remaining()).toEqual([REFERENCED_EN]);
    expect(outcome.report?.summary).toMatchObject({
      mutations: 1,
      deleted: 2,
      failed: 0,
      skipped: 0,
    });
    expect(outcome.lines.join('\n')).toContain(`deletion deleted ${ORPHAN_EN}`);
  });

  it('refuses an apply without the acknowledgement, before any client', async () => {
    const harness = deps(['--apply'], { env: {} });
    const outcome = await runProdStorageGcCli(harness);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.error).toContain(
      `${GC_APPLY_ACK_ENV}=${GC_APPLY_ACK_VALUE}`
    );
    expect(harness.opened).toEqual({ storage: 0, reader: 0 });
    expect(harness.storage.removeCalls).toEqual([]);
  });

  it('refuses an apply inside the retention floor as invalid usage', async () => {
    const harness = deps(['--apply', '--retention-days=0']);
    const outcome = await runProdStorageGcCli(harness);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toContain('at least 1 day(s) of grace');
    expect(harness.opened).toEqual({ storage: 0, reader: 0 });
  });

  it('refuses DEV and any other project before any client', async () => {
    for (const observed of [
      { ...PROD_ENV, appEnv: 'development' },
      { ...PROD_ENV, schema: 'dev_staging' },
      { ...PROD_ENV, supabaseUrl: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' },
    ]) {
      const harness = deps([], { observed });
      const outcome = await runProdStorageGcCli(harness);
      expect(outcome.exitCode).toBe(3);
      expect(outcome.report).toBeNull();
      expect(harness.opened).toEqual({ storage: 0, reader: 0 });
    }
  });

  it('surfaces a Storage delete failure as attention, not a crash', async () => {
    const harness = deps(
      ['--apply', '--retention-days=30'],
      {},
      {
        removeError: 'Object not found',
      }
    );
    const outcome = await runProdStorageGcCli(harness);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.failures).toEqual([
      { paths: [ORPHAN_EN, ORPHAN_IT], message: 'Object not found' },
    ]);
    expect(outcome.lines.join('\n')).toContain('apply incomplete');
  });

  it('maps a read failure to exit 4', async () => {
    const harness = deps([], {
      openReader: () => ({
        async listPostBodies() {
          throw new Error('reading public.portfolio_posts failed: boom');
        },
      }),
    });
    const outcome = await runProdStorageGcCli(harness);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('boom');
  });

  it('maps invalid usage to exit 2 and help to exit 0', async () => {
    const invalid = await runProdStorageGcCli(deps(['--purge']));
    expect(invalid.exitCode).toBe(2);
    expect(invalid.error).toContain('unexpected argument: --purge');
    expect(invalid.error).toContain(PROD_STORAGE_GC_USAGE);

    const help = await runProdStorageGcCli(deps(['--help']));
    expect(help.exitCode).toBe(0);
    expect(help.lines).toEqual([PROD_STORAGE_GC_USAGE]);
    expect(help.report).toBeNull();
  });

  it('never calls a client factory when the environment gate refuses', async () => {
    const openStorage = vi.fn(() => {
      throw new Error('openStorage must not be called');
    });
    const outcome = await runProdStorageGcCli(
      deps([], {
        observed: { ...PROD_ENV, appEnv: 'development' },
        openStorage,
      })
    );
    expect(outcome.exitCode).toBe(3);
    expect(openStorage).not.toHaveBeenCalled();
  });
});

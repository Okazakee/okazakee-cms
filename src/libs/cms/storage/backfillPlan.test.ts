import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CONTENT_BYTES,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  BACKFILL_PLAN_BUCKET,
  BACKFILL_PLAN_COMMAND,
  BACKFILL_PLAN_SCHEMA,
  EXPECTED_DEV_PROJECT_REF,
  assertBackfillPlanAllowed,
  buildBackfillPlan,
  buildBackfillPlanReport,
  createPostBodyReader,
  parseBackfillPlanArgs,
  planEntry,
  pointerHashFor,
  projectRefFromUrl,
  runBackfillPlan,
  summarizePlan,
  type BackfillPlanEnv,
  type PostBodyRow,
  type PostBodyReader,
  type ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';

/**
 * Phase 11A planner tests: pure and injected. No network, no Storage client, no
 * database. Every case asserts observable plan output (ordering, hashes, paths,
 * actions, blockers) rather than snapshots.
 *
 * The inventory fixture mirrors the real dev baseline shape: 6 blog rows
 * (ids 1, 8, 9, 12, 18, 19) and 11 portfolio rows (ids 1-5, 21-26) = 17 posts /
 * 34 locale entries.
 */

const BLOG_IDS = [1, 8, 9, 12, 18, 19];
const PORTFOLIO_IDS = [1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26];

const DEV_ENV: BackfillPlanEnv = {
  appEnv: 'development',
  schema: BACKFILL_PLAN_SCHEMA,
  supabaseUrl: `https://${EXPECTED_DEV_PROJECT_REF}.supabase.co`,
  hasServerSecret: true,
};

function row(
  id: number,
  body_en: string | null,
  body_it: string | null,
  body_en_path: string | null = null,
  body_it_path: string | null = null
): PostBodyRow {
  return { id, body_en, body_it, body_en_path, body_it_path };
}

function baselineRows(): {
  blog: PostBodyRow[];
  portfolio: PostBodyRow[];
} {
  return {
    blog: BLOG_IDS.map((id) =>
      row(id, `# blog ${id} EN 🎉\r\n\r\nbody ${id}`, `# blog ${id} IT à\n\ncorpo ${id}`)
    ),
    portfolio: PORTFOLIO_IDS.map((id) =>
      row(id, `# portfolio ${id} EN ✓`, `# portfolio ${id} IT perché`)
    ),
  };
}

function expectedOrder(): string[] {
  return [
    ...BLOG_IDS.flatMap((id) => [`blog:${id}:en`, `blog:${id}:it`]),
    ...PORTFOLIO_IDS.flatMap((id) => [`portfolio:${id}:en`, `portfolio:${id}:it`]),
  ];
}

function fakeReader(rows: {
  blog?: PostBodyRow[];
  portfolio?: PostBodyRow[];
}): PostBodyReader {
  return {
    listPostBodies: async (kind) => rows[kind] ?? [],
  };
}

function hashOf(body: string): string {
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

describe('backfill plan: baseline inventory and ordering', () => {
  it('plans one entry per post and locale for the 17-post baseline', () => {
    const entries = buildBackfillPlan(baselineRows());
    expect(entries).toHaveLength(34);
    expect(entries.every((e) => e.action === 'UPLOAD_AND_POINT')).toBe(true);
    expect(entries.every((e) => e.blockers.length === 0)).toBe(true);

    const summary = summarizePlan(entries);
    expect(summary.entries).toBe(34);
    expect(summary.byAction).toEqual({
      UPLOAD_AND_POINT: 34,
      ALREADY_CURRENT: 0,
      SKIP_EMPTY: 0,
      BLOCKED: 0,
    });
    expect(summary.plannedObjects).toBe(34);
    expect(summary.blockers).toBe(0);
    expect(summary.byEntity.blog.rows).toBe(6);
    expect(summary.byEntity.portfolio.rows).toBe(11);
    expect(summary.byEntity.blog.entries).toBe(12);
    expect(summary.byEntity.portfolio.entries).toBe(22);
    expect(summary.plannedUploadBytes).toBe(
      entries.reduce((total, e) => total + e.sizeBytes, 0)
    );
    expect(summary.totalSourceBytes).toBe(summary.plannedUploadBytes);
  });

  it('orders by entity, then numeric post id, then locale', () => {
    const entries = buildBackfillPlan(baselineRows());
    expect(entries.map((e) => `${e.kind}:${e.postId}:${e.locale}`)).toEqual(
      expectedOrder()
    );
  });

  it('is order-independent for its input rows', () => {
    const rows = baselineRows();
    const shuffled = {
      blog: [...rows.blog].reverse(),
      portfolio: [...rows.portfolio].reverse(),
    };
    expect(JSON.stringify(buildBackfillPlan(shuffled))).toBe(
      JSON.stringify(buildBackfillPlan(rows))
    );
  });

  it('gives every entry a canonical path derived from its own hash', () => {
    for (const entry of buildBackfillPlan(baselineRows())) {
      expect(entry.expectedPath).toBe(
        `${entry.kind}/${entry.postId}/${entry.locale}/${entry.sourceSha256}.md`
      );
    }
  });
});

describe('backfill plan: bytes, hashes and paths', () => {
  it('hashes the exact UTF-8 bytes and reports their size', () => {
    const body = '# Title — ünïcodé ✓ 漢字 🎉\r\n\r\nsecond line\r\n';
    const entry = planEntry('blog', 7, 'en', body, null);
    const bytes = Buffer.from(body, 'utf8');

    expect(entry.action).toBe('UPLOAD_AND_POINT');
    expect(entry.sourceSha256).toBe(hashOf(body));
    expect(entry.sourceSha256).toBe(sha256Hex(bytes));
    expect(entry.sizeBytes).toBe(bytes.length);
    expect(entry.sizeBytes).toBeGreaterThan(body.length);
    expect(entry.expectedPath).toBe(`blog/7/en/${hashOf(body)}.md`);
  });

  it('never normalizes newlines, whitespace or Unicode', () => {
    const crlf = '# t\r\n\r\nbody\r\n';
    const lf = '# t\n\nbody\n';
    const padded = '  body  ';

    const a = planEntry('blog', 1, 'en', crlf, null);
    const b = planEntry('blog', 1, 'en', lf, null);
    const c = planEntry('blog', 1, 'en', padded, null);

    expect(a.sourceSha256).toBe(hashOf(crlf));
    expect(a.sourceSha256).not.toBe(b.sourceSha256);
    expect(a.sizeBytes).not.toBe(b.sizeBytes);
    expect(c.sourceSha256).toBe(hashOf(padded));
    expect(c.sizeBytes).toBe(8);
    // A CRLF body keeps its CR bytes: the LF variant is strictly shorter.
    expect(a.sizeBytes - b.sizeBytes).toBeGreaterThan(0);
  });

  it('accepts a body at exactly the shared size limit and blocks one byte over', () => {
    const atLimit = planEntry(
      'blog',
      1,
      'en',
      'a'.repeat(MAX_BODY_CONTENT_BYTES),
      null
    );
    expect(atLimit.action).toBe('UPLOAD_AND_POINT');
    expect(atLimit.sizeBytes).toBe(MAX_BODY_CONTENT_BYTES);

    const overLimit = planEntry(
      'blog',
      1,
      'en',
      'a'.repeat(MAX_BODY_CONTENT_BYTES + 1),
      null
    );
    expect(overLimit.action).toBe('BLOCKED');
    expect(overLimit.blockers).toHaveLength(1);
    expect(overLimit.blockers[0]).toContain(
      `over the ${MAX_BODY_CONTENT_BYTES} byte limit`
    );
    expect(overLimit.blockers[0]).not.toContain('aaaa');
    expect(overLimit.expectedPath).toBeNull();
  });
});

describe('backfill plan: existing pointers', () => {
  it('marks an already-correct pointer as ALREADY_CURRENT', () => {
    const body = '# unchanged';
    const path = `blog/1/en/${hashOf(body)}.md`;
    const entry = planEntry('blog', 1, 'en', body, path);

    expect(entry.action).toBe('ALREADY_CURRENT');
    expect(entry.blockers).toEqual([]);
    expect(entry.currentPath).toBe(path);
    expect(entry.expectedPath).toBe(path);
    expect(entry.sizeBytes).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('blocks a pointer whose hash disagrees with the legacy body', () => {
    const body = '# current body';
    const stale = `blog/1/en/${hashOf('# previous body')}.md`;
    const entry = planEntry('blog', 1, 'en', body, stale);

    expect(entry.action).toBe('BLOCKED');
    expect(entry.blockers[0]).toMatch(
      /pointer\/body disagreement: pointer hash [0-9a-f]{64} does not match the legacy body hash [0-9a-f]{64}/
    );
    expect(entry.currentPath).toBe(stale);
    // The plan never proposes an overwrite: the intended path is reported only.
    expect(entry.expectedPath).toBe(`blog/1/en/${hashOf(body)}.md`);
  });

  it('blocks pointers that do not belong to this entity, id or locale', () => {
    const body = '# owned by blog 1 EN';
    const hash = hashOf(body);
    const cases: [string, string][] = [
      ['another post', `blog/9/en/${hash}.md`],
      ['another locale', `blog/1/it/${hash}.md`],
      ['another entity', `portfolio/1/en/${hash}.md`],
      ['a non-canonical file name', 'blog/1/en/not-a-hash.md'],
      ['a truncated hash', 'blog/1/en/deadbeef.md'],
      ['a nested path', `blog/1/en/extra/${hash}.md`],
      ['a bare key', `${hash}.md`],
    ];

    for (const [label, pointer] of cases) {
      const entry = planEntry('blog', 1, 'en', body, pointer);
      expect(entry.action, label).toBe('BLOCKED');
      expect(entry.blockers.join(' '), label).toContain('not a canonical');
      expect(pointerHashFor('blog', 1, 'en', pointer), label).toBeNull();
    }
  });

  it('accepts only the canonical pointer shape in pointerHashFor', () => {
    const hash = 'a'.repeat(64);
    expect(pointerHashFor('blog', 1, 'en', `blog/1/en/${hash}.md`)).toBe(hash);
    expect(pointerHashFor('blog', 1, 'en', `blog/1/en/${hash.toUpperCase()}.md`)).toBeNull();
    expect(pointerHashFor('blog', 1, 'it', `blog/1/en/${hash}.md`)).toBeNull();
  });
});

describe('backfill plan: empty and NULL languages', () => {
  it('skips NULL and empty bodies without inventing an object', () => {
    for (const body of [null, '']) {
      const entry = planEntry('blog', 3, 'it', body, null);
      expect(entry.action).toBe('SKIP_EMPTY');
      expect(entry.blockers).toEqual([]);
      expect(entry.sourceSha256).toBeNull();
      expect(entry.sizeBytes).toBe(0);
      expect(entry.expectedPath).toBeNull();
      expect(entry.currentPath).toBeNull();
    }
  });

  it('counts skipped languages separately from planned uploads', () => {
    const rows = {
      blog: [row(1, '# only EN', null)],
      portfolio: [],
    };
    const summary = summarizePlan(buildBackfillPlan(rows));
    expect(summary.byAction.SKIP_EMPTY).toBe(1);
    expect(summary.byAction.UPLOAD_AND_POINT).toBe(1);
    expect(summary.plannedObjects).toBe(1);
    expect(summary.totalSourceBytes).toBe(Buffer.byteLength('# only EN', 'utf8'));
  });

  it('blocks an empty body that still has a pointer set', () => {
    const entry = planEntry('blog', 3, 'en', '', `blog/3/en/${'b'.repeat(64)}.md`);
    expect(entry.action).toBe('BLOCKED');
    expect(entry.blockers.join(' ')).toContain('empty but a pointer is set');
  });

  it('does not treat a whitespace-only body as empty', () => {
    const entry = planEntry('blog', 3, 'en', '   ', null);
    expect(entry.action).toBe('UPLOAD_AND_POINT');
    expect(entry.sizeBytes).toBe(3);
  });
});

describe('backfill plan: unexpected rows', () => {
  it('blocks duplicate records for the same entity, id and locale', () => {
    const rows = {
      blog: [row(1, '# a', '# b'), row(1, '# a', '# b')],
      portfolio: [],
    };
    const entries = buildBackfillPlan(rows);
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.action === 'BLOCKED')).toBe(true);
    for (const entry of entries) {
      expect(entry.blockers.join(' ')).toContain('duplicate record for blog:1:');
    }
    expect(summarizePlan(entries).blockers).toBe(4);
  });

  it('blocks ids that are not positive integers', () => {
    for (const id of [0, -3, 1.5, Number.NaN]) {
      const entry = planEntry('blog', id, 'en', '# body', null);
      expect(entry.action, String(id)).toBe('BLOCKED');
      expect(entry.blockers[0]).toContain('invalid post id');
    }
  });
});

describe('backfill plan: environment gate', () => {
  it('accepts the dev contract', () => {
    expect(() => assertBackfillPlanAllowed(DEV_ENV)).not.toThrow();
  });

  it('refuses production, other schemas, unusable URLs, other projects and missing credentials', () => {
    expect(() =>
      assertBackfillPlanAllowed({ ...DEV_ENV, appEnv: 'production' })
    ).toThrow(/refusing to run in production/);
    expect(() =>
      assertBackfillPlanAllowed({ ...DEV_ENV, schema: 'public' })
    ).toThrow(/must be 'dev_staging'/);
    expect(() =>
      assertBackfillPlanAllowed({ ...DEV_ENV, supabaseUrl: '' })
    ).toThrow(/missing NEXT_PUBLIC_SUPABASE_URL/);
    expect(() =>
      assertBackfillPlanAllowed({ ...DEV_ENV, supabaseUrl: 'not-a-url' })
    ).toThrow(/not a usable https/);
    expect(() =>
      assertBackfillPlanAllowed({
        ...DEV_ENV,
        supabaseUrl: 'https://otherotherotherother.supabase.co',
      })
    ).toThrow(/project mismatch/);
    expect(() =>
      assertBackfillPlanAllowed({ ...DEV_ENV, hasServerSecret: false })
    ).toThrow(/missing SUPABASE_SECRET_KEY/);
  });

  it('parses the project reference only from a real Supabase https URL', () => {
    expect(
      projectRefFromUrl(`https://${EXPECTED_DEV_PROJECT_REF}.supabase.co`)
    ).toBe(EXPECTED_DEV_PROJECT_REF);
    expect(
      projectRefFromUrl(`https://${EXPECTED_DEV_PROJECT_REF}.supabase.co/`)
    ).toBe(EXPECTED_DEV_PROJECT_REF);
    expect(projectRefFromUrl(`http://${EXPECTED_DEV_PROJECT_REF}.supabase.co`)).toBeNull();
    expect(projectRefFromUrl('https://example.com')).toBeNull();
    expect(projectRefFromUrl('garbage')).toBeNull();
    expect(projectRefFromUrl('')).toBeNull();
  });
});

describe('backfill plan: CLI arguments', () => {
  it('accepts no arguments', () => {
    expect(parseBackfillPlanArgs([])).toEqual({ ok: true });
  });

  it('rejects every argument, including future mutation flags', () => {
    for (const argv of [
      ['--apply'],
      ['--rollback'],
      ['--cleanup'],
      ['--scope', BACKFILL_PLAN_SCHEMA],
      ['--json'],
      ['anything'],
      ['--apply', '--yes'],
    ]) {
      const parsed = parseBackfillPlanArgs(argv);
      expect(parsed.ok, argv.join(' ')).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain('unexpected argument(s)');
        expect(parsed.args).toEqual(argv);
      }
    }
  });
});

describe('backfill plan: report and dry-run orchestration', () => {
  it('produces an identical manifest and report across repeated runs', async () => {
    const meta = {
      appEnv: 'development',
      schema: BACKFILL_PLAN_SCHEMA,
      projectRef: EXPECTED_DEV_PROJECT_REF,
      bucket: BACKFILL_PLAN_BUCKET,
    };
    const once = buildBackfillPlanReport(buildBackfillPlan(baselineRows()), meta);
    const twice = buildBackfillPlanReport(buildBackfillPlan(baselineRows()), meta);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));

    const runA = await runBackfillPlan({ env: DEV_ENV, reader: fakeReader(baselineRows()) });
    const runB = await runBackfillPlan({ env: DEV_ENV, reader: fakeReader(baselineRows()) });
    expect(JSON.stringify(runB.report)).toBe(JSON.stringify(runA.report));
  });

  it('reports the command, project and destination bucket', async () => {
    const { report, exitCode } = await runBackfillPlan({
      env: DEV_ENV,
      reader: fakeReader(baselineRows()),
    });
    expect(exitCode).toBe(0);
    expect(report.command).toBe(BACKFILL_PLAN_COMMAND);
    expect(report.appEnv).toBe('development');
    expect(report.schema).toBe(BACKFILL_PLAN_SCHEMA);
    expect(report.projectRef).toBe(EXPECTED_DEV_PROJECT_REF);
    expect(report.bucket).toBe(BACKFILL_PLAN_BUCKET);
    expect(report.ok).toBe(true);
    expect(report.summary.byAction.UPLOAD_AND_POINT).toBe(34);
  });

  it('exits nonzero when any blocker exists', async () => {
    const rows = {
      blog: [row(1, '# a', '# b', `blog/1/en/${'c'.repeat(64)}.md`)],
      portfolio: [],
    };
    const { report, exitCode } = await runBackfillPlan({ env: DEV_ENV, reader: fakeReader(rows) });
    expect(exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.summary.blockers).toBe(1);
  });
});

describe('backfill plan: read-only guarantees', () => {
  type Calls = {
    select: number;
    order: number;
    insert: number;
    update: number;
    delete: number;
    upsert: number;
    remove: number;
    upload: number;
    download: number;
  };

  /**
   * A client that is deliberately WIDER than the planner accepts: it exposes
   * mutation methods (and a Storage surface) that throw and count. It is handed
   * to the planner through the read-only type, which is the real test: if any
   * dry-run path reached for a mutation, the counter would move or the throw
   * would surface.
   */
  function tripwireClient(
    tables: Record<string, PostBodyRow[]>,
    calls: Calls
  ): ReadOnlyPostBodyClient {
    const mutate = <T>(name: keyof Calls) => (): T => {
      calls[name] += 1;
      throw new Error(`mutating call reached: ${name}`);
    };
    const wide = {
      from(table: string) {
        return {
          select(_columns: string) {
            calls.select += 1;
            return {
              order(_column: string) {
                calls.order += 1;
                return Promise.resolve({ data: tables[table] ?? [], error: null });
              },
              insert: mutate('insert'),
              update: mutate('update'),
              delete: mutate('delete'),
              upsert: mutate('upsert'),
            };
          },
        };
      },
      storage: {
        from() {
          return {
            upload: mutate('upload'),
            remove: mutate('remove'),
            download: mutate('download'),
          };
        },
      },
    };
    return wide as unknown as ReadOnlyPostBodyClient;
  }

  function zeroCalls(): Calls {
    return {
      select: 0,
      order: 0,
      insert: 0,
      update: 0,
      delete: 0,
      upsert: 0,
      remove: 0,
      upload: 0,
      download: 0,
    };
  }

  it('exposes only a read method on the reader', () => {
    const calls = zeroCalls();
    const reader = createPostBodyReader(tripwireClient({}, calls));
    expect(Object.keys(reader)).toEqual(['listPostBodies']);
  });

  it('reads exclusively through select().order() and never mutates', async () => {
    const calls = zeroCalls();
    const tables = {
      blog_posts: baselineRows().blog,
      portfolio_posts: baselineRows().portfolio,
    };
    const reader = createPostBodyReader(tripwireClient(tables, calls));
    const { report, exitCode } = await runBackfillPlan({ env: DEV_ENV, reader });

    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(calls.select).toBe(2);
    expect(calls.order).toBe(2);
    expect(
      calls.insert +
        calls.update +
        calls.delete +
        calls.upsert +
        calls.remove +
        calls.upload +
        calls.download
    ).toBe(0);
  });

  it('still performs no mutation when the plan is blocked', async () => {
    const calls = zeroCalls();
    const tables = {
      blog_posts: [
        row(1, '# a', '# b', `portfolio/1/en/${'d'.repeat(64)}.md`),
      ],
      portfolio_posts: [],
    };
    const reader = createPostBodyReader(tripwireClient(tables, calls));
    const { report, exitCode } = await runBackfillPlan({ env: DEV_ENV, reader });

    expect(exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(calls.select).toBe(2);
    expect(
      calls.insert + calls.update + calls.delete + calls.upsert + calls.remove + calls.upload
    ).toBe(0);
  });

  it('rejects an environment gate failure before reading anything', async () => {
    const calls = zeroCalls();
    const reader = createPostBodyReader(tripwireClient({}, calls));
    await expect(
      runBackfillPlan({ env: { ...DEV_ENV, appEnv: 'production' }, reader })
    ).rejects.toThrow(/refusing to run in production/);
    expect(calls.select).toBe(0);
    expect(calls.order).toBe(0);
  });
});

describe('backfill plan: projection reading', () => {
  it('surfaces a Postgrest error with the table name', async () => {
    const failing = {
      from(table: string) {
        return {
          select() {
            return {
              order() {
                return Promise.resolve({
                  data: null,
                  error: { message: `boom on ${table}` },
                });
              },
            };
          },
        };
      },
    };
    const reader = createPostBodyReader(failing as unknown as ReadOnlyPostBodyClient);
    await expect(reader.listPostBodies('blog')).rejects.toThrow(
      /reading dev_staging\.blog_posts failed: boom on blog_posts/
    );
    await expect(reader.listPostBodies('portfolio')).rejects.toThrow(
      /reading dev_staging\.portfolio_posts failed/
    );
  });

  it('fails loudly on malformed projection rows', async () => {
    const rowsFor = (payload: unknown[]) => ({
      from() {
        return {
          select() {
            return {
              order() {
                return Promise.resolve({ data: payload, error: null });
              },
            };
          },
        };
      },
    });

    const badId = createPostBodyReader(
      rowsFor([{ id: 'abc' }]) as unknown as ReadOnlyPostBodyClient
    );
    await expect(badId.listPostBodies('blog')).rejects.toThrow(/unexpected id/);

    const badBody = createPostBodyReader(
      rowsFor([
        { id: 1, body_en: 42, body_it: null, body_en_path: null, body_it_path: null },
      ]) as unknown as ReadOnlyPostBodyClient
    );
    await expect(badBody.listPostBodies('blog')).rejects.toThrow(
      /unexpected body_en type/
    );
  });

  it('treats missing data as an empty inventory', async () => {
    const empty = {
      from() {
        return {
          select() {
            return { order: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      },
    };
    const reader = createPostBodyReader(empty as unknown as ReadOnlyPostBodyClient);
    expect(await reader.listPostBodies('blog')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { POINTER_COLUMNS_FLAG } from '@/libs/cms/bodyWriteGate';
import { manifestDigest } from '@/libs/cms/storage/backfillApply';
import {
  BACKFILL_BODY_COLUMNS,
  BACKFILL_POINTER_COLUMNS,
  type BackfillObservedEnvironment,
} from '@/libs/cms/storage/backfillEnvironment';
import {
  buildBackfillPlan,
  type PostBodyReader,
  type PostBodyRow,
  type ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';
import {
  bodyContentPath,
  MAX_BODY_CONTENT_BYTES,
  sha256Hex,
} from '@/libs/cms/storage/bodyContent';
import {
  buildProdPlanReport,
  createProdPostBodyReader,
  PROD_BACKFILL_ENV,
  PROD_BACKFILL_PLAN_USAGE,
  PROD_INVENTORY_PROJECTION,
  PROD_MANIFEST_PROJECTION,
  parseProdPlanArgs,
  runProdBackfillPlan,
  selectPointerColumnMode,
} from '@/libs/cms/storage/prodBackfillPlan';
import { runProdBackfillPlanCli } from '@/utils/cms/prodBackfillPlan';

/**
 * Phase 13 C2 READ-ONLY production planner tests: pure and injected. No
 * network, no Storage client, no database. Every case asserts observable plan
 * output (projection used, ordering, hashes, actions, blockers, report fields,
 * exit codes, recorded calls) rather than snapshots.
 *
 * The fixture mirrors the production baseline SHAPE only (6 blog rows, 11
 * portfolio rows, one empty IT body -> 34 entries / 33 non-empty bodies); all
 * content here is synthetic.
 */

const BLOG_IDS = [1, 8, 9, 12, 18, 19];
const PORTFOLIO_IDS = [1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26];
const EMPTY_IT_BLOG_ID = 9;

const PROD_OBSERVED: BackfillObservedEnvironment = {
  appEnv: 'production',
  schema: 'public',
  supabaseUrl: `https://${PROD_BACKFILL_ENV.projectRef}.supabase.co`,
  hasServerSecret: true,
};

const MANIFEST_META = {
  mode: 'manifest',
  modeSource: 'argument',
  env: PROD_OBSERVED,
} as const;

function row(
  id: number,
  body_en: string | null,
  body_it: string | null,
  body_en_path: string | null = null,
  body_it_path: string | null = null
): PostBodyRow {
  return { id, body_en, body_it, body_en_path, body_it_path };
}

function canonicalPath(
  kind: 'blog' | 'portfolio',
  postId: number,
  locale: 'en' | 'it',
  body: string
): string {
  return bodyContentPath(
    kind,
    postId,
    locale,
    sha256Hex(Buffer.from(body, 'utf8'))
  );
}

/** Pre-schema inventory fixture: bodies only, pointers never present. */
function inventoryFixture(): {
  blog: PostBodyRow[];
  portfolio: PostBodyRow[];
} {
  const blog = BLOG_IDS.map((id) =>
    row(
      id,
      `# blog ${id} EN 🎉\n\nbody ${id}`,
      id === EMPTY_IT_BLOG_ID ? null : `# blog ${id} IT à\n\ncorpo ${id}`
    )
  );
  const portfolio = PORTFOLIO_IDS.map((id) =>
    row(id, `# portfolio ${id} EN ✓`, `# portfolio ${id} IT perché`)
  );
  return { blog, portfolio };
}

/** Exact UTF-8 bytes of every non-empty body in the fixture. */
function utf8Bytes(rows: {
  blog: PostBodyRow[];
  portfolio: PostBodyRow[];
}): number {
  let total = 0;
  for (const list of [rows.blog, rows.portfolio]) {
    for (const entry of list) {
      for (const body of [entry.body_en, entry.body_it]) {
        if (body) total += Buffer.byteLength(body, 'utf8');
      }
    }
  }
  return total;
}

/**
 * Post-schema manifest fixture: pointers present. One locale already current,
 * the rest pending, plus a non-canonical pointer, a pointer that disagrees with
 * the body hash, an oversized body and a duplicated portfolio id.
 */
function manifestFixture(): {
  blog: PostBodyRow[];
  portfolio: PostBodyRow[];
} {
  const blog: PostBodyRow[] = [
    row(1, '# blog 1 EN 🎉', '# blog 1 IT à'),
    row(
      8,
      '# blog 8 EN',
      '# blog 8 IT',
      canonicalPath('blog', 8, 'en', '# blog 8 EN')
    ),
    row(9, '# blog 9 EN', null),
    row(12, '# blog 12 EN', '# blog 12 IT', 'blog/12/en/not-a-canonical.md'),
    row(
      18,
      '# blog 18 EN',
      '# blog 18 IT',
      bodyContentPath('blog', 18, 'en', 'a'.repeat(64))
    ),
    row(19, 'x'.repeat(MAX_BODY_CONTENT_BYTES + 1), '# blog 19 IT'),
  ];
  const portfolio = PORTFOLIO_IDS.map((id) =>
    row(id, `# portfolio ${id} EN ✓`, `# portfolio ${id} IT perché`)
  );
  const duplicate = row(21, '# portfolio 21 EN', '# portfolio 21 IT');
  portfolio.push({ ...duplicate });
  return { blog, portfolio };
}

function manifestKeys(): string[] {
  return [
    ...BLOG_IDS.flatMap((id) => [`blog:${id}:en`, `blog:${id}:it`]),
    ...[1, 2, 3, 4, 5, 21, 21, 22, 23, 24, 25, 26].flatMap((id) => [
      `portfolio:${id}:en`,
      `portfolio:${id}:it`,
    ]),
  ];
}

type SelectCall = { table: string; columns: string };

function tableRows(rows: {
  blog: PostBodyRow[];
  portfolio: PostBodyRow[];
}): Record<string, PostBodyRow[]> {
  return { blog_posts: rows.blog, portfolio_posts: rows.portfolio };
}

function projectRow(
  source: PostBodyRow,
  columns: string
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const column of columns.split(',').map((name) => name.trim())) {
    projected[column] =
      (source as unknown as Record<string, unknown>)[column] ?? null;
  }
  return projected;
}

/**
 * Read-only client fake. `select(columns)` REJECTS any projection that names
 * `body_en_path` / `body_it_path` (as the pre-schema database would) and records
 * every requested projection so a test can prove which columns were named.
 */
function fakeClient(
  tables: Record<string, PostBodyRow[]>,
  calls: SelectCall[],
  options: { allowPointerColumns?: boolean } = {}
): ReadOnlyPostBodyClient {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          calls.push({ table, columns });
          const namesPointerColumn =
            !options.allowPointerColumns &&
            (columns.includes('body_en_path') ||
              columns.includes('body_it_path'));
          return {
            async order() {
              if (namesPointerColumn) {
                return {
                  data: null,
                  error: { message: `column '${columns}' does not exist` },
                };
              }
              const rows = tables[table] ?? [];
              return {
                data: rows.map((source) => projectRow(source, columns)),
                error: null,
              };
            },
          };
        },
      };
    },
  };
}

describe('prod backfill plan: pointer column mode selection', () => {
  it('lets an explicit argument win over the capability flag for both modes', () => {
    expect(
      selectPointerColumnMode({ requested: 'inventory', flag: 'true' })
    ).toEqual({ ok: true, mode: 'inventory', source: 'argument' });
    expect(
      selectPointerColumnMode({ requested: 'manifest', flag: 'false' })
    ).toEqual({ ok: true, mode: 'manifest', source: 'argument' });
    expect(
      selectPointerColumnMode({ requested: 'manifest', flag: undefined })
    ).toEqual({ ok: true, mode: 'manifest', source: 'argument' });
  });

  it("treats exactly 'true' as the declared pointer-columns capability", () => {
    expect(selectPointerColumnMode({ flag: 'true' })).toEqual({
      ok: true,
      mode: 'manifest',
      source: 'flag',
    });
  });

  it("treats undefined, '' and 'false' as the pre-schema inventory", () => {
    for (const flag of [undefined, '', 'false']) {
      expect(selectPointerColumnMode({ flag }), String(flag)).toEqual({
        ok: true,
        mode: 'inventory',
        source: 'flag',
      });
    }
  });

  it('refuses any other flag value, naming the capability variable', () => {
    for (const flag of ['TRUE', 'True', '1', 'yes', 'off', ' true']) {
      const selection = selectPointerColumnMode({ flag });
      expect(selection.ok, flag).toBe(false);
      if (!selection.ok) {
        expect(selection.error).toContain(POINTER_COLUMNS_FLAG);
        expect(selection.error).toContain(`'${flag}'`);
      }
    }
  });
});

describe('prod backfill plan: pre-schema inventory', () => {
  it('plans the production baseline without ever naming a pointer column', async () => {
    const calls: SelectCall[] = [];
    const reader = createProdPostBodyReader(
      fakeClient(tableRows(inventoryFixture()), calls),
      'inventory',
      'public'
    );

    const { report, exitCode } = await runProdBackfillPlan({
      env: PROD_OBSERVED,
      reader,
      mode: 'inventory',
      modeSource: 'argument',
    });

    expect(exitCode).toBe(0);
    expect(report.mode).toBe('inventory');
    expect(report.modeSource).toBe('argument');
    expect(report.digestKind).toBe('inventory-bodies-only');
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.command).toBe('storage:content:prod:backfill:plan');
    expect(report.appEnv).toBe('production');
    expect(report.schema).toBe('public');
    expect(report.projectRef).toBe(PROD_BACKFILL_ENV.projectRef);
    expect(report.bucket).toBe('website-content');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.columns).toBe(PROD_INVENTORY_PROJECTION);
      expect(call.columns).toBe(BACKFILL_BODY_COLUMNS);
      expect(call.columns).toBe('id,body_en,body_it');
      expect(call.columns).not.toContain('body_en_path');
      expect(call.columns).not.toContain('body_it_path');
    }

    expect(report.baseline.projection).toBe(BACKFILL_BODY_COLUMNS);
    expect(report.baseline.pointerColumnsSelected).toBe(false);
    expect(report.baseline.blogRows).toBe(6);
    expect(report.baseline.portfolioRows).toBe(11);
    expect(report.baseline.posts).toBe(17);
    expect(report.baseline.nonemptyBodies).toBe(33);
    expect(report.baseline.totalSourceBytes).toBe(
      utf8Bytes(inventoryFixture())
    );
    expect(report.baseline.totalSourceBytes).toBe(
      report.summary.totalSourceBytes
    );
  });

  it('the fake rejects any pointer-naming projection (so the inventory provably cannot name one)', async () => {
    const calls: SelectCall[] = [];
    const reader = createProdPostBodyReader(
      fakeClient(tableRows(inventoryFixture()), calls),
      'manifest',
      'public'
    );
    await expect(reader.listPostBodies('blog')).rejects.toThrow(
      /does not exist/
    );
    expect(calls[0].columns).toBe(PROD_MANIFEST_PROJECTION);
    expect(calls[0].columns).toBe(BACKFILL_POINTER_COLUMNS);
  });
});

describe('prod backfill plan: post-schema manifest', () => {
  it('orders deterministically and classifies against the committed pointer', () => {
    const report = buildProdPlanReport(
      buildBackfillPlan(manifestFixture()),
      MANIFEST_META
    );

    expect(report.mode).toBe('manifest');
    expect(report.digestKind).toBe('executable-manifest');
    expect(report.ok).toBe(false);
    expect(report.baseline.pointerColumnsSelected).toBe(true);
    expect(report.baseline.projection).toBe(BACKFILL_POINTER_COLUMNS);

    expect(
      report.manifest.map(
        (entry) => `${entry.kind}:${entry.postId}:${entry.locale}`
      )
    ).toEqual(manifestKeys());

    const byKey = new Map(
      report.manifest.map((entry) => [
        `${entry.kind}:${entry.postId}:${entry.locale}`,
        entry,
      ])
    );
    expect(byKey.get('blog:8:en')?.action).toBe('ALREADY_CURRENT');
    expect(byKey.get('blog:1:en')?.action).toBe('UPLOAD_AND_POINT');
    expect(byKey.get('blog:1:it')?.action).toBe('UPLOAD_AND_POINT');
    expect(byKey.get('blog:9:it')?.action).toBe('SKIP_EMPTY');
    expect(byKey.get('blog:12:en')?.action).toBe('BLOCKED');
    expect(byKey.get('blog:18:en')?.action).toBe('BLOCKED');
    expect(byKey.get('blog:19:en')?.action).toBe('BLOCKED');
    expect(byKey.get('portfolio:21:en')?.action).toBe('BLOCKED');
    expect(byKey.get('portfolio:21:it')?.action).toBe('BLOCKED');
  });

  it('lists exactly the blocked entries as conflicts and prefixes every blocker', () => {
    const report = buildProdPlanReport(
      buildBackfillPlan(manifestFixture()),
      MANIFEST_META
    );

    const blocked = report.manifest.filter(
      (entry) => entry.blockers.length > 0
    );
    expect(report.summary.byAction.BLOCKED).toBe(blocked.length);
    expect(report.conflicts).toHaveLength(blocked.length);
    expect(report.conflicts).toEqual(
      blocked.map((entry) => ({
        kind: entry.kind,
        postId: entry.postId,
        locale: entry.locale,
        blockers: entry.blockers,
      }))
    );

    const conflicts = new Map(
      report.conflicts.map((conflict) => [
        `${conflict.kind}:${conflict.postId}:${conflict.locale}`,
        conflict.blockers.join(' '),
      ])
    );
    expect(conflicts.get('blog:12:en')).toContain('not a canonical');
    expect(conflicts.get('blog:18:en')).toContain('pointer/body disagreement');
    expect(conflicts.get('blog:19:en')).toContain(
      `over the ${MAX_BODY_CONTENT_BYTES} byte limit`
    );
    expect(conflicts.get('portfolio:21:it')).toContain(
      'duplicate record for portfolio:21:it'
    );

    expect(report.blockers).toHaveLength(
      blocked.reduce((total, entry) => total + entry.blockers.length, 0)
    );
    for (const line of report.blockers) {
      expect(line).toMatch(/^(blog|portfolio):\d+:(en|it): /);
    }
  });

  it('produces a stable digest that changes when a single body byte changes', () => {
    const first = buildProdPlanReport(
      buildBackfillPlan(manifestFixture()),
      MANIFEST_META
    );
    const second = buildProdPlanReport(
      buildBackfillPlan(manifestFixture()),
      MANIFEST_META
    );
    expect(second.digest).toBe(first.digest);

    const mutated = manifestFixture();
    mutated.blog[0] = {
      ...mutated.blog[0],
      body_en: `${mutated.blog[0].body_en ?? ''}X`,
    };
    const third = buildProdPlanReport(
      buildBackfillPlan(mutated),
      MANIFEST_META
    );
    expect(third.digest).not.toBe(first.digest);
  });

  it('is pointer-aware: an inventory/null-pointer digest can never authorize an apply', () => {
    const report = buildProdPlanReport(
      buildBackfillPlan(manifestFixture()),
      MANIFEST_META
    );

    const source = manifestFixture();
    const nullPointers = {
      blog: source.blog.map((entry) => ({
        ...entry,
        body_en_path: null,
        body_it_path: null,
      })),
      portfolio: source.portfolio.map((entry) => ({
        ...entry,
        body_en_path: null,
        body_it_path: null,
      })),
    };
    const nullPointerDigest = manifestDigest(buildBackfillPlan(nullPointers));

    expect(report.digest).not.toBe(nullPointerDigest);
    expect(
      buildProdPlanReport(buildBackfillPlan(nullPointers), MANIFEST_META).digest
    ).toBe(nullPointerDigest);
  });
});

describe('prod backfill plan: run exit codes and gate ordering', () => {
  it('exits 0 for a clean plan', async () => {
    const reader: PostBodyReader = {
      listPostBodies: async (kind) =>
        kind === 'blog' ? [row(1, '# a', null)] : [row(1, '# b', '# c')],
    };

    const { report, exitCode } = await runProdBackfillPlan({
      env: PROD_OBSERVED,
      reader,
      mode: 'inventory',
      modeSource: 'flag',
    });

    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it('exits 1 when the plan carries a blocker', async () => {
    const calls: SelectCall[] = [];
    const reader = createProdPostBodyReader(
      fakeClient(tableRows(manifestFixture()), calls, {
        allowPointerColumns: true,
      }),
      'manifest',
      'public'
    );

    const { report, exitCode } = await runProdBackfillPlan({
      env: PROD_OBSERVED,
      reader,
      mode: 'manifest',
      modeSource: 'argument',
    });

    expect(exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.columns).toBe(PROD_MANIFEST_PROJECTION);
    }
  });

  it('runs the environment gate before any read', async () => {
    let reads = 0;
    const reader: PostBodyReader = {
      listPostBodies: async () => {
        reads += 1;
        return [];
      },
    };

    const cases: Array<[BackfillObservedEnvironment, RegExp]> = [
      [
        { ...PROD_OBSERVED, appEnv: 'development' },
        /APP_ENV must be exactly 'production'/,
      ],
      [
        { ...PROD_OBSERVED, schema: 'dev_staging' },
        /NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be 'public'/,
      ],
      [
        { ...PROD_OBSERVED, supabaseUrl: '' },
        /missing NEXT_PUBLIC_SUPABASE_URL/,
      ],
      [
        {
          ...PROD_OBSERVED,
          supabaseUrl: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
        },
        /project mismatch/,
      ],
      [
        { ...PROD_OBSERVED, hasServerSecret: false },
        /missing SUPABASE_SECRET_KEY/,
      ],
    ];

    for (const [env, expected] of cases) {
      await expect(
        runProdBackfillPlan({
          env,
          reader,
          mode: 'inventory',
          modeSource: 'argument',
        })
      ).rejects.toThrow(expected);
    }
    expect(reads).toBe(0);
  });
});

describe('prod backfill plan: argument parsing', () => {
  it('accepts an empty argv with no requested mode', () => {
    expect(parseProdPlanArgs([])).toEqual({
      ok: true,
      requested: undefined,
      help: false,
    });
  });

  it('records an explicitly requested mode', () => {
    expect(parseProdPlanArgs(['--inventory'])).toEqual({
      ok: true,
      requested: 'inventory',
      help: false,
    });
    expect(parseProdPlanArgs(['--manifest'])).toEqual({
      ok: true,
      requested: 'manifest',
      help: false,
    });
  });

  it('refuses two conflicting mode flags', () => {
    const parsed = parseProdPlanArgs(['--inventory', '--manifest']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('conflicting mode flag');
      expect(parsed.error).toContain('--manifest');
    }
  });

  it('treats --help and -h as help', () => {
    expect(parseProdPlanArgs(['--help'])).toEqual({
      ok: true,
      requested: undefined,
      help: true,
    });
    expect(parseProdPlanArgs(['-h'])).toEqual({
      ok: true,
      requested: undefined,
      help: true,
    });
  });

  it('refuses mutation flags and stray words as unknown arguments', () => {
    for (const argv of [
      ['--apply'],
      ['--rollback'],
      ['--cleanup'],
      ['stray'],
      ['--scope', 'public'],
    ]) {
      const parsed = parseProdPlanArgs(argv);
      expect(parsed.ok, argv.join(' ')).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain('unknown argument');
        expect(parsed.error).toContain(argv[0]);
      }
    }
  });
});

describe('prod backfill plan CLI', () => {
  it('exits 2 on invalid argv without opening a reader', async () => {
    let opened = 0;
    const outcome = await runProdBackfillPlanCli({
      argv: ['--apply'],
      observed: PROD_OBSERVED,
      env: {},
      openReader() {
        opened += 1;
        return { listPostBodies: async () => [] };
      },
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain("unknown argument '--apply'");
    expect(outcome.error).toContain(PROD_BACKFILL_PLAN_USAGE);
    expect(opened).toBe(0);
  });

  it('exits 0 with the usage text on --help', async () => {
    const outcome = await runProdBackfillPlanCli({
      argv: ['--help'],
      observed: PROD_OBSERVED,
      env: {},
      openReader() {
        throw new Error('reader must not be opened for --help');
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    expect(outcome.report).toEqual({ usage: PROD_BACKFILL_PLAN_USAGE });
  });

  it('lets --manifest win over a false capability flag and reads the pointer projection', async () => {
    const calls: SelectCall[] = [];
    const opened: Array<[string, string]> = [];
    const outcome = await runProdBackfillPlanCli({
      argv: ['--manifest'],
      observed: PROD_OBSERVED,
      env: { [POINTER_COLUMNS_FLAG]: 'false' },
      openReader(mode, schema) {
        opened.push([mode, schema]);
        return createProdPostBodyReader(
          fakeClient(tableRows(inventoryFixture()), calls, {
            allowPointerColumns: true,
          }),
          mode,
          schema
        );
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    expect(opened).toEqual([['manifest', 'public']]);
    const report = outcome.report as {
      mode?: string;
      modeSource?: string;
    } | null;
    expect(report?.mode).toBe('manifest');
    expect(report?.modeSource).toBe('argument');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.columns).toBe(PROD_MANIFEST_PROJECTION);
    }
  });

  it('never requests the pointer projection on the inventory path', async () => {
    const calls: SelectCall[] = [];
    const opened: Array<[string, string]> = [];
    const outcome = await runProdBackfillPlanCli({
      argv: [],
      observed: PROD_OBSERVED,
      env: { [POINTER_COLUMNS_FLAG]: 'false' },
      openReader(mode, schema) {
        opened.push([mode, schema]);
        return createProdPostBodyReader(
          fakeClient(tableRows(inventoryFixture()), calls),
          mode,
          schema
        );
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    expect(opened).toEqual([['inventory', 'public']]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.columns).toBe(PROD_INVENTORY_PROJECTION);
      expect(call.columns).toBe('id,body_en,body_it');
      expect(call.columns).not.toContain('body_en_path');
      expect(call.columns).not.toContain('body_it_path');
    }
  });

  it('exits 3 with a null report and never calls the reader factory when the environment is wrong', async () => {
    const cases: Array<[BackfillObservedEnvironment, RegExp]> = [
      [
        { ...PROD_OBSERVED, appEnv: 'development' },
        /APP_ENV must be exactly 'production'/,
      ],
      [
        { ...PROD_OBSERVED, schema: 'dev_staging' },
        /NEXT_PUBLIC_SUPABASE_DB_SCHEMA must be 'public'/,
      ],
      [
        {
          ...PROD_OBSERVED,
          supabaseUrl: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
        },
        /project mismatch/,
      ],
      [
        { ...PROD_OBSERVED, hasServerSecret: false },
        /missing SUPABASE_SECRET_KEY/,
      ],
    ];

    for (const [observed, expected] of cases) {
      let opened = 0;
      let reads = 0;
      const outcome = await runProdBackfillPlanCli({
        argv: [],
        observed,
        env: {},
        openReader() {
          opened += 1;
          return {
            listPostBodies: async () => {
              reads += 1;
              return [];
            },
          };
        },
      });

      expect(outcome.exitCode, String(expected)).toBe(3);
      expect(outcome.report).toBeNull();
      expect(outcome.error).toContain('[production-backfill]');
      expect(outcome.error).toMatch(expected);
      expect(opened).toBe(0);
      expect(reads).toBe(0);
    }
  });

  it('exits 4 when the reader throws after the gate passed', async () => {
    let opened = 0;
    const outcome = await runProdBackfillPlanCli({
      argv: [],
      observed: PROD_OBSERVED,
      env: {},
      openReader() {
        opened += 1;
        return {
          listPostBodies: async () => {
            throw new Error('boom reading production');
          },
        };
      },
    });

    expect(outcome.exitCode).toBe(4);
    expect(outcome.report).toBeNull();
    expect(outcome.error).toBe('boom reading production');
    expect(opened).toBe(1);
  });
});

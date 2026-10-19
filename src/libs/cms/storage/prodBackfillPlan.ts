/**
 * Phase 13 C2 — READ-ONLY production inventory and planner.
 *
 * The production twin of `backfillPlan.ts`. It plans the migration of the
 * `public` schema's Markdown columns (`body_en` / `body_it`) into immutable
 * content-addressed objects in the private `website-content` bucket. It shares
 * EVERYTHING that defines the migration — the canonical SHA-256 key
 * (`bodyContent`), the per-entry classification, ordering, duplicate detection,
 * summary arithmetic and the manifest digest — with the DEV planner; only the
 * pinned environment values and this module's two operating states are its own.
 *
 * TWO OPERATING STATES, because production is migrated in two steps:
 *
 * 1. `inventory` — runs BEFORE the pointer columns exist. It projects exactly
 *    `id,body_en,body_it`, so it never names a column the schema does not have,
 *    and reports the production baseline: rows, non-empty bodies and total
 *    source bytes. A missing pointer column is not a failure here — the
 *    inventory cannot even refer to one.
 * 2. `manifest` — runs once the additive schema is installed and declares the
 *    pointer columns. It projects the pointers too, and additionally classifies
 *    each entry against the committed pointer: already-current, pending, or
 *    conflicted (blocked), plus invalid/missing sources and oversized content.
 *    Its digest is the executable identity an authorized `--apply` must confirm.
 *
 * Which state runs is a deployment fact, not a guess: the CMS capability flag
 * (`CMS_BODY_POINTER_COLUMNS`, reused from the dual-write gate) declares that
 * the columns EXIST, and only then may a projection name them. The flag is an
 * assertion, so the manifest read verifies it: a false declaration fails the
 * read loudly instead of planning against columns that are not there.
 *
 * Nothing here uploads, downloads, deletes, updates or invalidates anything,
 * and production always reads its OWN rows — the DEV manifest is never reused.
 */
import { POINTER_COLUMNS_FLAG } from '@/libs/cms/bodyWriteGate';
import { manifestDigest } from '@/libs/cms/storage/backfillApply';
import {
  assertBackfillEnvironment,
  type BackfillObservedEnvironment,
  PROD_BACKFILL_ENVIRONMENT,
  projectRefFromUrl,
} from '@/libs/cms/storage/backfillEnvironment';
import {
  type BackfillPlanEntry,
  type BackfillPlanSummary,
  buildBackfillPlan,
  createPostBodyReader,
  type PostBodyReader,
  type ReadOnlyPostBodyClient,
  summarizePlan,
} from '@/libs/cms/storage/backfillPlan';

/** CLI name (matches the `package.json` script). */
export const PROD_BACKFILL_PLAN_COMMAND = 'storage:content:prod:backfill:plan';

/** The pinned production environment this planner may ever run against. */
export const PROD_BACKFILL_ENV = PROD_BACKFILL_ENVIRONMENT;

/** The projection used before the pointer columns exist. */
export const PROD_INVENTORY_PROJECTION =
  PROD_BACKFILL_ENVIRONMENT.projections.bodies;

/** The projection used once the pointer columns are declared installed. */
export const PROD_MANIFEST_PROJECTION =
  PROD_BACKFILL_ENVIRONMENT.projections.pointers;

export type ProdPointerColumnMode = 'inventory' | 'manifest';

export type ProdPointerColumnSelection =
  | { ok: true; mode: ProdPointerColumnMode; source: 'argument' | 'flag' }
  | { ok: false; error: string };

/**
 * Chooses the operating state, fail-closed.
 *
 * An explicit argument wins (an operator may always ask for the safe,
 * pointer-free inventory). Otherwise the capability flag decides: exactly
 * `'true'` means the pointer columns are declared installed, absent/`'false'`
 * means they are not, and anything else is refused rather than guessed — a
 * misspelled flag must not silently select a projection.
 */
export function selectPointerColumnMode(input: {
  requested?: ProdPointerColumnMode;
  flag: string | undefined;
}): ProdPointerColumnSelection {
  if (input.requested) {
    return { ok: true, mode: input.requested, source: 'argument' };
  }
  if (input.flag === 'true') {
    return { ok: true, mode: 'manifest', source: 'flag' };
  }
  if (input.flag === undefined || input.flag === '' || input.flag === 'false') {
    return { ok: true, mode: 'inventory', source: 'flag' };
  }
  return {
    ok: false,
    error: `${POINTER_COLUMNS_FLAG} must be exactly 'true' or 'false', got '${input.flag}'`,
  };
}

export type ProdInventoryBaseline = {
  blogRows: number;
  portfolioRows: number;
  posts: number;
  /** Locales that actually hold Markdown (one per non-empty body). */
  nonemptyBodies: number;
  /** Exact UTF-8 bytes of every non-empty body in the plan. */
  totalSourceBytes: number;
  /** True when the projection named the pointer columns. */
  pointerColumnsSelected: boolean;
  projection: string;
};

export type ProdPlanConflict = {
  kind: string;
  postId: number;
  locale: string;
  blockers: string[];
};

export type ProdBackfillPlanReport = {
  command: typeof PROD_BACKFILL_PLAN_COMMAND;
  /** Which of the two operating states produced this report. */
  mode: ProdPointerColumnMode;
  /** Why that state ran (an explicit argument, or the capability flag). */
  modeSource: 'argument' | 'flag';
  appEnv: string;
  schema: string;
  projectRef: string;
  bucket: string;
  /** True when no entry carries a blocker. */
  ok: boolean;
  /**
   * Deterministic identity of the plan. Only `executable-manifest` is accepted
   * by `--apply --confirm-digest`: an inventory digest describes a
   * pointer-free view and never authorizes a switch.
   */
  digest: string;
  digestKind: 'inventory-bodies-only' | 'executable-manifest';
  /** Explicit blockers, in manifest order. */
  blockers: string[];
  conflicts: ProdPlanConflict[];
  baseline: ProdInventoryBaseline;
  summary: BackfillPlanSummary;
  manifest: BackfillPlanEntry[];
};

/**
 * The production baseline: counts and bytes read from production itself.
 *
 * `totalSourceBytes` is the sum of the exact UTF-8 body bytes (never a
 * normalized or estimated length), so the report can be compared against the
 * approved snapshot byte for byte.
 */
export function prodInventoryBaseline(
  entries: BackfillPlanEntry[],
  mode: ProdPointerColumnMode
): ProdInventoryBaseline {
  const summary = summarizePlan(entries);
  const blogRows = summary.byEntity.blog.rows;
  const portfolioRows = summary.byEntity.portfolio.rows;
  return {
    blogRows,
    portfolioRows,
    posts: blogRows + portfolioRows,
    nonemptyBodies: summary.entries - summary.byAction.SKIP_EMPTY,
    totalSourceBytes: summary.totalSourceBytes,
    pointerColumnsSelected: mode === 'manifest',
    projection:
      mode === 'manifest'
        ? PROD_MANIFEST_PROJECTION
        : PROD_INVENTORY_PROJECTION,
  };
}

/** Every blocker in the manifest, in manifest order, one line each. */
export function prodPlanBlockers(entries: BackfillPlanEntry[]): string[] {
  const blockers: string[] = [];
  for (const entry of entries) {
    for (const blocker of entry.blockers) {
      blockers.push(
        `${entry.kind}:${entry.postId}:${entry.locale}: ${blocker}`
      );
    }
  }
  return blockers;
}

/** The conflicting entries (pointer/body disagreement, duplicates, oversize). */
export function prodPlanConflicts(
  entries: BackfillPlanEntry[]
): ProdPlanConflict[] {
  return entries
    .filter((entry) => entry.blockers.length > 0)
    .map((entry) => ({
      kind: entry.kind,
      postId: entry.postId,
      locale: entry.locale,
      blockers: [...entry.blockers],
    }));
}

/** Assembles the report. Deterministic: no clock, no ordering drift. */
export function buildProdPlanReport(
  entries: BackfillPlanEntry[],
  meta: {
    mode: ProdPointerColumnMode;
    modeSource: 'argument' | 'flag';
    env: BackfillObservedEnvironment;
  }
): ProdBackfillPlanReport {
  const blockers = prodPlanBlockers(entries);
  return {
    command: PROD_BACKFILL_PLAN_COMMAND,
    mode: meta.mode,
    modeSource: meta.modeSource,
    appEnv: meta.env.appEnv,
    schema: meta.env.schema,
    projectRef: projectRefFromUrl(meta.env.supabaseUrl) ?? '',
    bucket: PROD_BACKFILL_ENVIRONMENT.bucket,
    ok: blockers.length === 0,
    digest: manifestDigest(entries),
    digestKind:
      meta.mode === 'manifest'
        ? 'executable-manifest'
        : 'inventory-bodies-only',
    blockers,
    conflicts: prodPlanConflicts(entries),
    baseline: prodInventoryBaseline(entries, meta.mode),
    summary: summarizePlan(entries),
    manifest: entries,
  };
}

/**
 * The read-only body reader for one operating state. The projection is chosen
 * from the mode, so the inventory can never name a pointer column.
 */
export function createProdPostBodyReader(
  client: ReadOnlyPostBodyClient,
  mode: ProdPointerColumnMode,
  schema: string
): PostBodyReader {
  return createPostBodyReader(client, {
    columns:
      mode === 'manifest'
        ? PROD_MANIFEST_PROJECTION
        : PROD_INVENTORY_PROJECTION,
    schema,
    label: 'prod-backfill-plan',
  });
}

export type ProdBackfillPlanRun = {
  report: ProdBackfillPlanReport;
  /** 0 = no blockers, 1 = blockers present. */
  exitCode: number;
};

/**
 * The whole read-only production dry run: gate -> read -> plan -> summarize.
 *
 * It receives an existing reader (never a client it could write with) and
 * performs no mutation of any kind, on any path. The environment gate runs
 * before the first read, so a misconfigured process never reaches production.
 */
export async function runProdBackfillPlan(deps: {
  env: BackfillObservedEnvironment;
  reader: PostBodyReader;
  mode: ProdPointerColumnMode;
  modeSource: 'argument' | 'flag';
}): Promise<ProdBackfillPlanRun> {
  assertBackfillEnvironment(PROD_BACKFILL_ENVIRONMENT, deps.env);
  const [blog, portfolio] = await Promise.all([
    deps.reader.listPostBodies('blog'),
    deps.reader.listPostBodies('portfolio'),
  ]);
  const entries = buildBackfillPlan({ blog, portfolio });
  const report = buildProdPlanReport(entries, {
    mode: deps.mode,
    modeSource: deps.modeSource,
    env: deps.env,
  });
  return { report, exitCode: report.ok ? 0 : 1 };
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

export const PROD_BACKFILL_PLAN_USAGE = [
  `usage: bun run ${PROD_BACKFILL_PLAN_COMMAND} [--inventory | --manifest]`,
  '',
  'Read-only. No arguments means "use the declared schema state": the inventory',
  `(bodies only, never naming the pointer columns) unless ${POINTER_COLUMNS_FLAG}=true`,
  'declares the pointer columns installed.',
  '',
  '  --inventory  force the pre-schema baseline (bodies + pointers never read)',
  '  --manifest   require the pointer columns and emit the executable manifest',
].join('\n');

export type ProdPlanArgParse =
  | { ok: true; requested?: ProdPointerColumnMode; help: boolean }
  | { ok: false; error: string };

/**
 * Strict flag parsing: the two operating states may be requested explicitly,
 * `--help` prints usage, and every other argument (including the mutation flags
 * that exist on the executor) is refused rather than ignored, so a typo can
 * never be mistaken for a dry run.
 */
export function parseProdPlanArgs(argv: string[]): ProdPlanArgParse {
  let requested: ProdPointerColumnMode | undefined;
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--inventory' || arg === '--manifest') {
      if (requested) {
        return { ok: false, error: `conflicting mode flag '${arg}'` };
      }
      requested = arg === '--manifest' ? 'manifest' : 'inventory';
      continue;
    }
    return { ok: false, error: `unknown argument '${arg}'` };
  }
  return { ok: true, requested, help };
}

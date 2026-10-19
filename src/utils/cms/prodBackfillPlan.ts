#!/usr/bin/env node
/**
 * Phase 13 C2 — READ-ONLY production Markdown inventory + planner CLI.
 *
 *   bun run storage:content:prod:backfill:plan                 # declared state
 *   bun run storage:content:prod:backfill:plan --inventory     # pre-schema
 *   bun run storage:content:prod:backfill:plan --manifest      # pointer-aware
 *
 * Prints one deterministic JSON report (baseline + summary + manifest) on
 * stdout. There is no mutation path at all: the command constructs no Storage
 * client, its database surface is structurally read-only
 * (`select(...).order(...)` only), and the projection is chosen so the
 * pre-schema inventory NEVER names a pointer column that does not exist yet.
 *
 * Mode: no argument means "use the declared schema state" — the inventory
 * (bodies only) unless `CMS_BODY_POINTER_COLUMNS=true` declares the pointer
 * columns installed, in which case the pointer-aware manifest runs. `--inventory`
 * and `--manifest` request one explicitly; anything else is refused.
 *
 * `runProdBackfillPlanCli` is exported with its dependencies injected so the
 * whole gate/read/plan sequence is unit-testable without a network; the CLI
 * entry below is guarded by a direct-invocation check and only prints.
 *
 * Exit codes:
 *   0  planned cleanly, no blockers
 *   1  plan contains at least one blocker
 *   2  invalid usage
 *   3  environment/project gate failure (before the first read)
 *   4  read or planning failure
 */
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import { POINTER_COLUMNS_FLAG } from '@/libs/cms/bodyWriteGate';
import {
  assertBackfillEnvironment,
  type BackfillObservedEnvironment,
  PROD_BACKFILL_ENVIRONMENT,
} from '@/libs/cms/storage/backfillEnvironment';
import type {
  PostBodyReader,
  ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';
import {
  createProdPostBodyReader,
  PROD_BACKFILL_PLAN_USAGE,
  type ProdPointerColumnMode,
  parseProdPlanArgs,
  runProdBackfillPlan,
  selectPointerColumnMode,
} from '@/libs/cms/storage/prodBackfillPlan';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { isDirectInvocation } from '@/utils/cms/prodStorageSetup';

export type ProdBackfillPlanCliDeps = {
  argv: string[];
  observed: BackfillObservedEnvironment;
  env: Readonly<Record<string, string | undefined>>;
  /** Read-only client factory: it is called only after the environment gate. */
  openReader(mode: ProdPointerColumnMode, schema: string): PostBodyReader;
};

export type ProdBackfillPlanCliOutcome = {
  exitCode: number;
  /** The JSON report the CLI prints on stdout (never null when exitCode <= 1). */
  report: Record<string, unknown> | null;
  /** Set when the run refused or failed; printed on stderr. */
  error: string | null;
};

/**
 * The whole command body, with every dependency injected. Gate order is
 * explicit: usage -> capability -> environment -> read.
 */
export async function runProdBackfillPlanCli(
  deps: ProdBackfillPlanCliDeps
): Promise<ProdBackfillPlanCliOutcome> {
  const args = parseProdPlanArgs(deps.argv);
  if (!args.ok) {
    return {
      exitCode: 2,
      report: null,
      error: `${args.error}\n${PROD_BACKFILL_PLAN_USAGE}`,
    };
  }
  if (args.help) {
    return {
      exitCode: 0,
      report: { usage: PROD_BACKFILL_PLAN_USAGE },
      error: null,
    };
  }

  const selection = selectPointerColumnMode({
    requested: args.requested,
    flag: deps.env[POINTER_COLUMNS_FLAG],
  });
  if (!selection.ok) {
    return { exitCode: 2, report: null, error: selection.error };
  }

  // The gate runs BEFORE the reader factory, so a misconfigured process never
  // constructs a client (and a failure here is always the gate's exit 3, never a
  // client-construction failure).
  try {
    assertBackfillEnvironment(PROD_BACKFILL_ENVIRONMENT, deps.observed);
  } catch (error) {
    return {
      exitCode: 3,
      report: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const { report, exitCode } = await runProdBackfillPlan({
      env: deps.observed,
      reader: deps.openReader(selection.mode, deps.observed.schema),
      mode: selection.mode,
      modeSource: selection.source,
    });
    return { exitCode, report: { ...report }, error: null };
  } catch (error) {
    return {
      exitCode: 4,
      report: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const observed: BackfillObservedEnvironment = {
    appEnv,
    schema: supabaseSchema,
    supabaseUrl,
    hasServerSecret: supabaseServerSecret !== '',
  };

  const outcome = await runProdBackfillPlanCli({
    argv: process.argv.slice(2),
    observed,
    env: process.env,
    openReader(mode, schema) {
      // Constructed only after the environment gate passed, and narrowed to
      // the read-only planner surface so no write call is expressible here.
      const client = getCmsAdminClient() as unknown as ReadOnlyPostBodyClient;
      return createProdPostBodyReader(client, mode, schema);
    },
  });

  if (outcome.report) console.log(JSON.stringify(outcome.report, null, 2));
  if (outcome.error) console.error(outcome.error);
  if (outcome.exitCode === 3) {
    console.error(
      `[prod-backfill-plan] expected: APP_ENV=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public, project ${PROD_BACKFILL_ENVIRONMENT.projectRef}, bucket ${PROD_BACKFILL_ENVIRONMENT.bucket}, server secret present`
    );
  }
  process.exit(outcome.exitCode);
}

if (isDirectInvocation(process.argv, import.meta.url)) {
  await main();
}

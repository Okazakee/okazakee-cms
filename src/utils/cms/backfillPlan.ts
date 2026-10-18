#!/usr/bin/env node
/**
 * Phase 11A — read-only Markdown backfill planner CLI (dev only).
 *
 *   bun run storage:content:dev:backfill:plan
 *
 * Prints one deterministic JSON report (manifest + summary) on stdout and exits
 * nonzero when any blocker exists. There is no mutation path: the command takes
 * no arguments, constructs no Storage client, and its database surface is
 * structurally read-only (`select(...).order(...)` only). `--apply`,
 * `--rollback`, `--cleanup` and any other argument are rejected outright.
 *
 * Exit codes:
 *   0  planned cleanly, no blockers
 *   1  plan contains at least one blocker
 *   2  invalid usage (any argument) or invalid command line
 *   3  environment/project gate failure (before the first read)
 *   4  read or planning failure
 */
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import {
  BACKFILL_PLAN_BUCKET,
  BACKFILL_PLAN_COMMAND,
  BACKFILL_PLAN_SCHEMA,
  EXPECTED_DEV_PROJECT_REF,
  assertBackfillPlanAllowed,
  createPostBodyReader,
  parseBackfillPlanArgs,
  runBackfillPlan,
  type ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

const USAGE = [
  `usage: bun run ${BACKFILL_PLAN_COMMAND}`,
  '',
  'Read-only: plans the dev_staging Markdown -> website-content-dev object',
  'migration, prints an auditable JSON manifest and exits nonzero on blockers.',
  'Takes no arguments. Mutation commands (--apply, --rollback, --cleanup) do',
  'not exist in Phase 11A.',
].join('\n');

const parsedArgs = parseBackfillPlanArgs(process.argv.slice(2));

if (!parsedArgs.ok) {
  console.error(`[backfill-plan] ${parsedArgs.error}`);
  console.error(USAGE);
  process.exit(2);
}

const env = {
  appEnv,
  schema: supabaseSchema,
  supabaseUrl,
  hasServerSecret: supabaseServerSecret !== '',
};

try {
  // Gate first: a misconfigured environment never reaches a database read and
  // never constructs a client.
  assertBackfillPlanAllowed(env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error(
    `[backfill-plan] expected: APP_ENV!=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=${BACKFILL_PLAN_SCHEMA}, project ${EXPECTED_DEV_PROJECT_REF}, bucket ${BACKFILL_PLAN_BUCKET}, server secret present`
  );
  process.exit(3);
}

try {
  // The admin client satisfies the narrowed read-only surface structurally;
  // the planner never receives anything it could write with.
  const client = getCmsAdminClient() as unknown as ReadOnlyPostBodyClient;
  const { report, exitCode } = await runBackfillPlan({
    env,
    reader: createPostBodyReader(client),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(4);
}

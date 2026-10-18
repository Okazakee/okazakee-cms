#!/usr/bin/env node
/**
 * Markdown body backfill executor CLI (Phase 11B.1) — DEV only.
 *
 *   bun run storage:content:dev:backfill:exec --preflight
 *   bun run storage:content:dev:backfill:exec --apply \
 *     --confirm-digest=<manifest sha256> --expect-project-ref=<ref>
 *
 * `--preflight` is the only mode that may be run in Phase 11B.1: it validates
 * the gates, builds the reviewed plan, probes whether the staged CAS functions
 * are installed (a call the SQL refuses before it can write), and reports the
 * manifest digest. It uploads nothing and switches nothing.
 *
 * `--apply` exists but is triple-gated and inert until an operator authorizes
 * it:
 *   1. explicit `--apply` on the command line;
 *   2. `--confirm-digest` equal to the freshly computed plan digest and
 *      `--expect-project-ref` equal to the configured project reference;
 *   3. `CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging` in the server
 *      environment — the explicit operator acknowledgement.
 * The existence of `--apply` is never treated as authorization, and nothing
 * runs automatically on import, startup, CI or package installation.
 *
 * Exit codes:
 *   0 preflight ok (no blockers)          1 plan has blockers
 *   2 invalid usage                       3 environment/project gate failure
 *   4 read/plan failure                   5 execution refused by a gate
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import {
  BACKFILL_PLAN_BUCKET,
  BACKFILL_PLAN_COLUMNS,
  BACKFILL_PLAN_SCHEMA,
  EXPECTED_DEV_PROJECT_REF,
  assertBackfillPlanAllowed,
  buildBackfillPlan,
  createPostBodyReader,
  projectRefFromUrl,
  summarizePlan,
  type PostBodyRow,
  type ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';
import {
  createBackfillCasApi,
  probeCasReadiness,
  type CasRpcClient,
} from '@/libs/cms/storage/backfillCas';
import {
  APPLY_ACK_ENV,
  APPLY_ACK_VALUE,
  executeBackfill,
  manifestDigest,
  parseExecArgs,
  type BackfillExecutorDeps,
} from '@/libs/cms/storage/backfillApply';
import type {
  BodyContentKind,
  BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';
import { createFileJournal, type JournalFsApi } from '@/libs/cms/storage/backfillJournal';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

const USAGE = [
  'usage:',
  '  bun run storage:content:dev:backfill:exec --preflight',
  '  bun run storage:content:dev:backfill:exec --apply --confirm-digest=<sha256> --expect-project-ref=<ref>',
  '',
  'Phase 11B.1: only --preflight may be executed. --apply additionally requires',
  `the operator acknowledgement ${APPLY_ACK_ENV}=${APPLY_ACK_VALUE}.`,
].join('\n');

/** Journal location: outside the repo, one file per run. */
function journalPath(): string {
  return process.env.BACKFILL_JOURNAL_PATH ?? `/tmp/cms-backfill-${Date.now()}.jsonl`;
}

/**
 * Narrow server-side readers for the executor. Both are plain selects on an
 * explicit projection; no write surface is created here.
 */
function createPostgresReaders(client: ReturnType<typeof getCmsAdminClient>): {
  readBody(kind: BodyContentKind, postId: number, locale: string): Promise<string | null>;
  readPointer(kind: BodyContentKind, postId: number, locale: string): Promise<string | null>;
} {
  const table = (kind: BodyContentKind) =>
    kind === 'blog' ? 'blog_posts' : 'portfolio_posts';

  return {
    async readBody(kind, postId, locale) {
      const res = await client
        .from(table(kind))
        .select(`body_${locale}`)
        .eq('id', postId)
        .maybeSingle();
      if (res.error) {
        throw new Error(`[backfill-exec] read body failed: ${res.error.message}`);
      }
      const row = res.data as Record<string, unknown> | null;
      const value = row?.[`body_${locale}`];
      return typeof value === 'string' ? value : null;
    },
    async readPointer(kind, postId, locale) {
      const res = await client
        .from(table(kind))
        .select(`body_${locale}_path`)
        .eq('id', postId)
        .maybeSingle();
      if (res.error) {
        throw new Error(`[backfill-exec] read pointer failed: ${res.error.message}`);
      }
      const row = res.data as Record<string, unknown> | null;
      const value = row?.[`body_${locale}_path`];
      return typeof value === 'string' ? value : null;
    },
  };
}

async function readPlanRows(
  client: ReadOnlyPostBodyClient
): Promise<{ blog: PostBodyRow[]; portfolio: PostBodyRow[] }> {
  const reader = createPostBodyReader(client);
  const [blog, portfolio] = await Promise.all([
    reader.listPostBodies('blog'),
    reader.listPostBodies('portfolio'),
  ]);
  return { blog, portfolio };
}

async function main(): Promise<void> {
  const args = parseExecArgs(process.argv.slice(2));
  if (args.mode === 'invalid') {
    console.error(`[backfill-exec] ${args.error}`);
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
    assertBackfillPlanAllowed(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      `[backfill-exec] expected: APP_ENV!=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=${BACKFILL_PLAN_SCHEMA}, project ${EXPECTED_DEV_PROJECT_REF}, bucket ${BACKFILL_PLAN_BUCKET}, server secret present`
    );
    process.exit(3);
  }

  const projectRef = projectRefFromUrl(supabaseUrl) ?? '';
  const client = getCmsAdminClient();
  const readers = createPostgresReaders(client);

  try {
    const rows = await readPlanRows(client as unknown as ReadOnlyPostBodyClient);
    const plan = buildBackfillPlan(rows);
    const summary = summarizePlan(plan);
    const digest = manifestDigest(plan);
    const readiness = await probeCasReadiness(client as unknown as CasRpcClient);

    if (args.mode === 'preflight') {
      console.log(
        JSON.stringify(
          {
            command: 'storage:content:dev:backfill:exec',
            mode: 'preflight',
            schema: supabaseSchema,
            appEnv,
            projectRef,
            bucket: BACKFILL_PLAN_BUCKET,
            columns: BACKFILL_PLAN_COLUMNS,
            manifestDigest: digest,
            ok: summary.blockers === 0,
            plan: summary,
            cas: readiness,
            revalidation: {
              urlConfigured: Boolean(process.env.WEBSITE_REVALIDATION_URL),
              secretConfigured: Boolean(process.env.WEBSITE_REVALIDATION_SECRET),
            },
            applyArmed: false,
            mutationsPerformed: 0,
          },
          null,
          2
        )
      );
      process.exit(summary.blockers === 0 ? 0 : 1);
    }

    // ── --apply: every gate must pass before the first mutating call ────────
    if (process.env[APPLY_ACK_ENV] !== APPLY_ACK_VALUE) {
      console.error(
        `[backfill-exec] refusing --apply: set ${APPLY_ACK_ENV}=${APPLY_ACK_VALUE} to acknowledge a DEV backfill run`
      );
      process.exit(5);
    }
    if (args.expectProjectRef !== projectRef) {
      console.error(
        `[backfill-exec] refusing --apply: --expect-project-ref=${args.expectProjectRef} does not match the configured project '${projectRef}'`
      );
      process.exit(5);
    }
    if (args.confirmDigest !== digest) {
      console.error(
        `[backfill-exec] refusing --apply: --confirm-digest does not match the current plan digest ${digest}`
      );
      process.exit(5);
    }
    if (summary.blockers > 0) {
      console.error(`[backfill-exec] refusing --apply: plan has ${summary.blockers} blockers`);
      process.exit(1);
    }
    if (readiness.state !== 'ready') {
      console.error(
        `[backfill-exec] refusing --apply: staged CAS functions are not installed in ${BACKFILL_PLAN_SCHEMA} (${readiness.state})`
      );
      process.exit(5);
    }

    const path = journalPath();
    const deps: BackfillExecutorDeps = {
      storage: client.storage.from(
        BACKFILL_PLAN_BUCKET
      ) as unknown as BodyContentStorageApi,
      cas: createBackfillCasApi(client as unknown as CasRpcClient),
      readCommittedBody: readers.readBody,
      readCommittedPointer: readers.readPointer,
      invalidate: (invalidation) => invalidatePublicContent(invalidation),
      journal: createFileJournal(path, fs as unknown as JournalFsApi),
      now: () => new Date(),
      newRunId: () => randomUUID(),
    };

    const report = await executeBackfill(deps, plan, { revalidate: true });
    console.log(
      JSON.stringify(
        {
          command: 'storage:content:dev:backfill:exec',
          mode: 'apply',
          journalPath: path,
          ...report,
        },
        null,
        2
      )
    );
    process.exit(report.summary.failures === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(4);
  }
}

await main();

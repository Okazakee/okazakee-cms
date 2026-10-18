#!/usr/bin/env node
/**
 * Markdown body backfill rollback CLI (Phase 11B.2) — DEV only.
 *
 *   BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
 *   bun run storage:content:dev:backfill:rollback [--run-id=<id>]
 *
 *   BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
 *   CMS_BACKFILL_ROLLBACK_ACK=yes-rollback-dev-staging \
 *   bun run storage:content:dev:backfill:rollback --apply --run-id=<id> \
 *     --expect-project-ref=<ref>
 *
 * The default mode is a READ-ONLY plan: it reads the execution journal and the
 * live database and reports, per entry, whether the migration can be undone
 * (READY), was already undone, or must not be touched (the row moved on, the
 * body changed, the row is gone). It writes nothing.
 *
 * `--apply` restores the previous pointer of every READY candidate in reverse
 * migration order through the atomic rollback CAS, which refuses when the
 * pointer or the legacy body changed since the migration. It never forces a
 * rollback, never writes `body_en`/`body_it`, never removes a Storage object,
 * and revalidates the affected public caches afterwards.
 *
 * The candidate set comes from the verified execution record in the journal —
 * not from a freshly planned digest, which after a successful backfill
 * describes the migrated state rather than the original one.
 *
 * Exit codes:
 *   0 plan can proceed (or apply finished cleanly)
 *   1 plan has no actionable candidate while candidates exist / apply reported conflicts
 *   2 invalid usage
 *   3 environment/project gate failure
 *   4 read or execution failure
 *   5 refused by a gate (journal, ack, project reference, endpoint)
 */
import fs from 'node:fs/promises';
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import {
  BACKFILL_PLAN_SCHEMA,
  EXPECTED_DEV_PROJECT_REF,
  assertBackfillPlanAllowed,
  projectRefFromUrl,
} from '@/libs/cms/storage/backfillPlan';
import { createBackfillCasApi, type CasRpcClient } from '@/libs/cms/storage/backfillCas';
import {
  ROLLBACK_ACK_ENV,
  ROLLBACK_ACK_VALUE,
  executeRollback,
  parseRollbackArgs,
  planRollback,
  retryRollbackRevalidations,
  validateRevalidationEndpoint,
  type RollbackDeps,
} from '@/libs/cms/storage/backfillApply';
import {
  assertJournalDestination,
  auditJournal,
  createFileJournal,
  pendingRollbackRevalidations,
  type JournalFsApi,
} from '@/libs/cms/storage/backfillJournal';
import type { BodyContentKind } from '@/libs/cms/storage/bodyContent';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

const USAGE = [
  'usage:',
  '  BACKFILL_JOURNAL_PATH=<file outside the repo> bun run storage:content:dev:backfill:rollback [--run-id=<id>]',
  '  BACKFILL_JOURNAL_PATH=<file outside the repo> bun run storage:content:dev:backfill:rollback \\',
  '    --apply --run-id=<id> --expect-project-ref=<ref>',
  '',
  `apply additionally requires ${ROLLBACK_ACK_ENV}=${ROLLBACK_ACK_VALUE}.`,
].join('\n');

/** Narrow server-side readers: plain selects, no write surface. */
export function createRollbackReaders(client: ReturnType<typeof getCmsAdminClient>): {
  readBody(kind: BodyContentKind, postId: number, locale: string): Promise<string | null>;
  readPointer(kind: BodyContentKind, postId: number, locale: string): Promise<string | null>;
} {
  const table = (kind: BodyContentKind) => (kind === 'blog' ? 'blog_posts' : 'portfolio_posts');
  return {
    async readBody(kind, postId, locale) {
      const res = await client
        .from(table(kind))
        .select(`body_${locale}`)
        .eq('id', postId)
        .maybeSingle();
      if (res.error) {
        throw new Error(`[backfill-rollback] read body failed: ${res.error.message}`);
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
        throw new Error(`[backfill-rollback] read pointer failed: ${res.error.message}`);
      }
      const row = res.data as Record<string, unknown> | null;
      const value = row?.[`body_${locale}_path`];
      return typeof value === 'string' ? value : null;
    },
  };
}

function refuse(message: string): never {
  console.error(`[backfill-rollback] refusing: ${message}`);
  process.exit(5);
}

async function main(): Promise<void> {
  const args = parseRollbackArgs(process.argv.slice(2));
  if (args.mode === 'invalid') {
    console.error(`[backfill-rollback] ${args.error}`);
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
      `[backfill-rollback] expected: APP_ENV!=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=${BACKFILL_PLAN_SCHEMA}, project ${EXPECTED_DEV_PROJECT_REF}`
    );
    process.exit(3);
  }

  const projectRef = projectRefFromUrl(supabaseUrl) ?? '';
  const journalPathEnv = process.env.BACKFILL_JOURNAL_PATH ?? '';
  const fsApi = fs as unknown as JournalFsApi;

  try {
    if (!journalPathEnv) {
      refuse('BACKFILL_JOURNAL_PATH must name the journal produced by the backfill run');
    }
    await assertJournalDestination(journalPathEnv, fsApi, { repositoryRoot: process.cwd() });

    if (args.mode === 'apply') {
      if (appEnv !== 'development') {
        refuse(`APP_ENV must be exactly 'development', got '${appEnv}'`);
      }
      if (process.env[ROLLBACK_ACK_ENV] !== ROLLBACK_ACK_VALUE) {
        refuse(`set ${ROLLBACK_ACK_ENV}=${ROLLBACK_ACK_VALUE} to acknowledge a DEV rollback`);
      }
      if (args.expectProjectRef !== projectRef) {
        refuse(
          `--expect-project-ref=${args.expectProjectRef} does not match the configured project '${projectRef}'`
        );
      }
      const endpointProblem = validateRevalidationEndpoint(
        process.env.WEBSITE_REVALIDATION_URL ?? ''
      );
      if (endpointProblem) {
        refuse(`${endpointProblem} (a rollback must be able to invalidate the cache)`);
      }
      if (!process.env.WEBSITE_REVALIDATION_SECRET) {
        refuse('WEBSITE_REVALIDATION_SECRET is not configured');
      }
    }

    const journal = createFileJournal(journalPathEnv, fsApi);
    const parsed = await journal.read();
    const audit = auditJournal(parsed);
    if (!audit.trustworthy) {
      refuse(`journal at ${journalPathEnv} cannot be trusted: ${audit.problems.join('; ')}`);
    }

    const client = getCmsAdminClient();
    const readers = createRollbackReaders(client);
    const deps: RollbackDeps = {
      cas: createBackfillCasApi(client as unknown as CasRpcClient),
      readCommittedBody: readers.readBody,
      readCommittedPointer: readers.readPointer,
      invalidate: (invalidation) => invalidatePublicContent(invalidation),
      journal,
      now: () => new Date(),
    };

    const candidates = await planRollback(deps, args.runId ? { runId: args.runId } : {});

    if (args.mode === 'plan') {
      const ready = candidates.filter((candidate) => candidate.state === 'READY');
      console.log(
        JSON.stringify(
          {
            command: 'storage:content:dev:backfill:rollback',
            mode: 'plan',
            runId: args.runId ?? null,
            journalPath: journalPathEnv,
            plan: candidates,
            summary: {
              planned: candidates.length,
              ready: ready.length,
              alreadyRolledBack: candidates.filter((c) => c.state === 'ALREADY_ROLLED_BACK').length,
              conflicts: candidates.filter(
                (c) => c.state !== 'READY' && c.state !== 'ALREADY_ROLLED_BACK'
              ).length,
            },
            mutationsPerformed: 0,
          },
          null,
          2
        )
      );
      process.exit(candidates.length === 0 || ready.length > 0 ? 0 : 1);
    }

    // Settle invalidations an earlier rollback left pending before doing more
    // work: no upload, no pointer write, only the signed events.
    const pendingRollbacks = pendingRollbackRevalidations(parsed.records);
    const retries = pendingRollbacks.length
      ? await retryRollbackRevalidations(deps, pendingRollbacks)
      : [];

    const report = await executeRollback(deps, candidates);
    const retriesFailed = retries.filter((retry) => retry.outcome === 'FAILED').length;
    console.log(
      JSON.stringify(
        {
          command: 'storage:content:dev:backfill:rollback',
          mode: 'apply',
          journalPath: journalPathEnv,
          retriedInvalidations: retries,
          ...report,
        },
        null,
        2
      )
    );
    process.exit(
      report.summary.failed === 0 &&
        report.summary.conflicts === 0 &&
        !report.incomplete &&
        retriesFailed === 0
        ? 0
        : 1
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(4);
  }
}

await main();

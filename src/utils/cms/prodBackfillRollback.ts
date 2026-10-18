#!/usr/bin/env node
/**
 * Phase 13 C4 — production Markdown backfill rollback CLI.
 *
 *   PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/run.jsonl \
 *   bun run storage:content:prod:backfill:rollback [--run-id=<id>]
 *
 *   PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/run.jsonl \
 *   CMS_PROD_BACKFILL_ROLLBACK_ACK=yes-rollback-to-production-backfill \
 *   bun run storage:content:prod:backfill:rollback --apply --run-id=<id> \
 *     --expect-project-ref=<ref>
 *
 * The DEFAULT mode is a READ-ONLY plan: it reads the execution journal and the
 * live production rows and reports, per entry, whether the migration can be
 * undone (READY), was already undone, or must not be touched (the row moved on,
 * the body changed, the row is gone). It writes nothing, uploads nothing,
 * invalidates nothing.
 *
 * The candidate set is reconstructed from the RECORDED run — its stable run
 * identity plus the immutable manifest digest — never from a freshly planned
 * digest, because after a successful backfill a fresh plan describes the
 * migrated state rather than the original one. Each candidate is then verified
 * against the live row: the committed pointer must still be the key that run
 * installed, and the committed body must still hash to the recorded source.
 *
 * `--apply` is a separate, explicitly invoked operation (never automatic, never
 * triggered by the executor) and needs: the production environment tuple, the
 * production-only rollback acknowledgement, `--expect-project-ref`, the
 * production journal destination, an approved HTTPS revalidation endpoint with
 * its signing secret, and the full readiness report. It restores the previous
 * pointer of every READY candidate in reverse migration order through the
 * atomic guarded rollback CAS, invalidates each post once after ALL its locales
 * are restored, durably records every outcome, never writes `body_en` /
 * `body_it`, never deletes a Storage object, and refuses when a conflicting CMS
 * edit is found. An interrupted rollback is recoverable: pending rollback
 * invalidations are retried first and already-restored entries are reported
 * rather than re-written.
 *
 * Exit codes (same convention as the DEV tooling):
 *   0 plan can proceed (or apply finished cleanly)  1 attention required
 *   2 invalid usage                                 3 environment/project gate
 *   4 read or execution failure                     5 refused by a gate
 */
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import {
  appEnv,
  supabasePublishableKey,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import {
  executeRollback,
  parseRollbackArgs,
  planRollback,
  type RollbackApplyArgs,
  type RollbackDeps,
  retryRollbackRevalidations,
} from '@/libs/cms/storage/backfillApply';
import {
  type CasRpcClient,
  createBackfillCasApi,
} from '@/libs/cms/storage/backfillCas';
import {
  assertBackfillAcknowledged,
  assertBackfillEnvironment,
  type BackfillObservedEnvironment,
  PROD_BACKFILL_ENVIRONMENT,
  projectRefFromUrl,
} from '@/libs/cms/storage/backfillEnvironment';
import {
  assertJournalDestination,
  auditJournal,
  createFileJournal,
  type JournalFsApi,
  type JournalRecord,
  pendingRollbackRevalidations,
} from '@/libs/cms/storage/backfillJournal';
import type {
  PostBodyReader,
  ReadOnlyPostBodyClient,
} from '@/libs/cms/storage/backfillPlan';
import type { ProdCliOutcome } from '@/libs/cms/storage/prodBackfillGates';
import { PROD_FORBIDDEN_ROOTS_ENV } from '@/libs/cms/storage/prodBackfillGates';
import { createProdPostBodyReader } from '@/libs/cms/storage/prodBackfillPlan';
import {
  type AnonStorageClient,
  type BucketConfigClient,
  collectProdBackfillReadiness,
} from '@/libs/cms/storage/prodBackfillReadiness';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { createCommittedBodyReaders } from '@/utils/cms/prodBackfillReaders';
import { isDirectInvocation } from '@/utils/cms/prodStorageSetup';

export const PROD_BACKFILL_ROLLBACK_COMMAND =
  'storage:content:prod:backfill:rollback';

export const PROD_BACKFILL_ROLLBACK_USAGE = [
  'usage:',
  `  ${PROD_BACKFILL_ENVIRONMENT.journal.env}=<file outside both repositories> \\`,
  `  bun run ${PROD_BACKFILL_ROLLBACK_COMMAND} [--run-id=<id>]`,
  `  ${PROD_BACKFILL_ENVIRONMENT.journal.env}=<file outside both repositories> \\`,
  `  bun run ${PROD_BACKFILL_ROLLBACK_COMMAND} --apply --run-id=<id> --expect-project-ref=<ref>`,
  '',
  'The plan is read-only and is the default. --apply additionally requires',
  `${PROD_BACKFILL_ENVIRONMENT.rollbackAck.env}=${PROD_BACKFILL_ENVIRONMENT.rollbackAck.value}`,
  'and an approved HTTPS revalidation endpoint with its signing secret.',
].join('\n');

export type ProdBackfillRollbackDeps = {
  argv: string[];
  observed: BackfillObservedEnvironment;
  env: Readonly<Record<string, string | undefined>>;
  fs: JournalFsApi;
  repositoryRoots: string[];
  /** Pointer-aware reader factory, used by the readiness report. */
  openReader(mode: 'manifest', schema: string): PostBodyReader;
  casClient: CasRpcClient;
  anonCasClient: CasRpcClient;
  buckets: BucketConfigClient;
  anonStorage: AnonStorageClient;
  readCommittedBody: RollbackDeps['readCommittedBody'];
  readCommittedPointer: RollbackDeps['readCommittedPointer'];
  invalidate: RollbackDeps['invalidate'];
  now(): Date;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The read-only plan. It requires the journal (a rollback is only meaningful
 * against a recorded run) and never mutates anything.
 */
async function runPlan(
  runId: string | undefined,
  rollbackDeps: RollbackDeps,
  journalPath: string
): Promise<ProdCliOutcome> {
  const candidates = await planRollback(rollbackDeps, runId ? { runId } : {});
  const ready = candidates.filter((candidate) => candidate.state === 'READY');
  return {
    exitCode: candidates.length === 0 || ready.length > 0 ? 0 : 1,
    error: null,
    report: {
      command: PROD_BACKFILL_ROLLBACK_COMMAND,
      mode: 'plan',
      runId: runId ?? null,
      journalPath,
      plan: candidates,
      summary: {
        planned: candidates.length,
        ready: ready.length,
        alreadyRolledBack: candidates.filter(
          (candidate) => candidate.state === 'ALREADY_ROLLED_BACK'
        ).length,
        conflicts: candidates.filter(
          (candidate) =>
            candidate.state !== 'READY' &&
            candidate.state !== 'ALREADY_ROLLED_BACK'
        ).length,
        byState: candidates.reduce<Record<string, number>>(
          (counts, candidate) => {
            counts[candidate.state] = (counts[candidate.state] ?? 0) + 1;
            return counts;
          },
          {}
        ),
      },
      mutationsPerformed: 0,
    },
  };
}

async function runApply(
  deps: ProdBackfillRollbackDeps,
  args: RollbackApplyArgs,
  rollbackDeps: RollbackDeps,
  journalPath: string,
  parsedRecords: JournalRecord[]
): Promise<ProdCliOutcome> {
  const readiness = await collectProdBackfillReadiness({
    reader: deps.openReader('manifest', deps.observed.schema),
    casClient: deps.casClient,
    anonCasClient: deps.anonCasClient,
    buckets: deps.buckets,
    anonStorage: deps.anonStorage,
  });
  if (!readiness.ok) {
    return {
      exitCode: 5,
      report: {
        command: PROD_BACKFILL_ROLLBACK_COMMAND,
        mode: 'apply',
        readiness,
        mutationsPerformed: 0,
      },
      error: `[prod-backfill-rollback] refusing: production is not ready: ${readiness.problems.join('; ')}`,
    };
  }

  // Settle invalidations an earlier rollback left pending before doing more
  // work: no upload, no pointer write, only the signed events.
  const pending = pendingRollbackRevalidations(parsedRecords);
  const retries = pending.length
    ? await retryRollbackRevalidations(rollbackDeps, pending)
    : [];

  const candidates = await planRollback(
    rollbackDeps,
    args.runId ? { runId: args.runId } : {}
  );
  const report = await executeRollback(rollbackDeps, candidates);
  const retriesFailed = retries.filter(
    (retry) => retry.outcome === 'FAILED'
  ).length;

  return {
    exitCode:
      report.summary.failed === 0 &&
      report.summary.conflicts === 0 &&
      !report.incomplete &&
      retriesFailed === 0
        ? 0
        : 1,
    error: null,
    report: {
      command: PROD_BACKFILL_ROLLBACK_COMMAND,
      mode: 'apply',
      journalPath,
      readiness,
      retriedInvalidations: retries,
      ...report,
    },
  };
}

/**
 * The whole command: usage -> environment gate -> (apply gates) -> journal ->
 * plan or apply. Every refusal is a returned outcome with its exit code, so the
 * process entry point and the tests see the same decision.
 */
export async function runProdBackfillRollback(
  deps: ProdBackfillRollbackDeps
): Promise<ProdCliOutcome> {
  const spec = PROD_BACKFILL_ENVIRONMENT;
  const args = parseRollbackArgs(deps.argv);
  if (args.mode === 'invalid') {
    return {
      exitCode: 2,
      report: null,
      error: `[prod-backfill-rollback] ${args.error}\n${PROD_BACKFILL_ROLLBACK_USAGE}`,
    };
  }

  // The environment gate runs before any client exists.
  try {
    assertBackfillEnvironment(spec, deps.observed);
  } catch (error) {
    return { exitCode: 3, report: null, error: messageOf(error) };
  }

  const projectRef = projectRefFromUrl(deps.observed.supabaseUrl) ?? '';
  const journalPath = deps.env[spec.journal.env] ?? '';

  if (args.mode === 'apply') {
    try {
      assertBackfillAcknowledged(
        spec,
        'rollback',
        deps.env[spec.rollbackAck.env]
      );
    } catch (error) {
      return { exitCode: 5, report: null, error: messageOf(error) };
    }
    if (args.expectProjectRef !== projectRef) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-rollback] refusing: --expect-project-ref=${args.expectProjectRef} does not match the configured project '${projectRef}'`,
      };
    }
  }

  if (!journalPath) {
    return {
      exitCode: 5,
      report: null,
      error: `[prod-backfill-rollback] refusing: ${spec.journal.env} must name the journal produced by the backfill run`,
    };
  }
  try {
    await assertJournalDestination(journalPath, deps.fs, {
      repositoryRoot: deps.repositoryRoots[0],
      additionalRoots: deps.repositoryRoots.slice(1),
    });
  } catch (error) {
    return { exitCode: 5, report: null, error: messageOf(error) };
  }

  try {
    const journal = createFileJournal(journalPath, deps.fs, deps.now);
    const parsed = await journal.read();
    const audit = auditJournal(parsed);
    if (!audit.trustworthy) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-rollback] refusing: journal at ${journalPath} cannot be trusted: ${audit.problems.join('; ')}`,
      };
    }

    const rollbackDeps: RollbackDeps = {
      cas: createBackfillCasApi(deps.casClient, spec),
      readCommittedBody: deps.readCommittedBody,
      readCommittedPointer: deps.readCommittedPointer,
      invalidate: deps.invalidate,
      journal,
      now: deps.now,
    };

    if (args.mode === 'apply') {
      return await runApply(
        deps,
        args,
        rollbackDeps,
        journalPath,
        parsed.records
      );
    }
    return await runPlan(args.runId, rollbackDeps, journalPath);
  } catch (error) {
    return { exitCode: 4, report: null, error: messageOf(error) };
  }
}

async function main(): Promise<void> {
  const observed: BackfillObservedEnvironment = {
    appEnv,
    schema: supabaseSchema,
    supabaseUrl,
    hasServerSecret: supabaseServerSecret !== '',
  };
  const admin = getCmsAdminClient();
  const anon = createClient(supabaseUrl, supabasePublishableKey, {
    db: { schema: supabaseSchema },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const readers = createCommittedBodyReaders(admin, 'prod-backfill-rollback');

  const outcome = await runProdBackfillRollback({
    argv: process.argv.slice(2),
    observed,
    env: process.env,
    fs: fs as unknown as JournalFsApi,
    repositoryRoots: [
      process.cwd(),
      ...(process.env[PROD_FORBIDDEN_ROOTS_ENV] ?? '')
        .split(':')
        .map((root) => root.trim())
        .filter((root) => root !== ''),
    ],
    openReader(mode, schema) {
      return createProdPostBodyReader(
        admin as unknown as ReadOnlyPostBodyClient,
        mode,
        schema
      );
    },
    casClient: admin as unknown as CasRpcClient,
    anonCasClient: anon as unknown as CasRpcClient,
    buckets: admin.storage as unknown as BucketConfigClient,
    anonStorage: anon.storage as unknown as AnonStorageClient,
    readCommittedBody: readers.readBody,
    readCommittedPointer: readers.readPointer,
    invalidate: (invalidation) => invalidatePublicContent(invalidation),
    now: () => new Date(),
  });

  if (outcome.report) console.log(JSON.stringify(outcome.report, null, 2));
  if (outcome.error) console.error(outcome.error);
  if (outcome.exitCode === 3) {
    console.error(
      `[prod-backfill-rollback] expected: APP_ENV=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public, project ${PROD_BACKFILL_ENVIRONMENT.projectRef}, bucket ${PROD_BACKFILL_ENVIRONMENT.bucket}, server secret present`
    );
  }
  process.exit(outcome.exitCode);
}

if (isDirectInvocation(process.argv, import.meta.url)) {
  await main();
}

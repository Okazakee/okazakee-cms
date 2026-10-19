#!/usr/bin/env node
/**
 * Phase 13 C3 — production Markdown backfill executor CLI.
 *
 *   bun run storage:content:prod:backfill:exec --preflight
 *   PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/run.jsonl \
 *   CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill \
 *   CMS_PROD_REVALIDATION_ORIGINS=https://<approved-origin> \
 *   bun run storage:content:prod:backfill:exec \
 *     --apply (--new-run | --resume) --confirm-digest=<manifest sha256> \
 *     --expect-project-ref=<ref>
 *
 * `--preflight` is entirely read-only: the production gates, the pointer-aware
 * manifest, its digest, the five readiness probes, the journal state and
 * whether the revalidation destination is configured and approved. It uploads
 * nothing, switches nothing, invalidates nothing.
 *
 * `--apply` needs ALL of the following, checked in this order and refused with
 * exit 5 at the first failure — before any mutation, and the environment gate
 * before even the first network call:
 *
 *   1. `APP_ENV=production`, schema `public`, project `mtvwynyikouqzmhqespl`,
 *      bucket `website-content`, a server secret (the shared environment gate);
 *   2. `CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill`
 *      (a DEV acknowledgement value is refused by construction);
 *   3. `--expect-project-ref` equal to the configured project;
 *   4. `PROD_BACKFILL_JOURNAL_PATH` (a production-specific variable) set,
 *      absolute, outside every configured repository root and not group/world
 *      readable, and the journal readable and trustworthy;
 *   5. the HTTPS revalidation endpoint approved through the configured origin
 *      allowlist, on the exact route, with the signing secret present;
 *   6. verified readiness: pointer columns, both CAS signatures, CAS
 *      privileges (not callable through the publishable path), bucket
 *      configuration and Storage isolation;
 *   7. for a new run, `--confirm-digest` equal to the freshly computed
 *      PRODUCTION manifest digest and a manifest with no blockers; for a
 *      resume, the digest recorded with the run's immutable manifest.
 *
 * Execution itself is the shared, DEV-proven implementation: strict sequential
 * fail-fast, verify source -> verify path -> upload without upsert -> download
 * and hash-verify -> atomic CAS -> verify the committed pointer -> signed
 * invalidation -> durable record. On the first unexpected failure it stops
 * starting work, preserves committed pointers, objects and the journal, reports
 * the failed and pending entries, exits nonzero, and never resumes, rolls back
 * or deletes anything by itself.
 *
 * Exit codes (same convention as the DEV tooling and the setup commands):
 *   0 preflight ok / apply without failures     1 blockers or failures
 *   2 invalid usage                             3 environment/project gate
 *   4 read or execution failure                 5 refused by a gate
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import {
  appEnv,
  supabasePublishableKey,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import { POINTER_COLUMNS_FLAG } from '@/libs/cms/bodyWriteGate';
import {
  type BackfillExecutorDeps,
  type ExecApplyArgs,
  type ExecutionManifest,
  executeBackfill,
  executionManifest,
  manifestDigest,
  parseExecArgs,
  planFromManifest,
  retryPendingRevalidations,
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
  recordedManifest,
  selectResumeRun,
} from '@/libs/cms/storage/backfillJournal';
import {
  type BackfillPlanEntry,
  type BackfillPlanSummary,
  buildBackfillPlan,
  type PostBodyReader,
  type ReadOnlyPostBodyClient,
  summarizePlan,
} from '@/libs/cms/storage/backfillPlan';
import type { BodyContentStorageApi } from '@/libs/cms/storage/bodyContent';
import type { ProdCliOutcome } from '@/libs/cms/storage/prodBackfillGates';
import {
  PROD_FORBIDDEN_ROOTS_ENV,
  resolveProdMutationGates,
} from '@/libs/cms/storage/prodBackfillGates';
import {
  createProdPostBodyReader,
  PROD_MANIFEST_PROJECTION,
  type ProdPointerColumnMode,
} from '@/libs/cms/storage/prodBackfillPlan';
import {
  type AnonStorageClient,
  type BucketConfigClient,
  collectProdBackfillReadiness,
  type ProdReadinessReport,
} from '@/libs/cms/storage/prodBackfillReadiness';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { createCommittedBodyReaders } from '@/utils/cms/prodBackfillReaders';
import { isDirectInvocation } from '@/utils/cms/prodStorageSetup';

export const PROD_BACKFILL_EXEC_COMMAND = 'storage:content:prod:backfill:exec';

export const PROD_BACKFILL_EXEC_USAGE = [
  'usage:',
  `  bun run ${PROD_BACKFILL_EXEC_COMMAND} --preflight`,
  `  ${PROD_BACKFILL_ENVIRONMENT.journal.env}=<file outside both repositories> \\`,
  `  bun run ${PROD_BACKFILL_EXEC_COMMAND} --apply (--new-run | --resume) \\`,
  '    --confirm-digest=<sha256> --expect-project-ref=<ref>',
  '',
  `--apply additionally requires ${PROD_BACKFILL_ENVIRONMENT.applyAck.env}=${PROD_BACKFILL_ENVIRONMENT.applyAck.value},`,
  `WEBSITE_REVALIDATION_URL on an origin listed in ${PROD_BACKFILL_ENVIRONMENT.revalidation.kind === 'https-allowlist' ? PROD_BACKFILL_ENVIRONMENT.revalidation.originsEnv : ''}`,
  'and the signing secret. Nothing runs automatically, and nothing is rolled back automatically.',
].join('\n');

/**
 * Everything the command needs. Nothing is read from the process inside the
 * runner: the environment gate, the journal and every client are injected, so
 * the complete gate matrix can be exercised without a network or a database.
 */
export type ProdBackfillExecDeps = {
  argv: string[];
  observed: BackfillObservedEnvironment;
  env: Readonly<Record<string, string | undefined>>;
  fs: JournalFsApi;
  /** Repository roots the journal must live outside (first = this checkout). */
  repositoryRoots: string[];
  /** Read-only production reader factory, for one operating state. */
  openReader(mode: ProdPointerColumnMode, schema: string): PostBodyReader;
  casClient: CasRpcClient;
  anonCasClient: CasRpcClient;
  buckets: BucketConfigClient;
  anonStorage: AnonStorageClient;
  storage: BodyContentStorageApi;
  readCommittedBody: BackfillExecutorDeps['readCommittedBody'];
  readCommittedPointer: BackfillExecutorDeps['readCommittedPointer'];
  invalidate: BackfillExecutorDeps['invalidate'];
  now(): Date;
  newRunId(): string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The production manifest: production rows, read with the pointer projection,
 * classified by the SHARED plan builder. The DEV manifest is never consulted —
 * the baseline is whatever `public` holds right now.
 */
async function readProductionManifest(
  deps: Pick<ProdBackfillExecDeps, 'openReader' | 'observed'>
): Promise<BackfillPlanEntry[]> {
  const reader = deps.openReader('manifest', deps.observed.schema);
  const [blog, portfolio] = await Promise.all([
    reader.listPostBodies('blog'),
    reader.listPostBodies('portfolio'),
  ]);
  return buildBackfillPlan({ blog, portfolio });
}

/** The readiness probes, all read-only, on the pointer-aware projection. */
async function collectReadiness(deps: {
  reader: PostBodyReader;
  casClient: CasRpcClient;
  anonCasClient: CasRpcClient;
  buckets: BucketConfigClient;
  anonStorage: AnonStorageClient;
}): Promise<ProdReadinessReport> {
  return collectProdBackfillReadiness({
    reader: deps.reader,
    casClient: deps.casClient,
    anonCasClient: deps.anonCasClient,
    buckets: deps.buckets,
    anonStorage: deps.anonStorage,
  });
}

/** Read-only journal inspection for the preflight report. */
async function inspectJournal(
  path: string,
  fsApi: JournalFsApi
): Promise<Record<string, unknown>> {
  if (!path) return { pathConfigured: false, path: null };
  try {
    const parsed = await createFileJournal(path, fsApi).read();
    const audit = auditJournal(parsed);
    return {
      pathConfigured: true,
      path,
      trustworthy: audit.trustworthy,
      problems: audit.problems,
      warnings: audit.warnings,
      runs: audit.runs.map((run) => ({
        runId: run.runId,
        manifestDigest: run.manifestDigest,
        entriesTotal: run.entriesTotal,
        entriesSucceeded: run.entriesSucceeded,
        entriesFailed: run.entriesFailed,
        entriesMissing: run.entriesMissing,
        pendingRevalidations: run.pendingRevalidations.length,
      })),
    };
  } catch (error) {
    return {
      pathConfigured: true,
      path,
      readable: false,
      error: messageOf(error),
    };
  }
}

async function runPreflight(
  deps: ProdBackfillExecDeps,
  projectRef: string
): Promise<ProdCliOutcome> {
  const spec = PROD_BACKFILL_ENVIRONMENT;
  const plan = await readProductionManifest(deps);
  const summary = summarizePlan(plan);
  const digest = manifestDigest(plan);

  let readiness: ProdReadinessReport;
  try {
    readiness = await collectReadiness({
      reader: deps.openReader('manifest', deps.observed.schema),
      casClient: deps.casClient,
      anonCasClient: deps.anonCasClient,
      buckets: deps.buckets,
      anonStorage: deps.anonStorage,
    });
  } catch (error) {
    readiness = {
      ok: false,
      checks: [],
      problems: [`readiness probes failed: ${messageOf(error)}`],
    };
  }

  const journalPath = deps.env[spec.journal.env] ?? '';
  const journal = await inspectJournal(journalPath, deps.fs);
  let journalDestinationProblem = '';
  if (journalPath) {
    try {
      await assertJournalDestination(journalPath, deps.fs, {
        repositoryRoot: deps.repositoryRoots[0],
        additionalRoots: deps.repositoryRoots.slice(1),
      });
    } catch (error) {
      journalDestinationProblem = messageOf(error);
    }
  }
  const gates = resolveProdMutationGates(spec, deps.env);

  return {
    exitCode: summary.blockers === 0 && readiness.ok ? 0 : 1,
    error: null,
    report: {
      command: PROD_BACKFILL_EXEC_COMMAND,
      mode: 'preflight',
      appEnv: deps.observed.appEnv,
      schema: deps.observed.schema,
      projectRef,
      bucket: spec.bucket,
      pointerColumns: PROD_MANIFEST_PROJECTION,
      pointerColumnsAsserted: deps.env[POINTER_COLUMNS_FLAG] === 'true',
      planDigest: digest,
      ok: summary.blockers === 0 && readiness.ok,
      plan: summary,
      readiness,
      journal: {
        ...journal,
        destinationProblem: journalDestinationProblem || null,
      },
      revalidation: {
        endpointConfigured: !!gates.ok,
        problem: gates.ok ? null : gates.error,
        allowedOrigins: gates.ok ? gates.gates.allowedOrigins : [],
      },
      applyArmed: false,
      mutationsPerformed: 0,
    },
  };
}

async function runApply(
  deps: ProdBackfillExecDeps,
  _projectRef: string,
  args: ExecApplyArgs
): Promise<ProdCliOutcome> {
  const spec = PROD_BACKFILL_ENVIRONMENT;
  const journalPath = deps.env[spec.journal.env] ?? '';
  const journal = createFileJournal(journalPath, deps.fs, deps.now);
  const parsed = await journal.read();
  const audit = auditJournal(parsed);
  if (!audit.trustworthy) {
    return {
      exitCode: 5,
      report: null,
      error: `[prod-backfill-exec] refusing: journal at ${journalPath} cannot be trusted: ${audit.problems.join('; ')}`,
    };
  }

  // Readiness BEFORE any journal write: a failed probe must leave the journal
  // exactly as it was, so a refused apply can be retried with --new-run.
  const readiness = await collectReadiness({
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
        command: PROD_BACKFILL_EXEC_COMMAND,
        mode: 'apply',
        readiness,
        mutationsPerformed: 0,
      },
      error: `[prod-backfill-exec] refusing: production is not ready: ${readiness.problems.join('; ')}`,
    };
  }

  let runId: string;
  let manifest: ExecutionManifest;
  let workPlan: BackfillPlanEntry[];
  let resumed = false;
  let manifestSummary: BackfillPlanSummary;

  if (args.runSelection === 'resume') {
    const selection = selectResumeRun(audit, {});
    if (!selection.ok) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: ${selection.error}`,
      };
    }
    runId = selection.run.runId;
    // The run's own immutable manifest is authoritative: a digest recomputed
    // now would classify the entries the earlier run already switched as
    // ALREADY_CURRENT and no longer describe the same run.
    const lookup = recordedManifest(parsed.records, runId);
    if (!lookup.ok) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: ${lookup.error}; a resume needs the immutable manifest recorded by the run`,
      };
    }
    manifest = {
      runId,
      manifestDigest: lookup.manifest.manifestDigest,
      entries: lookup.manifest.entries,
    };
    if (args.confirmDigest !== manifest.manifestDigest) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: --confirm-digest does not match the recorded execution manifest ${manifest.manifestDigest}`,
      };
    }
    const observedPointers = await Promise.all(
      lookup.manifest.entries.map((entry) =>
        deps.readCommittedPointer(
          entry.kind as 'blog' | 'portfolio',
          entry.postId,
          entry.locale as 'en' | 'it'
        )
      )
    );
    workPlan = planFromManifest(lookup.manifest, observedPointers);
    resumed = true;
    manifestSummary = summarizePlan(workPlan);
  } else {
    const unfinished = audit.runs.filter(
      (run) => run.unresolved.length > 0 || run.pendingRevalidations.length > 0
    );
    if (unfinished.length > 0) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: journal already holds an unfinished run (${unfinished
          .map((run) => run.runId)
          .join(', ')}); use --resume instead of --new-run`,
      };
    }
    workPlan = await readProductionManifest(deps);
    manifestSummary = summarizePlan(workPlan);
    const digest = manifestDigest(workPlan);
    if (args.confirmDigest !== digest) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: --confirm-digest does not match the current production manifest digest ${digest}`,
      };
    }
    if (manifestSummary.blockers > 0) {
      return {
        exitCode: 1,
        report: {
          command: PROD_BACKFILL_EXEC_COMMAND,
          mode: 'apply',
          planDigest: digest,
          plan: manifestSummary,
          mutationsPerformed: 0,
        },
        error: `[prod-backfill-exec] refusing: plan has ${manifestSummary.blockers} blockers`,
      };
    }
    runId = deps.newRunId();
    manifest = executionManifest(runId, workPlan);
    // The immutable identity is recorded BEFORE the first mutation.
    await journal.append({
      type: 'manifest',
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      entries: manifest.entries,
      at: deps.now().toISOString(),
    });
  }

  const execDeps: BackfillExecutorDeps = {
    storage: deps.storage,
    cas: createBackfillCasApi(deps.casClient, spec),
    readCommittedBody: deps.readCommittedBody,
    readCommittedPointer: deps.readCommittedPointer,
    invalidate: deps.invalidate,
    journal,
    now: deps.now,
    newRunId: () => runId,
  };

  // On a resume, first settle the invalidations an interrupted run left
  // pending: no upload, no pointer write, only the signed event.
  const retries = resumed
    ? await retryPendingRevalidations(
        execDeps,
        audit.runs
          .filter((run) => run.runId === runId)
          .flatMap((run) => run.pendingRevalidations)
      )
    : [];

  const report = await executeBackfill(execDeps, workPlan, {
    runId,
    revalidate: true,
    failFast: true,
    manifest,
  });

  return {
    exitCode: report.summary.failures === 0 ? 0 : 1,
    error: null,
    report: {
      command: PROD_BACKFILL_EXEC_COMMAND,
      mode: 'apply',
      resumed,
      journalPath,
      planDigest: manifest.manifestDigest,
      pointerColumns: PROD_MANIFEST_PROJECTION,
      plan: manifestSummary,
      readiness,
      retriedInvalidations: retries,
      ...report,
    },
  };
}

/**
 * The whole command: usage -> production gates -> read/preflight or apply.
 * Every refusal is a returned outcome with its exit code, never a throw into
 * the process, so the caller (CLI or test) sees the same report.
 */
export async function runProdBackfillExec(
  deps: ProdBackfillExecDeps
): Promise<ProdCliOutcome> {
  const spec = PROD_BACKFILL_ENVIRONMENT;
  const args = parseExecArgs(deps.argv);
  if (args.mode === 'invalid') {
    return {
      exitCode: 2,
      report: null,
      error: `[prod-backfill-exec] ${args.error}\n${PROD_BACKFILL_EXEC_USAGE}`,
    };
  }

  // 1. The environment gate, before any client exists: a wrong APP_ENV, schema,
  // project or bucket never reaches the network.
  try {
    assertBackfillEnvironment(spec, deps.observed);
  } catch (error) {
    return { exitCode: 3, report: null, error: messageOf(error) };
  }

  const projectRef = projectRefFromUrl(deps.observed.supabaseUrl) ?? '';

  if (args.mode === 'apply') {
    // 2. The production-only acknowledgement.
    try {
      assertBackfillAcknowledged(spec, 'apply', deps.env[spec.applyAck.env]);
    } catch (error) {
      return { exitCode: 5, report: null, error: messageOf(error) };
    }
    // 3. The configured project reference.
    if (args.expectProjectRef !== projectRef) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: --expect-project-ref=${args.expectProjectRef} does not match the configured project '${projectRef}'`,
      };
    }
    // 4/5. Journal destination plus the approved HTTPS endpoint and secret.
    const gates = resolveProdMutationGates(spec, deps.env);
    if (!gates.ok) {
      return {
        exitCode: 5,
        report: null,
        error: `[prod-backfill-exec] refusing: ${gates.error}`,
      };
    }
    try {
      await assertJournalDestination(gates.gates.journalPath, deps.fs, {
        repositoryRoot: deps.repositoryRoots[0],
        additionalRoots: deps.repositoryRoots.slice(1),
      });
    } catch (error) {
      return { exitCode: 5, report: null, error: messageOf(error) };
    }
    try {
      return await runApply(deps, projectRef, args);
    } catch (error) {
      return { exitCode: 4, report: null, error: messageOf(error) };
    }
  }

  try {
    return await runPreflight(deps, projectRef);
  } catch (error) {
    return { exitCode: 4, report: null, error: messageOf(error) };
  }
}

/** The production-only roots the journal must live outside. */
export function forbiddenRootsFromEnv(
  env: Readonly<Record<string, string | undefined>>
): string[] {
  return (env[PROD_FORBIDDEN_ROOTS_ENV] ?? '')
    .split(':')
    .map((root) => root.trim())
    .filter((root) => root !== '');
}

async function main(): Promise<void> {
  const observed: BackfillObservedEnvironment = {
    appEnv,
    schema: supabaseSchema,
    supabaseUrl,
    hasServerSecret: supabaseServerSecret !== '',
  };
  // The client is constructed only after the environment gate has passed; the
  // publishable path is a separate client so the privilege probes are real.
  const admin = getCmsAdminClient();
  const anon = createClient(supabaseUrl, supabasePublishableKey, {
    db: { schema: supabaseSchema },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const readers = createCommittedBodyReaders(admin, 'prod-backfill-exec');

  const outcome = await runProdBackfillExec({
    argv: process.argv.slice(2),
    observed,
    env: process.env,
    fs: fs as unknown as JournalFsApi,
    repositoryRoots: [process.cwd(), ...forbiddenRootsFromEnv(process.env)],
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
    storage: admin.storage.from(
      PROD_BACKFILL_ENVIRONMENT.bucket
    ) as unknown as BodyContentStorageApi,
    readCommittedBody: readers.readBody,
    readCommittedPointer: readers.readPointer,
    invalidate: (invalidation) => invalidatePublicContent(invalidation),
    now: () => new Date(),
    newRunId: () => randomUUID(),
  });

  if (outcome.report) console.log(JSON.stringify(outcome.report, null, 2));
  if (outcome.error) console.error(outcome.error);
  if (outcome.exitCode === 3) {
    console.error(
      `[prod-backfill-exec] expected: APP_ENV=production, NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public, project ${PROD_BACKFILL_ENVIRONMENT.projectRef}, bucket ${PROD_BACKFILL_ENVIRONMENT.bucket}, server secret present`
    );
  }
  process.exit(outcome.exitCode);
}

if (isDirectInvocation(process.argv, import.meta.url)) {
  await main();
}

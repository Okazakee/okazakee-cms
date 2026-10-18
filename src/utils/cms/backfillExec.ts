#!/usr/bin/env node
/**
 * Markdown body backfill executor CLI (Phase 11B.1; hardened in 11B.2) — DEV only.
 *
 *   bun run storage:content:dev:backfill:exec --preflight
 *   BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
 *   CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging \
 *   bun run storage:content:dev:backfill:exec --apply --new-run \
 *     --confirm-digest=<manifest sha256> --expect-project-ref=<ref>
 *
 * `--preflight` is read-only: gates, plan, manifest digest, CAS readiness (a
 * call the SQL refuses before it can write), and whether a revalidation
 * destination is configured and approved.
 *
 * `--apply` is gated and inert without an operator:
 *   1. explicit `--apply` plus an explicit run selection (`--new-run` or
 *      `--resume`);
 *   2. `--confirm-digest` equal to the freshly computed plan digest and
 *      `--expect-project-ref` equal to the configured project reference;
 *   3. `CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging`;
 *   4. `APP_ENV=development` exactly, `dev_staging`, `website-content-dev`, a
 *      server secret, an approved local DEV revalidation destination with a
 *      signing secret, and a durable `BACKFILL_JOURNAL_PATH` outside the repo.
 *
 * A `--resume` continues the unfinished run recorded in that journal, retries
 * its pending invalidations, and re-reads the database and Storage for every
 * entry. `--new-run` refuses while an unfinished run exists in the journal.
 *
 * Exit codes:
 *   0 preflight ok / apply without failures     1 blockers or failures
 *   2 invalid usage                             3 environment/project gate failure
 *   4 read or execution failure                  5 refused by an apply gate
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
  executionManifest,
  manifestDigest,
  parseExecArgs,
  planFromManifest,
  retryPendingRevalidations,
  validateRevalidationEndpoint,
  type BackfillExecutorDeps,
  type ExecutionManifest,
} from '@/libs/cms/storage/backfillApply';
import type {
  BodyContentKind,
  BodyContentLocale,
  BodyContentStorageApi,
} from '@/libs/cms/storage/bodyContent';
import {
  assertJournalDestination,
  auditJournal,
  createFileJournal,
  recordedManifest,
  selectResumeRun,
  type JournalFsApi,
} from '@/libs/cms/storage/backfillJournal';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

const USAGE = [
  'usage:',
  '  bun run storage:content:dev:backfill:exec --preflight',
  '  BACKFILL_JOURNAL_PATH=<file outside the repo> bun run storage:content:dev:backfill:exec \\',
  '    --apply (--new-run | --resume) --confirm-digest=<sha256> --expect-project-ref=<ref>',
  '',
  `apply additionally requires ${APPLY_ACK_ENV}=${APPLY_ACK_VALUE}.`,
].join('\n');

/**
 * Narrow server-side readers for the executor. Both are plain selects on an
 * explicit projection; no write surface is created here.
 */
export function createPostgresReaders(client: ReturnType<typeof getCmsAdminClient>): {
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

function refuse(message: string): never {
  console.error(`[backfill-exec] refusing --apply: ${message}`);
  process.exit(5);
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
  const journalPathEnv = process.env.BACKFILL_JOURNAL_PATH ?? '';
  const revalidationProblem = validateRevalidationEndpoint(
    process.env.WEBSITE_REVALIDATION_URL ?? ''
  );

  try {
    const rows = await readPlanRows(client as unknown as ReadOnlyPostBodyClient);
    const plan = buildBackfillPlan(rows);
    const summary = summarizePlan(plan);
    const digest = manifestDigest(plan);
    const readiness = await probeCasReadiness(client as unknown as CasRpcClient);

    if (args.mode === 'preflight') {
      // Read-only journal inspection (never required for a preflight).
      let journalState: Record<string, unknown> = {
        pathConfigured: journalPathEnv !== '',
        path: journalPathEnv || null,
      };
      if (journalPathEnv) {
        try {
          const parsedPreview = await createFileJournal(journalPathEnv, fs as unknown as JournalFsApi).read();
          const auditPreview = auditJournal(parsedPreview);
          const unfinished = auditPreview.runs.filter(
            (run) => run.unresolved.length > 0 || run.pendingRevalidations.length > 0
          );
          const lookup = recordedManifest(parsedPreview.records);
          journalState = {
            ...journalState,
            trustworthy: auditPreview.trustworthy,
            problems: auditPreview.problems,
            warnings: auditPreview.warnings,
            unfinishedRuns: unfinished.map((run) => ({
              runId: run.runId,
              manifestDigest: run.manifestDigest,
              unresolved: run.unresolved.length,
              pendingRevalidations: run.pendingRevalidations.length,
            })),
            recordedManifestDigest: lookup.ok ? lookup.manifest.manifestDigest : null,
          };
        } catch (error) {
          journalState = {
            ...journalState,
            readable: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

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
            planDigest: digest,
            ok: summary.blockers === 0,
            plan: summary,
            cas: readiness,
            journal: journalState,
            revalidation: {
              approvedLocalDestination: revalidationProblem === null,
              problem: revalidationProblem,
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
    if (appEnv !== 'development') {
      refuse(`APP_ENV must be exactly 'development', got '${appEnv}'`);
    }
    if (process.env[APPLY_ACK_ENV] !== APPLY_ACK_VALUE) {
      refuse(`set ${APPLY_ACK_ENV}=${APPLY_ACK_VALUE} to acknowledge a DEV backfill run`);
    }
    if (args.expectProjectRef !== projectRef) {
      refuse(
        `--expect-project-ref=${args.expectProjectRef} does not match the configured project '${projectRef}'`
      );
    }
    if (args.confirmDigest !== digest) {
      refuse(`--confirm-digest does not match the current plan digest ${digest}`);
    }
    if (summary.blockers > 0) {
      console.error(`[backfill-exec] refusing --apply: plan has ${summary.blockers} blockers`);
      process.exit(1);
    }
    if (readiness.state !== 'ready') {
      refuse(
        `staged CAS functions are not installed in ${BACKFILL_PLAN_SCHEMA} (${readiness.state})`
      );
    }
    if (revalidationProblem) {
      refuse(`${revalidationProblem} (refusing to switch pointers that cannot be invalidated)`);
    }
    if (!process.env.WEBSITE_REVALIDATION_SECRET) {
      refuse('WEBSITE_REVALIDATION_SECRET is not configured');
    }
    if (!journalPathEnv) {
      refuse('BACKFILL_JOURNAL_PATH must be set so the run is recoverable across invocations');
    }

    const fsApi = fs as unknown as JournalFsApi;
    try {
      await assertJournalDestination(journalPathEnv, fsApi, { repositoryRoot: process.cwd() });
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }

    const journal = createFileJournal(journalPathEnv, fsApi);
    const parsed = await journal.read();
    const audit = auditJournal(parsed);
    if (!audit.trustworthy) {
      refuse(`journal at ${journalPathEnv} cannot be trusted: ${audit.problems.join('; ')}`);
    }

    let runId: string;
    let resumed = false;
    let manifest: ExecutionManifest;
    let workPlan = plan;

    if (args.runSelection === 'resume') {
      const selection = selectResumeRun(audit, {});
      if (!selection.ok) {
        refuse(selection.error);
      }
      runId = selection.run.runId;

      // The run's own immutable manifest is authoritative. A digest recomputed
      // now would classify the entries the earlier run already switched as
      // ALREADY_CURRENT and no longer describe the same run.
      const lookup = recordedManifest(parsed.records, runId);
      if (!lookup.ok) {
        refuse(
          `${lookup.error}; a resume needs the immutable manifest recorded by a Phase 12+ run`
        );
      }
      manifest = {
        runId,
        manifestDigest: lookup.manifest.manifestDigest,
        entries: lookup.manifest.entries,
      };
      if (args.confirmDigest !== manifest.manifestDigest) {
        refuse(
          `--confirm-digest does not match the recorded execution manifest ${manifest.manifestDigest}`
        );
      }

      const observed = await Promise.all(
        lookup.manifest.entries.map((entry) =>
          readers.readPointer(
            entry.kind as BodyContentKind,
            entry.postId,
            entry.locale as BodyContentLocale
          )
        )
      );
      workPlan = planFromManifest(lookup.manifest, observed);
      resumed = true;
    } else {
      const unfinished = audit.runs.filter(
        (run) => run.unresolved.length > 0 || run.pendingRevalidations.length > 0
      );
      if (unfinished.length > 0) {
        refuse(
          `journal already holds an unfinished run (${unfinished
            .map((run) => run.runId)
            .join(', ')}); use --resume instead of --new-run`
        );
      }
      runId = randomUUID();
      manifest = executionManifest(runId, plan);
      // Record the immutable identity BEFORE the first mutation.
      await journal.append({
        type: 'manifest',
        runId: manifest.runId,
        manifestDigest: manifest.manifestDigest,
        entries: manifest.entries,
        at: new Date().toISOString(),
      });
    }

    const deps: BackfillExecutorDeps = {
      storage: client.storage.from(
        BACKFILL_PLAN_BUCKET
      ) as unknown as BodyContentStorageApi,
      cas: createBackfillCasApi(client as unknown as CasRpcClient),
      readCommittedBody: readers.readBody,
      readCommittedPointer: readers.readPointer,
      invalidate: (invalidation) => invalidatePublicContent(invalidation),
      journal,
      now: () => new Date(),
      newRunId: () => runId,
    };

    // On a resume, first settle the invalidations an interrupted run left
    // pending: no upload, no pointer write, only the signed event.
    const retries = resumed
      ? await retryPendingRevalidations(
          deps,
          audit.runs
            .filter((run) => run.runId === runId)
            .flatMap((run) => run.pendingRevalidations)
        )
      : [];

    const report = await executeBackfill(deps, workPlan, {
      runId,
      revalidate: true,
      failFast: true,
      manifest,
    });
    console.log(
      JSON.stringify(
        {
          command: 'storage:content:dev:backfill:exec',
          mode: 'apply',
          resumed,
          journalPath: journalPathEnv,
          retriedInvalidations: retries,
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

#!/usr/bin/env node
/**
 * Production Markdown garbage collector CLI (legacy-retirement §4).
 *
 *   bun run storage:content:prod:gc                     # read-only report
 *   bun run storage:content:prod:gc --retention-days=30 # read-only, 30d grace
 *   bun run storage:content:prod:gc --json              # report only, no prose
 *   CMS_PROD_STORAGE_GC_APPLY_ACK=yes-delete-production-content \
 *     bun run storage:content:prod:gc --apply           # delete the candidates
 *
 * It collects the immutable Markdown objects of `website-content` that no
 * production post row references any more: versions superseded by a newer
 * upload once their grace period has elapsed, and the orphans of deleted posts.
 *
 * Silence is read-only. A deletion needs BOTH `--apply` and the production
 * acknowledgement, the environment gate runs before the first client is built,
 * and only canonical `<kind>/<postId>/<locale>/<sha256>.md` objects absent from
 * the freshly re-read pointers are ever submitted to the Storage API. Nothing
 * here can address `website-content-dev`, `website` or `website-dev`, and the
 * delete path never touches SQL.
 *
 * `runProdStorageGcCli` is exported with every dependency injected so the whole
 * gate/plan/delete sequence is unit-testable without a network; the entry point
 * below is guarded by a direct-invocation check and only prints.
 *
 * Exit codes (the convention documented for the other maintenance commands):
 *   0  settled (clean dry run, or every candidate deleted)
 *   1  attention required (candidates await an apply run, or a delete failed)
 *   2  invalid usage
 *   3  environment/project gate failure (before the first read)
 *   4  read or execution failure
 *   5  refused by the apply gate (the production acknowledgement is missing)
 */
import { createClient } from '@supabase/supabase-js';
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import {
  createPostBodyReader,
  type PostBodyReader,
} from '@/libs/cms/storage/backfillPlan';
import { CMS_PROD_STORAGE_BUCKET } from '@/libs/cms/storage/bucket';
import {
  ASSET_BUCKET_DEV,
  CONTENT_BUCKET_DEV,
} from '@/libs/cms/storage/contentBucket';
import {
  assertContentGcAllowed,
  assertContentGcApplyAcknowledged,
  CONTENT_GC_COMMAND,
  type ContentGcEnv,
  type ContentGcReport,
  type ContentObjectApi,
  contentGcExitCode,
  GC_BUCKET,
  GC_POINTER_COLUMNS,
  GC_SCHEMA,
  humanContentGcLines,
  PROD_STORAGE_GC_USAGE,
  parseContentGcArgs,
  readContentGcApplyAck,
  runContentGc,
} from '@/libs/cms/storage/contentGarbageCollector';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { isDirectInvocation } from '@/utils/cms/prodStorageSetup';

/**
 * The production content bucket, pinned as a literal as well as derived from
 * the shared descriptor. `prodStorageGc.test.ts` pins both values and that this
 * is neither the dev content bucket nor either asset bucket, so the facade this
 * command builds can never address a bucket the collector must not touch.
 */
export const PROD_STORAGE_GC_BUCKET = 'website-content';

/** Buckets a garbage-collection run must never address. */
export const FORBIDDEN_GC_BUCKETS: readonly string[] = [
  CONTENT_BUCKET_DEV,
  ASSET_BUCKET_DEV,
  CMS_PROD_STORAGE_BUCKET,
];

export type ProdStorageGcCliDeps = {
  argv: string[];
  observed: ContentGcEnv;
  env: Readonly<Record<string, string | undefined>>;
  /** Storage facade factory: called only after the environment gate. */
  openStorage(): ContentObjectApi;
  /** Read-only row reader factory: called only after the environment gate. */
  openReader(): PostBodyReader;
  now?(): number;
};

export type ProdStorageGcCliOutcome = {
  exitCode: number;
  /** The JSON audit report; null for a refusal, help or failure. */
  report: ContentGcReport | null;
  /** The human-readable audit lines; empty for `--json` and for refusals. */
  lines: string[];
  /** Set when the run refused or failed; printed on stderr. */
  error: string | null;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The whole command body, with every dependency injected. Gate order is
 * explicit: usage -> environment -> apply acknowledgement -> read. Both client
 * factories are called only after the gates, so a misconfigured process never
 * builds a client at all.
 */
export async function runProdStorageGcCli(
  deps: ProdStorageGcCliDeps
): Promise<ProdStorageGcCliOutcome> {
  const args = parseContentGcArgs(deps.argv);
  if (args.mode === 'invalid') {
    return {
      exitCode: 2,
      report: null,
      lines: [],
      error: `${args.error}\n${PROD_STORAGE_GC_USAGE}`,
    };
  }
  if (args.mode === 'help') {
    return {
      exitCode: 0,
      report: null,
      lines: [PROD_STORAGE_GC_USAGE],
      error: null,
    };
  }

  try {
    assertContentGcAllowed(deps.observed);
  } catch (error) {
    return { exitCode: 3, report: null, lines: [], error: messageOf(error) };
  }

  const ack = readContentGcApplyAck(deps.env);
  if (args.mode === 'apply') {
    try {
      assertContentGcApplyAcknowledged(ack);
    } catch (error) {
      return { exitCode: 5, report: null, lines: [], error: messageOf(error) };
    }
  }

  try {
    const { report } = await runContentGc({
      env: deps.observed,
      storage: deps.openStorage(),
      reader: deps.openReader(),
      options: {
        apply: args.mode === 'apply',
        ack,
        retentionDays: args.retentionDays,
      },
      now: deps.now,
    });
    return {
      exitCode: contentGcExitCode(report),
      report,
      lines: args.json ? [] : humanContentGcLines(report),
      error: null,
    };
  } catch (error) {
    return { exitCode: 4, report: null, lines: [], error: messageOf(error) };
  }
}

/** Builds the production Storage facade the collector deletes through. */
function openProductionStorage(): ContentObjectApi {
  if (PROD_STORAGE_GC_BUCKET !== GC_BUCKET) {
    throw new Error(
      `[${CONTENT_GC_COMMAND}] refusing to run: storage facade targets '${PROD_STORAGE_GC_BUCKET}' but the collector owns '${GC_BUCKET}'`
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServerSecret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabase.storage.from(PROD_STORAGE_GC_BUCKET);
}

async function main(): Promise<void> {
  const outcome = await runProdStorageGcCli({
    argv: process.argv.slice(2),
    observed: {
      appEnv,
      schema: supabaseSchema,
      supabaseUrl,
      hasServerSecret: supabaseServerSecret !== '',
    },
    env: process.env,
    openStorage: openProductionStorage,
    openReader: () =>
      createPostBodyReader(getCmsAdminClient(), {
        columns: GC_POINTER_COLUMNS,
        schema: GC_SCHEMA,
        label: CONTENT_GC_COMMAND,
      }),
  });

  if (outcome.report) console.log(JSON.stringify(outcome.report, null, 2));
  for (const line of outcome.lines) console.log(line);
  if (outcome.error) console.error(`${CONTENT_GC_COMMAND}: ${outcome.error}`);
  process.exit(outcome.exitCode);
}

if (isDirectInvocation(process.argv, import.meta.url)) {
  await main();
}

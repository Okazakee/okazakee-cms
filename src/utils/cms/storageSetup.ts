#!/usr/bin/env node
/**
 * Dev-only maintenance command: provision the private Markdown body bucket.
 *
 *   bun run storage:content:dev:setup
 *
 * Idempotent. Creates `website-content-dev` (private, 1 MiB, text/markdown only)
 * when absent, converges it when it has drifted, and reports:
 *
 *   created | already-correct | updated
 *
 * Fail-closed: the environment gate runs before the Storage client is used, and
 * refuses unless the environment resolves to the dev database contract
 * (`NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging`, not production), so a missing
 * or misspelled value can never target production. It only ever operates on
 * `website-content-dev` and never deletes or recreates a bucket or moves
 * objects.
 *
 * Bucket metadata is API-managed (current Supabase Storage guidance), which is
 * why this is a server-side command rather than a `storage.buckets` SQL insert.
 */
import { createClient } from '@supabase/supabase-js';
import {
  appEnv,
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';
import {
  runContentBucketSetup,
  type StorageBucketApi,
} from '@/libs/cms/storage/contentBucket';

async function main(): Promise<void> {
  const supabase = createClient(supabaseUrl, supabaseServerSecret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The Storage API surface used here is narrowed to the three calls the setup
  // needs; the client satisfies it structurally. The environment gate inside
  // runContentBucketSetup runs before any bucket call.
  const result = await runContentBucketSetup(
    {
      appEnv,
      schema: supabaseSchema,
      supabaseUrl,
      hasServerSecret: supabaseServerSecret !== '',
    },
    supabase.storage as StorageBucketApi
  );

  console.log(
    JSON.stringify(
      {
        command: 'storage:content:dev:setup',
        schema: supabaseSchema,
        appEnv,
        ...result,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`storage:content:dev:setup failed: ${message}`);
  process.exit(1);
});

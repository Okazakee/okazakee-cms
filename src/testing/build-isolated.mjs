import { cp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIsolatedEnv } from './lib/env.mjs';
import { prepareOverlay } from './lib/overlay.mjs';
import { createPaths, readSupabaseStatus } from './lib/supabase.mjs';
import { run } from './lib/util.mjs';
import { assertFixtureWorkdir } from './lib/workdir.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const paths = createPaths(
  process.env.ISOLATED_WORKDIR || '/tmp/okazakee-cms-isolated'
);
await assertFixtureWorkdir(paths.projectRoot, repoRoot);
const runtime = JSON.parse(await readFile(paths.runtimeFile, 'utf8'));
const status = await readSupabaseStatus({ paths });
if (!status) throw new Error('Start the isolated fixture before building');
const overlayDir = path.join(paths.projectRoot, 'build-app');
await prepareOverlay({ repoRoot, paths: { ...paths, overlayDir } });
// Turbopack requires dependencies inside its project root. Copy rather than
// symlink or hard-link them: a build cannot mutate the repository's installs.
await rm(path.join(overlayDir, 'node_modules'));
await cp(
  path.join(repoRoot, 'node_modules'),
  path.join(overlayDir, 'node_modules'),
  { recursive: true, verbatimSymlinks: true }
);
const env = buildIsolatedEnv({
  supabaseUrl: status.apiUrl,
  publishableKey: status.publishableKey,
  secretKey: status.secretKey,
  revalidationUrl: runtime.revalidationUrl,
  revalidationSecret: runtime.revalidationSecret,
  nextUrl: runtime.nextUrl,
});
// This is the normal canonical production build, with only the DATA endpoints
// set to the disposable fixture. There is no repository .env.local in the copy.
const result = await run('bun', ['run', 'build'], {
  cwd: overlayDir,
  env: { ...env, NODE_ENV: 'production' },
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;

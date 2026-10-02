#!/usr/bin/env node
import { existsSync } from 'node:fs';
/**
 * Isolated CMS integration/browser fixture — single entry point.
 *
 *   node src/testing/start-isolated.mjs            start everything
 *   node src/testing/start-isolated.mjs --status   show running fixtures
 *   node src/testing/start-isolated.mjs --stop     stop everything
 *
 * Starts a disposable loopback-only stack:
 *   - Supabase CLI project in the fixture workdir (/tmp by default)
 *   - inferred baseline schema + the repository migrations + seeded content
 *   - real GoTrue admin/editor/outsider identities and browser session cookies
 *   - Next.js dev server on the app overlay (loopback image support)
 *   - a standalone fixture server: signed revalidation receiver + control API
 *
 * It never reads .env.local, never links a remote project, and refuses any
 * non-loopback Supabase / revalidation / site URL.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureTestUsers,
  mintSessionCookies,
  writeSessionFile,
} from './lib/auth.mjs';
import {
  defaultFixturePort,
  defaultNextPort,
  defaultSupabaseApiPort,
  revalidationPath,
  testAccounts,
} from './lib/config.mjs';
import { clearWrites, readWrites, snapshotTables } from './lib/db.mjs';
import { buildIsolatedEnv, isLoopbackUrl } from './lib/env.mjs';
import { createFixtureServer } from './lib/fixtureServer.mjs';
import { assertLoopbackBindings } from './lib/network.mjs';
import { startNextServer, stopNextServer } from './lib/next.mjs';
import { prepareOverlay } from './lib/overlay.mjs';
import { seedStorage } from './lib/storageSeed.mjs';
import {
  createPaths,
  isSupabaseHealthy,
  prepareSupabaseProject,
  readSupabaseStatus,
  resetSupabase,
  startSupabase,
  stopSupabase,
  supabaseEnv,
} from './lib/supabase.mjs';
import { makeLogger, randomSecret, run, sleep } from './lib/util.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const logger = makeLogger('main');

function readOptions() {
  const args = process.argv.slice(2);
  const workdir = process.env.ISOLATED_WORKDIR ?? '/tmp/okazakee-cms-isolated';
  const apiPort = Number(
    process.env.ISOLATED_SUPABASE_API_PORT ?? defaultSupabaseApiPort
  );
  const nextPort = Number(process.env.ISOLATED_NEXT_PORT ?? defaultNextPort);
  const fixturePort = Number(
    process.env.ISOLATED_FIXTURE_PORT ?? defaultFixturePort
  );
  return {
    mode: args.includes('--stop')
      ? 'stop'
      : args.includes('--status')
        ? 'status'
        : args.includes('--help') || args.includes('-h')
          ? 'help'
          : 'start',
    workdir,
    apiPort,
    nextPort,
    fixturePort,
    keepSupabase: process.env.ISOLATED_KEEP_SUPABASE === '1',
  };
}

function buildContext(options) {
  const paths = createPaths(options.workdir);
  const supabaseUrl = `http://127.0.0.1:${options.apiPort}`;
  const nextUrl = `http://localhost:${options.nextPort}`;
  const fixtureUrl = `http://localhost:${options.fixturePort}`;
  const revalidationUrl = `${fixtureUrl}${revalidationPath}`;
  return {
    repoRoot,
    paths,
    apiPort: options.apiPort,
    nextPort: options.nextPort,
    fixturePort: options.fixturePort,
    supabaseUrl,
    nextUrl,
    fixtureUrl,
    revalidationUrl,
    keepSupabase: options.keepSupabase,
    logger,
  };
}

function assertLoopbackTopology(ctx) {
  for (const [name, value] of [
    ['supabaseUrl', ctx.supabaseUrl],
    ['nextUrl', ctx.nextUrl],
    ['fixtureUrl', ctx.fixtureUrl],
    ['revalidationUrl', ctx.revalidationUrl],
  ]) {
    if (!isLoopbackUrl(value)) {
      throw new Error(`[isolated] refusing non-loopback ${name}: ${value}`);
    }
  }
}

async function start(options) {
  const ctx = buildContext(options);
  assertLoopbackTopology(ctx);
  await mkdir(ctx.paths.projectRoot, { recursive: true });

  logger.info(`workdir ${ctx.paths.projectRoot}`);
  await prepareSupabaseProject(ctx);
  if (await isSupabaseHealthy(ctx)) {
    await assertLoopbackBindings(ctx.paths.projectRoot);
    logger.info('local Supabase is up; resetting to a known state...');
    await resetSupabase(ctx);
  } else {
    // Containers may be half-up from an interrupted run; recreate cleanly.
    if (await readSupabaseStatus(ctx)) {
      logger.info('local Supabase unhealthy; recreating containers...');
      await stopSupabase(ctx);
    }
    logger.info('starting local Supabase (first run downloads images)...');
    await startSupabase(ctx, { onLog: () => {} });
  }

  let status = await readSupabaseStatus(ctx);
  if (!status) throw new Error('could not read local Supabase status');
  await ensureTestUsers(status, logger);
  await seedStorage(status, logger);

  logger.info('preparing Next overlay...');
  await prepareOverlay(ctx);

  const revalidationSecret = randomSecret(32);
  const env = buildIsolatedEnv({
    supabaseUrl: status.apiUrl,
    publishableKey: status.publishableKey,
    secretKey: status.secretKey,
    revalidationUrl: ctx.revalidationUrl,
    revalidationSecret,
    nextUrl: ctx.nextUrl,
  });
  ctx.revalidationSecret = revalidationSecret;

  const fixture = createFixtureServer({
    logger,
    secret: revalidationSecret,
    fixturePort: ctx.fixturePort,
    nextUrl: ctx.nextUrl,
    fixtureUrl: ctx.fixtureUrl,
    supabaseUrl: ctx.supabaseUrl,
    accounts: testAccounts,
    mintSession: async (account) => {
      const result = await mintSessionCookies(status, account);
      await writeSessionFile(
        ctx.paths.sessionsDir,
        account.key,
        result.cookies
      );
      return result;
    },
    snapshot: (tables) => snapshotTables(status, tables),
    writes: (limit) => readWrites(status, limit),
    clearWrites: () => clearWrites(status),
    reset: async () => {
      logger.info('reset requested via fixture control API');
      await resetSupabase(ctx);
      const fresh = await readSupabaseStatus(ctx);
      if (!fresh) throw new Error('Supabase unavailable after reset');
      status = fresh;
      await ensureTestUsers(fresh, logger);
      await seedStorage(fresh, logger);
    },
  });
  await fixture.start();
  logger.info(`fixture/revalidation server on ${ctx.fixtureUrl}`);

  logger.info(`starting Next dev on ${ctx.nextUrl} (webpack)...`);
  const nextChild = await startNextServer(ctx, env, {
    onLog: (text) => {
      if (/Ready in|error|Error/.test(text)) {
        process.stdout.write(`[isolated:next] ${text}`);
      }
    },
  });

  await writeRuntime(ctx, {
    nextPid: nextChild.pid,
    startedAt: new Date().toISOString(),
  });

  printReady(ctx, env);

  const shutdown = async () => {
    logger.info('shutting down...');
    stopNextServer(nextChild);
    await fixture.stop();
    if (!ctx.keepSupabase) {
      const result = await stopSupabase(ctx);
      if (result.code !== 0) {
        logger.warn('supabase stop reported an issue');
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function writeRuntime(ctx, extra) {
  const runtime = {
    ...extra,
    workdir: ctx.paths.projectRoot,
    overlayDir: ctx.paths.overlayDir,
    sessionsDir: ctx.paths.sessionsDir,
    supabaseUrl: ctx.supabaseUrl,
    nextUrl: ctx.nextUrl,
    fixtureUrl: ctx.fixtureUrl,
    revalidationUrl: ctx.revalidationUrl,
    revalidationSecret: ctx.revalidationSecret,
    apiPort: ctx.apiPort,
    nextPort: ctx.nextPort,
    fixturePort: ctx.fixturePort,
  };
  await writeFile(ctx.paths.runtimeFile, JSON.stringify(runtime, null, 2), {
    mode: 0o600,
  });
  return runtime;
}

function printReady(ctx, env) {
  const lines = [
    '',
    '──────────────────────────────────────────────────────────────',
    ' isolated CMS fixture ready (loopback only, disposable)',
    '──────────────────────────────────────────────────────────────',
    ` CMS (Next)        ${ctx.nextUrl}`,
    ` Supabase API     ${ctx.supabaseUrl}`,
    ` Fixture control  ${ctx.fixtureUrl}/__fixture/runtime`,
    ` Revalidation     ${ctx.revalidationUrl}`,
    '',
    ' Seed a browser session (no tokens are printed):',
    `   open ${ctx.fixtureUrl}/__fixture/session?user=admin`,
    `   open ${ctx.fixtureUrl}/__fixture/session?user=editor`,
    `   open ${ctx.fixtureUrl}/__fixture/session?user=outsider`,
    ` Session files (mode 0600): ${ctx.paths.sessionsDir}`,
    '',
    ` APP_ENV=${env.APP_ENV}  CMS_ISOLATED_TEST=${env.CMS_ISOLATED_TEST}`,
    '',
    ' Control API:',
    '   GET    /__fixture/events      observed revalidation events',
    '   POST   /__fixture/fail        {"mode":"http-500|timeout|reject|none"}',
    '   GET    /__fixture/snapshot    content snapshot',
    '   GET    /__fixture/writes      observed DB writes',
    '   DELETE /__fixture/writes',
    '   POST   /__fixture/reset       reset DB + reseed + clear events',
    '',
    ' Press Ctrl+C to stop.',
    '──────────────────────────────────────────────────────────────',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function status() {
  const options = readOptions();
  const ctx = buildContext(options);
  if (!existsSync(ctx.paths.runtimeFile)) {
    logger.warn('no runtime.json found; fixture is not running');
    return;
  }
  const runtime = JSON.parse(await readFile(ctx.paths.runtimeFile, 'utf8'));
  const checks = [];
  for (const [name, url] of [
    ['next', `${runtime.nextUrl}/login`],
    ['fixture', `${runtime.fixtureUrl}/health`],
  ]) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
      });
      checks.push(`${name}: ${response.status}`);
    } catch {
      checks.push(`${name}: unreachable`);
    }
  }
  logger.info(`runtime: ${runtime.nextUrl}, ${runtime.fixtureUrl}`);
  logger.info(`checks: ${checks.join(', ')}`);
}

async function stop() {
  const options = readOptions();
  const ctx = buildContext(options);
  if (existsSync(ctx.paths.runtimeFile)) {
    const runtime = JSON.parse(await readFile(ctx.paths.runtimeFile, 'utf8'));
    for (const pid of [runtime.nextPid]) {
      if (Number.isInteger(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    await sleep(500);
  }
  const result = await run('supabase', ['stop', '--no-backup'], {
    cwd: ctx.paths.projectRoot,
    env: supabaseEnv(),
  });
  if (result.code === 0) {
    logger.info('local Supabase stopped');
  } else {
    logger.warn(`supabase stop: ${result.stderr || result.stdout}`);
  }
}

function help() {
  process.stdout.write(
    [
      'Usage: node src/testing/start-isolated.mjs [--status|--stop|--help]',
      '',
      'Env: ISOLATED_WORKDIR, ISOLATED_SUPABASE_API_PORT,',
      '     ISOLATED_NEXT_PORT, ISOLATED_FIXTURE_PORT,',
      '     ISOLATED_KEEP_SUPABASE=1',
      '',
    ].join('\n')
  );
}

const options = readOptions();
try {
  if (options.mode === 'help') {
    help();
  } else if (options.mode === 'status') {
    await status();
  } else if (options.mode === 'stop') {
    await stop();
  } else {
    await start(options);
  }
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

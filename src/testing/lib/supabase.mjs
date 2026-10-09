/**
 * Isolated fixture — disposable local Supabase project management.
 *
 * Creates a throwaway Supabase CLI project under the fixture workdir (never
 * the repository, never a linked project), installs the inferred baseline plus
 * the repository's own migrations, and drives start / reset / stop.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertLoopbackBindings,
  ensureLoopbackNetwork,
  fixtureNetworkName,
} from './network.mjs';
import { run, sleep } from './util.mjs';
import { assertFixtureWorkdir } from './workdir.mjs';

const SUPABASE_BIN = process.env.SUPABASE_BIN ?? 'supabase';

/**
 * CLI telemetry is disabled: with no outbound network the PostHog flush can
 * time out at process exit and turn a successful command into exit code 1.
 */
export function supabaseEnv(extra = {}) {
  return {
    ...process.env,
    DO_NOT_TRACK: '1',
    SUPABASE_TELEMETRY_DISABLED: '1',
    ...extra,
  };
}

export function createPaths(baseWorkdir) {
  const projectRoot = baseWorkdir;
  const supabaseDir = path.join(projectRoot, 'supabase');
  return {
    projectRoot,
    supabaseDir,
    migrationsDir: path.join(supabaseDir, 'migrations'),
    configFile: path.join(supabaseDir, 'config.toml'),
    seedFile: path.join(supabaseDir, 'seed.sql'),
    overlayDir: path.join(projectRoot, 'app'),
    sessionsDir: path.join(projectRoot, 'sessions'),
    runtimeFile: path.join(projectRoot, 'runtime.json'),
    logDir: path.join(projectRoot, 'logs'),
  };
}

async function supabase(args, ctx) {
  return run(
    SUPABASE_BIN,
    [...args, '--network-id', fixtureNetworkName(ctx.paths.projectRoot)],
    {
      cwd: ctx.paths.projectRoot,
      env: supabaseEnv(),
    }
  );
}

/**
 * Prepares the /tmp Supabase project: init, port/redirect patching, baseline
 * schema as the first migration, the repository migrations, and the seed.
 */
export async function prepareSupabaseProject(ctx) {
  const { paths, repoRoot, apiPort, nextUrl } = ctx;
  await assertFixtureWorkdir(paths.projectRoot, repoRoot);
  await mkdir(paths.projectRoot, { recursive: true });

  if (!existsSync(paths.configFile)) {
    const init = await supabase(['init'], ctx);
    // The CLI can exit non-zero on a telemetry shutdown timeout even though
    // config.toml was written; only fail if the file is genuinely missing.
    if (init.code !== 0 && !existsSync(paths.configFile)) {
      throw new Error(
        `supabase init failed (${init.code}): ${init.stderr || init.stdout}`
      );
    }
  }

  const original = await readFile(paths.configFile, 'utf8');
  const patched = patchConfigToml(original, { apiPort, nextUrl });
  if (patched !== original) {
    await writeFile(paths.configFile, patched, 'utf8');
  }

  await rm(paths.migrationsDir, { recursive: true, force: true });
  await mkdir(paths.migrationsDir, { recursive: true });

  const testingSqlDir = path.join(repoRoot, 'src', 'testing', 'sql');
  const baseline = path.join(testingSqlDir, '0001_baseline_schema.sql');
  const seedSource = path.join(testingSqlDir, '0002_seed_content.sql');
  await cp(
    baseline,
    path.join(paths.migrationsDir, '0001_baseline_schema.sql')
  );
  await cp(seedSource, paths.seedFile);

  const repoMigrations = path.join(repoRoot, 'supabase', 'migrations');
  // Dev-clone migrations must never be replayed into this isolated public
  // baseline: their schema is deliberately absent here.
  const entries = (await readdir(repoMigrations)).filter(
    (name) =>
      name.endsWith('.sql') &&
      !name.endsWith('_dev_staging.sql') &&
      name !== '20261005234758_create_cms_migration_audit_ledger.sql'
  );
  entries.sort();
  for (const name of entries) {
    await cp(
      path.join(repoMigrations, name),
      path.join(paths.migrationsDir, name)
    );
  }
  return entries.length;
}

export async function startSupabase(ctx, { onLog } = {}) {
  await ensureLoopbackNetwork(ctx.paths.projectRoot);
  const result = await supabase(['start'], ctx);
  if (onLog && result.stdout) onLog(result.stdout);
  if (result.code !== 0) {
    // The CLI can report a container-restart race (e.g. a transient 502) even
    // though the stack comes up moments later. Only fail if it stays down.
    const status = await waitForSupabase(ctx, { timeoutMs: 90000 }).catch(
      () => null
    );
    if (!status) {
      throw new Error(
        `supabase start failed (${result.code}): ${result.stderr || result.stdout}`
      );
    }
  }
  await assertLoopbackBindings(ctx.paths.projectRoot);
  return waitForSupabase(ctx);
}

export async function resetSupabase(ctx) {
  const result = await supabase(['db', 'reset'], ctx);
  if (result.code !== 0) {
    // Migrations + seed can complete and then the CLI fails on a transient
    // upstream 502 while restarting containers. Verify the seed is actually
    // present before declaring failure.
    const status = await waitForSupabase(ctx, { timeoutMs: 90000 }).catch(
      () => null
    );
    if (status && (await isSeeded(status))) {
      return status;
    }
    throw new Error(
      `supabase db reset failed (${result.code}): ${
        result.stderr || result.stdout
      }`
    );
  }
  return readSupabaseStatus(ctx);
}

async function isSeeded(status) {
  try {
    const response = await fetch(
      `${status.apiUrl}/rest/v1/i18n_translations?select=language`,
      {
        headers: {
          apikey: status.publishableKey,
          authorization: `Bearer ${status.publishableKey}`,
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export async function stopSupabase(ctx) {
  return supabase(['stop', '--no-backup'], ctx);
}

export async function isSupabaseHealthy(ctx) {
  const status = await readSupabaseStatus(ctx);
  if (!status?.apiUrl) return false;
  return isHealthy(status.apiUrl);
}

export async function readSupabaseStatus(ctx) {
  const result = await supabase(['status', '-o', 'json'], ctx);
  if (result.code !== 0) return null;
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(result.stdout.slice(start, end + 1));
    return {
      apiUrl: parsed.API_URL,
      restUrl: parsed.REST_URL,
      publishableKey: parsed.PUBLISHABLE_KEY ?? parsed.ANON_KEY,
      secretKey: parsed.SECRET_KEY ?? parsed.SERVICE_ROLE_KEY,
      serviceRoleKey: parsed.SERVICE_ROLE_KEY,
      anonKey: parsed.ANON_KEY,
      dbUrl: parsed.DB_URL,
      jwtSecret: parsed.JWT_SECRET,
    };
  } catch {
    return null;
  }
}

export async function waitForSupabase(ctx, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readSupabaseStatus(ctx);
    if (status?.apiUrl && (await isHealthy(status.apiUrl))) {
      return status;
    }
    await sleep(1500);
  }
  throw new Error('local Supabase did not become healthy in time');
}

async function isHealthy(apiUrl) {
  try {
    const response = await fetch(`${apiUrl}/auth/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Rewrites only the ports and the auth redirect/site settings. The rest of the
 * CLI-generated config is preserved so the fixture tracks supabase defaults.
 */
export function patchConfigToml(content, { apiPort, nextUrl }) {
  const lines = content.split('\n');
  const sectionPorts = {
    '[api]': apiPort,
    '[db]': apiPort + 1,
    '[studio]': apiPort + 2,
    '[inbucket]': apiPort + 3,
  };
  let section = null;
  let portPatched = false;
  const nextOrigin = new URL(nextUrl).origin;
  const loopbackOrigin = nextOrigin.replace('127.0.0.1', 'localhost');
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
      section = trimmed;
      portPatched = false;
      return line;
    }
    if (
      !portPatched &&
      section &&
      section in sectionPorts &&
      /^\s*port\s*=/.test(line)
    ) {
      portPatched = true;
      return `port = ${sectionPorts[section]}`;
    }
    if (/^\s*site_url\s*=/.test(line)) {
      return `site_url = "${loopbackOrigin}"`;
    }
    if (/^\s*additional_redirect_urls\s*=/.test(line)) {
      return `additional_redirect_urls = ["${loopbackOrigin}", "${nextOrigin}", "${nextOrigin}/**"]`;
    }
    return line;
  });
  return out.join('\n');
}

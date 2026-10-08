/**
 * Isolated fixture — Next.js app overlay.
 *
 * The fixture never edits the repository. Instead it snapshots the real app
 * into a /tmp overlay and adds a thin next.config wrapper that:
 *   - allows http loopback image remote patterns, ONLY when
 *     CMS_ISOLATED_TEST=1 and NODE_ENV !== 'production';
 *   - allows the loopback Storage host through next/image's SSRF guard.
 *
 * That wrapper contains no authentication or authorization changes: the real
 * proxy/middleware, allowlist RPC and Server Actions run unchanged.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFixtureWorkdir } from './workdir.mjs';

const OVERLAY_CONFIG = `import base from './next.config.base';

const isolated =
  process.env.CMS_ISOLATED_TEST === '1' &&
  process.env.NODE_ENV !== 'production';

const config = isolated
  ? {
      ...base,
      // Dependencies are symlinked from the checkout, outside the /tmp app.
      turbopack: { ...base.turbopack, root: __ISOLATED_ROOT__ },
      images: {
        ...base.images,
        // Loopback Storage only; gated by the isolated-test flag above.
        dangerouslyAllowLocalIP: true,
        remotePatterns: [
          ...((base.images?.remotePatterns as unknown[]) ?? []),
          {
            protocol: 'http',
            hostname: '127.0.0.1',
            port: '54321',
            pathname: '/**',
          },
          {
            protocol: 'http',
            hostname: 'localhost',
            port: '54321',
            pathname: '/**',
          },
        ],
      },
    }
  : base;

export default config;
`;

export async function prepareOverlay(ctx) {
  const { paths, repoRoot } = ctx;
  const target = paths.overlayDir;
  await assertFixtureWorkdir(target, repoRoot);

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  await cp(path.join(repoRoot, 'src'), path.join(target, 'src'), {
    recursive: true,
  });
  // The fixture owns its environment; never inherit a repo .env.local.
  await rm(path.join(target, '.env.local'), { force: true });

  await cp(
    path.join(repoRoot, 'next.config.ts'),
    path.join(target, 'next.config.base.ts')
  );
  await writeFile(
    path.join(target, 'next.config.ts'),
    OVERLAY_CONFIG.replace(
      '__ISOLATED_ROOT__',
      JSON.stringify(path.parse(repoRoot).root)
    ),
    'utf8'
  );

  for (const file of [
    'tsconfig.json',
    'postcss.config.mjs',
    'tailwind.config.ts',
    'package.json',
  ]) {
    if (existsSync(path.join(repoRoot, file))) {
      await cp(path.join(repoRoot, file), path.join(target, file));
    }
  }

  const nodeModules = path.join(target, 'node_modules');
  if (!existsSync(nodeModules)) {
    await symlink(path.join(repoRoot, 'node_modules'), nodeModules);
  }

  return target;
}

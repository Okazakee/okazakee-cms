/**
 * Isolated fixture — Next.js dev server lifecycle (overlay only).
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sleep, spawnLongRunning } from './util.mjs';

export async function startNextServer(ctx, env, { onLog } = {}) {
  const { paths } = ctx;
  await mkdir(paths.logDir, { recursive: true });
  const logStream = createWriteStream(path.join(paths.logDir, 'next.log'), {
    flags: 'w',
  });

  const child = spawnLongRunning(
    path.join(paths.overlayDir, 'node_modules', '.bin', 'next'),
    ['dev', '--webpack', '--hostname', '127.0.0.1', '-p', String(ctx.nextPort)],
    { cwd: paths.overlayDir, env }
  );

  const pipe = (stream) => {
    stream?.on('data', (chunk) => {
      const text = chunk.toString();
      logStream.write(text);
      if (onLog) onLog(text);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    logStream.end();
    if (code && code !== 0) {
      ctx.logger.warn(`Next dev exited with code ${code}`);
    }
  });

  await waitForNext(ctx.nextUrl, child);
  return child;
}

export async function waitForNext(nextUrl, child, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Next dev exited early (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${nextUrl}/login`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(4000),
      });
      if (response.status < 500) return;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error('Next dev did not become ready in time');
}

export function stopNextServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 5000).unref();
}

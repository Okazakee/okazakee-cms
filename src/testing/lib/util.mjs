/** Small shared helpers for the isolated fixture (no app imports). */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function makeLogger(scope) {
  const prefix = `[isolated:${scope}]`;
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a command, returning { code, stdout, stderr }. Never rejects. */
export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Spawns a long-running process, inheriting the wrapper's stdio pipes. */
export function spawnLongRunning(command, args, options = {}) {
  return spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

/** Small deterministic JSON HTTP helper for the fixture server. */
export async function readJsonBody(request, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

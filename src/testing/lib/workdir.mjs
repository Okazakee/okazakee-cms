import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function resolvedPath(directory) {
  const suffix = [];
  let current = path.resolve(directory);
  for (;;) {
    try {
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

// Destructive fixture resets are allowed only in a disposable temp subtree,
// never in the repository (including symlinks or an ancestor of the repo).
export async function assertFixtureWorkdir(directory, repoRoot) {
  const target = await resolvedPath(directory);
  const temporary = await realpath(tmpdir());
  const repository = await realpath(repoRoot);
  if (
    target === temporary ||
    !contains(temporary, target) ||
    contains(repository, target) ||
    contains(target, repository)
  ) {
    throw new Error(
      '[isolated] workdir must be a disposable temp directory outside the repository'
    );
  }
}

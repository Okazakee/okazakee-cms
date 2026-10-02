import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFixtureWorkdir } from './workdir.mjs';

describe('fixture destructive-path guard', () => {
  it('refuses repository paths, ancestors and the temp root itself', async () => {
    const repo = process.cwd();
    for (const target of [
      repo,
      path.join(repo, 'supabase'),
      path.dirname(repo),
      tmpdir(),
      '/',
    ]) {
      await expect(assertFixtureWorkdir(target, repo)).rejects.toThrow(
        /disposable temp/
      );
    }
  });

  it('allows a new disposable temp subtree but refuses a symlink into the repository', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'cms-workdir-test-'));
    try {
      await expect(
        assertFixtureWorkdir(path.join(folder, 'new'), process.cwd())
      ).resolves.toBeUndefined();
      await symlink(process.cwd(), path.join(folder, 'repo'));
      await expect(
        assertFixtureWorkdir(
          path.join(folder, 'repo', 'supabase'),
          process.cwd()
        )
      ).rejects.toThrow(/disposable temp/);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

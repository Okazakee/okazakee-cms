import { describe, expect, it } from 'vitest';
import {
  batchFailureSummary,
  batchHadCommits,
  batchSucceeded,
  emptyBatchEvidence,
  markCreated,
  markDeleted,
  markFailed,
  markReordered,
  markUpdated,
  normalizeTempId,
} from './batchEvidence';

describe('normalizeTempId', () => {
  it('keeps a non-empty client temp id verbatim', () => {
    expect(normalizeTempId('client-1', 'blog', 0)).toBe('client-1');
  });

  it('assigns a deterministic fallback for missing/empty ids', () => {
    expect(normalizeTempId(undefined, 'blog', 3)).toBe('temp:blog:3');
    expect(normalizeTempId('', 'blog', 3)).toBe('temp:blog:3');
    expect(normalizeTempId('   ', 'blog', 3)).toBe('temp:blog:3');
    expect(normalizeTempId(42, 'blog', 3)).toBe('temp:blog:3');
  });
});

describe('batch evidence bookkeeping', () => {
  it('records committed ids and failures independently', () => {
    const evidence = emptyBatchEvidence();
    markCreated(evidence, 'c1', 101);
    markCreated(evidence, 'c2', 102);
    markUpdated(evidence, 200);
    markDeleted(evidence, 300);
    markReordered(evidence, 400);
    markFailed(evidence, { kind: 'create', tempId: 'c3', error: 'boom' });

    expect(evidence.created).toEqual(['c1', 'c2']);
    expect(evidence.createdIds).toEqual({ c1: 101, c2: 102 });
    expect(evidence.updated).toEqual([200]);
    expect(evidence.deleted).toEqual([300]);
    expect(evidence.reordered).toEqual([400]);
    expect(evidence.failed).toHaveLength(1);
  });

  it('distinguishes full success from partial commits', () => {
    const clean = emptyBatchEvidence();
    markCreated(clean, 'c1', 1);
    expect(batchSucceeded(clean)).toBe(true);
    expect(batchHadCommits(clean)).toBe(true);

    const partial = emptyBatchEvidence();
    markCreated(partial, 'c1', 1);
    markFailed(partial, { kind: 'create', tempId: 'c2', error: 'x' });
    expect(batchSucceeded(partial)).toBe(false);
    expect(batchHadCommits(partial)).toBe(true);

    const empty = emptyBatchEvidence();
    expect(batchSucceeded(empty)).toBe(true);
    expect(batchHadCommits(empty)).toBe(false);
  });

  it('summarizes failures with temp id, id, and kind fallbacks', () => {
    const evidence = emptyBatchEvidence();
    markFailed(evidence, { kind: 'create', tempId: 'c1', error: 'a' });
    markFailed(evidence, { kind: 'update', id: 7, error: 'b' });
    markFailed(evidence, { kind: 'reorder', error: 'c' });

    expect(batchFailureSummary(evidence)).toBe(
      'create "c1": a\nupdate 7: b\nreorder: c'
    );
    expect(batchFailureSummary(emptyBatchEvidence())).toBeUndefined();
  });
});

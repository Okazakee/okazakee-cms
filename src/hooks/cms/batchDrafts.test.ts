import { describe, expect, it } from 'vitest';
import {
  type BatchEvidence,
  mergeServerWithDrafts,
  readBatchEvidence,
  reconcileDrafts,
} from '@/hooks/cms/batchDrafts';

const evidence = (partial: Partial<BatchEvidence>): BatchEvidence => ({
  created: [],
  createdIds: {},
  updated: [],
  deleted: [],
  reordered: [],
  failed: [],
  ...partial,
});

describe('readBatchEvidence', () => {
  it('returns null for a missing or malformed payload', () => {
    expect(readBatchEvidence(undefined)).toBeNull();
    expect(readBatchEvidence(null)).toBeNull();
    expect(readBatchEvidence('nope')).toBeNull();
    expect(readBatchEvidence([])).toBeNull();
  });

  it('normalizes ids, createdIds and failure evidence', () => {
    const parsed = readBatchEvidence({
      created: ['t1', 5],
      createdIds: { t1: 42, t2: { bad: true } },
      updated: [1, '2', {}],
      deleted: [3],
      reordered: [4],
      failed: [{ kind: 'create', tempId: 't2', error: 'boom' }, null],
    });

    expect(parsed).toEqual({
      created: ['t1'],
      createdIds: { t1: 42 },
      updated: [1, '2'],
      deleted: [3],
      reordered: [4],
      failed: [{ kind: 'create', tempId: 't2', error: 'boom' }],
    });
  });
});

describe('reconcileDrafts', () => {
  it('drops only committed creates and remaps their tempIds', () => {
    const result = reconcileDrafts({
      evidence: evidence({
        created: ['t1'],
        createdIds: { t1: 101 },
      }),
      createTempIds: ['t1', 't2'],
      updateIds: [],
      deleteIds: [],
    });

    expect(result.committedCreates).toEqual(['t1']);
    expect(result.retainedCreates).toEqual(['t2']);
    expect(result.createdIdMap).toEqual({ t1: 101 });
  });

  it('retains creates the server reported as failed', () => {
    const result = reconcileDrafts({
      evidence: evidence({
        created: ['t1'],
        createdIds: { t1: 101 },
        failed: [{ kind: 'create', tempId: 't2', error: 'bad image' }],
      }),
      createTempIds: ['t1', 't2'],
      updateIds: [],
      deleteIds: [],
    });

    expect(result.retainedCreates).toEqual(['t2']);
    expect(result.failureMessages).toEqual(['create "t2": bad image']);
  });

  it('clears committed updates/deletes and retains failed ones', () => {
    const result = reconcileDrafts({
      evidence: evidence({
        updated: [1],
        deleted: [10],
        failed: [
          { kind: 'update', id: 2, error: 'conflict' },
          { kind: 'delete', id: 11, error: 'fk' },
        ],
      }),
      createTempIds: [],
      updateIds: [1, 2],
      deleteIds: [10, 11],
    });

    expect(result.retainedUpdates).toEqual([2]);
    expect(result.retainedDeletes).toEqual([11]);
    expect(result.failureMessages).toEqual([
      'update 2: conflict',
      'delete 11: fk',
    ]);
  });

  it('matches ids across string/number representations', () => {
    const result = reconcileDrafts({
      evidence: evidence({ updated: ['7'] }),
      createTempIds: [],
      updateIds: [7],
      deleteIds: [],
    });

    expect(result.retainedUpdates).toEqual([]);
  });
});

describe('mergeServerWithDrafts', () => {
  it('keeps failed creates, overlays modified rows and removes committed deletes', () => {
    const server = [
      { id: 1, value: 'server1' },
      { id: 2, value: 'server2' },
      { id: 3, value: 'server3' },
    ];
    const merged = mergeServerWithDrafts(server, {
      creates: [{ id: -1, value: 'draft' }],
      modified: new Map([[2, { id: 2, value: 'edited' }]]),
      deletedIds: new Set([3]),
    });

    expect(merged).toEqual([
      { id: 1, value: 'server1' },
      { id: 2, value: 'edited' },
      { id: -1, value: 'draft' },
    ]);
  });
});

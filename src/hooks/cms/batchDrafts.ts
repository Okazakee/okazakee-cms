/**
 * Pure helpers for reconciling BATCH_PUBLISH evidence against local drafts.
 *
 * The backend returns per-operation evidence (committed tempIds / ids and a
 * `failed` list). Clients must only drop drafts that actually committed,
 * retain anything that failed, and remap committed create tempIds to their
 * real ids so a retry cannot create duplicates. These functions keep that
 * state machine testable and identical across the blog / portfolio / career /
 * skills / contacts editors.
 *
 * The evidence shape is owned by `@/libs/cms/batchEvidence`; this module only
 * adds the client-side normalization and reconciliation on top of it.
 */
import {
  type BatchCommitEvidence,
  type BatchFailure,
  batchFailureSummary,
} from '@/libs/cms/batchEvidence';

export type EntityId = number | string;
export type BatchEvidence = BatchCommitEvidence;
export type { BatchFailure };

export function normalizeId(id: EntityId): string {
  return String(id);
}

export function toIdArray(value: unknown): EntityId[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is EntityId =>
      typeof entry === 'string' || typeof entry === 'number'
  );
}

/**
 * Reads the unknown BATCH_PUBLISH `data` payload into typed evidence. Returns
 * null when the payload is absent or not an object, so callers keep every
 * draft instead of clearing on an unparseable response.
 */
export function readBatchEvidence(data: unknown): BatchEvidence | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;

  const created = Array.isArray(record.created)
    ? record.created.filter(
        (entry): entry is string => typeof entry === 'string'
      )
    : [];

  const createdIds: Record<string, EntityId> = {};
  if (record.createdIds && typeof record.createdIds === 'object') {
    for (const [key, value] of Object.entries(
      record.createdIds as Record<string, unknown>
    )) {
      if (typeof value === 'string' || typeof value === 'number') {
        createdIds[key] = value;
      }
    }
  }

  const failed: BatchFailure[] = [];
  if (Array.isArray(record.failed)) {
    for (const entry of record.failed) {
      if (entry && typeof entry === 'object') {
        const failure = entry as Record<string, unknown>;
        failed.push({
          kind:
            typeof failure.kind === 'string'
              ? (failure.kind as BatchFailure['kind'])
              : 'create',
          tempId:
            typeof failure.tempId === 'string' ? failure.tempId : undefined,
          id:
            typeof failure.id === 'string' || typeof failure.id === 'number'
              ? failure.id
              : undefined,
          error: typeof failure.error === 'string' ? failure.error : 'failed',
        });
      }
    }
  }

  return {
    created,
    createdIds,
    updated: toIdArray(record.updated),
    deleted: toIdArray(record.deleted),
    reordered: toIdArray(record.reordered),
    failed,
  };
}

export interface DraftReconcileInput {
  evidence: BatchEvidence;
  createTempIds: string[];
  updateIds: EntityId[];
  deleteIds: EntityId[];
}

export interface DraftReconcileResult {
  /** tempIds whose create committed. */
  committedCreates: string[];
  /** ids whose update committed. */
  committedUpdates: EntityId[];
  /** ids whose delete committed. */
  committedDeletes: EntityId[];
  /** tempId -> real id for committed creates that reported a real id. */
  createdIdMap: Record<string, EntityId>;
  /** tempIds still pending (failed). Keep these create drafts. */
  retainedCreates: string[];
  /** ids whose update did not commit. Keep these modified drafts. */
  retainedUpdates: EntityId[];
  /** ids whose delete did not commit. Keep these deleted drafts. */
  retainedDeletes: EntityId[];
  failures: BatchFailure[];
  failureMessages: string[];
}

/**
 * Computes which drafts committed and therefore may be dropped, and which
 * must be retained because the server reported them as failures.
 */
export function reconcileDrafts(
  input: DraftReconcileInput
): DraftReconcileResult {
  const createIds = new Set(input.createTempIds);
  const updateIds = new Set(input.updateIds.map(normalizeId));
  const deleteIds = new Set(input.deleteIds.map(normalizeId));

  const committedCreateSet = new Set(
    input.evidence.created.filter((tempId) => createIds.has(tempId))
  );
  const committedUpdateIds = input.evidence.updated.filter((id) =>
    updateIds.has(normalizeId(id))
  );
  const committedDeleteIds = input.evidence.deleted.filter((id) =>
    deleteIds.has(normalizeId(id))
  );
  const committedUpdateSet = new Set(committedUpdateIds.map(normalizeId));
  const committedDeleteSet = new Set(committedDeleteIds.map(normalizeId));

  const createdIdMap: Record<string, EntityId> = {};
  for (const tempId of committedCreateSet) {
    const realId = input.evidence.createdIds[tempId];
    if (realId !== undefined) createdIdMap[tempId] = realId;
  }

  return {
    committedCreates: [...committedCreateSet],
    committedUpdates: committedUpdateIds,
    committedDeletes: committedDeleteIds,
    createdIdMap,
    retainedCreates: input.createTempIds.filter(
      (tempId) => !committedCreateSet.has(tempId)
    ),
    retainedUpdates: input.updateIds.filter(
      (id) => !committedUpdateSet.has(normalizeId(id))
    ),
    retainedDeletes: input.deleteIds.filter(
      (id) => !committedDeleteSet.has(normalizeId(id))
    ),
    failures: input.evidence.failed,
    failureMessages: batchFailureSummary(input.evidence)?.split('\n') ?? [],
  };
}

/**
 * Rebuilds a server list while preserving unresolved local drafts: deleted ids
 * stay removed, modified rows keep their latest local snapshot, and failed
 * pending creates are appended.
 */
export function mergeServerWithDrafts<T extends { id: EntityId }>(
  server: T[],
  drafts: {
    creates: T[];
    modified: ReadonlyMap<EntityId, T>;
    deletedIds: ReadonlySet<EntityId>;
  }
): T[] {
  const deleted = new Set([...drafts.deletedIds].map(normalizeId));
  const modified = new Map<string, T>();
  for (const [id, entity] of drafts.modified) {
    modified.set(normalizeId(id), entity);
  }

  const merged: T[] = [];
  for (const row of server) {
    if (deleted.has(normalizeId(row.id))) continue;
    const override = modified.get(normalizeId(row.id));
    merged.push(override ? { ...row, ...override } : row);
  }
  for (const entity of drafts.creates) {
    merged.push(entity);
  }
  return merged;
}

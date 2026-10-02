/**
 * Shared committed-evidence contract for CMS BATCH_PUBLISH operations
 * (client-safe: no server or node imports).
 *
 * A batch can partially succeed: each intended create/update/delete/reorder is
 * committed independently, and the result must tell the client exactly which
 * items persisted and which failed, so the UI can reconcile its optimistic
 * state instead of reloading blindly.
 *
 * `created` holds the client-supplied temporary ids (or a deterministic
 * `temp:<index>` fallback for API compatibility) whose DB insert committed;
 * `createdIds` maps those temp ids to the real DB ids. A committed DB write is
 * never discarded because a later item or the public-site revalidation failed.
 */
export type BatchId = number | string;

export type BatchFailureKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'reorder'
  | 'category';

export interface BatchFailure {
  kind: BatchFailureKind;
  /** Present for create/category failures. */
  tempId?: string;
  /** Present for update/delete/reorder failures. */
  id?: BatchId;
  error: string;
}

export interface BatchCommitEvidence {
  /** Temp ids of creates whose DB insert committed. */
  created: string[];
  /** Temp id -> committed DB id. */
  createdIds: Record<string, BatchId>;
  /** DB ids of updates that committed. */
  updated: BatchId[];
  /** DB ids of deletes that committed. */
  deleted: BatchId[];
  /** DB ids of reorders that committed. */
  reordered: BatchId[];
  failed: BatchFailure[];
}

export function emptyBatchEvidence(): BatchCommitEvidence {
  return {
    created: [],
    createdIds: {},
    updated: [],
    deleted: [],
    reordered: [],
    failed: [],
  };
}

/**
 * Normalizes a client-supplied create temp id. Callers may omit it (older
 * clients); a deterministic `temp:<operation>:<index>` id is assigned so the
 * committed mapping is still unambiguous. Non-string/empty values are coerced.
 */
export function normalizeTempId(
  tempId: unknown,
  namespace: string,
  index: number
): string {
  if (typeof tempId === 'string' && tempId.trim().length > 0) {
    return tempId;
  }
  return `temp:${namespace}:${index}`;
}

export function markCreated(
  evidence: BatchCommitEvidence,
  tempId: string,
  id: BatchId
): void {
  evidence.created.push(tempId);
  evidence.createdIds[tempId] = id;
}

export function markUpdated(evidence: BatchCommitEvidence, id: BatchId): void {
  evidence.updated.push(id);
}

export function markDeleted(evidence: BatchCommitEvidence, id: BatchId): void {
  evidence.deleted.push(id);
}

export function markReordered(
  evidence: BatchCommitEvidence,
  id: BatchId
): void {
  evidence.reordered.push(id);
}

export function markFailed(
  evidence: BatchCommitEvidence,
  failure: BatchFailure
): void {
  evidence.failed.push(failure);
}

/** True when every committed-write attempt succeeded. */
export function batchSucceeded(evidence: BatchCommitEvidence): boolean {
  return evidence.failed.length === 0;
}

/** True when at least one DB write committed (revalidation should be sent). */
export function batchHadCommits(evidence: BatchCommitEvidence): boolean {
  return (
    evidence.created.length > 0 ||
    evidence.updated.length > 0 ||
    evidence.deleted.length > 0 ||
    evidence.reordered.length > 0
  );
}

/** Human-readable, newline-joined summary of every failed item. */
export function batchFailureSummary(
  evidence: BatchCommitEvidence
): string | undefined {
  if (evidence.failed.length === 0) return undefined;
  return evidence.failed
    .map((failure) => {
      if (failure.tempId !== undefined) {
        return `${failure.kind} "${failure.tempId}": ${failure.error}`;
      }
      if (failure.id !== undefined) {
        return `${failure.kind} ${failure.id}: ${failure.error}`;
      }
      return `${failure.kind}: ${failure.error}`;
    })
    .join('\n');
}

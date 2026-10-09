'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  requireAdmin,
} from '@/app/actions/cms/utils/fileHelpers';
import {
  emptyBatchEvidence,
  markDeleted,
  markFailed,
  markUpdated,
  type BatchCommitEvidence,
} from '@/libs/cms/batchEvidence';
import type { MutationResult } from '@/libs/cms/mutationResult';
import type {
  RequestEntry,
  RequestEntryFilter,
} from '@/types/requestEntry.types';
import { mapRequestRow } from '@/utils/cms/requestEntries';

/**
 * Admin-only inbox for the project requests submitted through the public
 * form.
 *
 * Authorization: `project_requests` rows carry a name, an email address and
 * free text a visitor typed, so they are personal data, not editorial
 * content. Every operation requires the `admin` role — enforced here through
 * `requireAdmin()` before the service-role client is touched, never only by
 * hiding the nav entry. An allowlisted `editor` gets the same rejection an
 * anonymous caller would.
 *
 * Storage access: the table has NO anon/authenticated grant, so the only
 * client that can read or write it is the service-role admin client.
 *
 * No revalidation: requests are private operational data and are deliberately
 * kept out of the public cache-tag vocabulary, so no `invalidatePublicContent`
 * event is ever sent for them.
 */

type RequestEntriesOperation =
  | { type: 'LIST'; filter: RequestEntryFilter }
  | { type: 'ARCHIVE'; id: number; archived: boolean }
  | { type: 'DELETE'; id: number };

export type RequestEntriesResult = MutationResult & {
  /**
   * LIST: the entries the filter selected. ARCHIVE/DELETE: the commit
   * evidence for the single row the operation targeted.
   */
  data?: RequestEntry[] | BatchCommitEvidence;
  /** Rows present in the response that could not be read (see mapRequestRow). */
  malformed?: string[];
};

/** Normalizes a client-supplied id into the positive integer the table keys on. */
function toRowId(value: unknown): number | null {
  const id =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Identifies an unreadable row for the defect report. `id` is a `bigint` on the
 * wire, so the numeric form has to stringify too or every defect reports as
 * `unknown`.
 */
function malformedRowId(row: unknown): string {
  if (typeof row !== 'object' || row === null || !('id' in row)) {
    return 'unknown';
  }
  const { id } = row as { id: unknown };
  if (typeof id === 'number') {
    return Number.isInteger(id) ? String(id) : 'unknown';
  }
  return typeof id === 'string' ? id : 'unknown';
}

export async function requestEntriesActions(
  operation: RequestEntriesOperation
): Promise<RequestEntriesResult> {
  try {
    await requireAdmin();
  } catch (error) {
    console.error('Requests action unauthorized:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unauthorized: Admin access required',
    };
  }

  const admin = getAdminClient();

  try {
    switch (operation.type) {
      case 'LIST':
        return await listRequestEntries(admin, operation.filter);
      case 'ARCHIVE':
        return await archiveRequestEntry(
          admin,
          operation.id,
          operation.archived
        );
      case 'DELETE':
        return await deleteRequestEntry(admin, operation.id);
      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Requests action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function listRequestEntries(
  admin: SupabaseClient,
  filter: RequestEntryFilter
): Promise<RequestEntriesResult> {
  const archived = filter === 'archived';
  const { data, error } = await admin
    .from('project_requests')
    .select('*')
    .eq('archived', archived)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error listing project requests:', error);
    return { success: false, error: error.message };
  }

  const entries: RequestEntry[] = [];
  const malformed: string[] = [];
  for (const row of Array.isArray(data) ? data : []) {
    const entry = mapRequestRow(row);
    if (entry === null) {
      malformed.push(malformedRowId(row));
      continue;
    }
    entries.push(entry);
  }

  // A row the mapper cannot read is a defect, not an empty inbox: it is
  // reported so the CMS can say so instead of rendering a short list.
  return {
    success: true,
    data: entries,
    ...(malformed.length > 0 ? { malformed } : {}),
  };
}

async function archiveRequestEntry(
  admin: SupabaseClient,
  rawId: number,
  archived: boolean
): Promise<RequestEntriesResult> {
  const evidence = emptyBatchEvidence();
  const id = toRowId(rawId);
  if (id === null) {
    markFailed(evidence, { kind: 'update', error: 'Invalid request id' });
    return { success: false, error: 'Invalid request id', data: evidence };
  }

  const { data, error } = await admin
    .from('project_requests')
    .update({
      archived,
      archived_at: archived ? new Date().toISOString() : null,
    })
    .eq('id', id)
    // Only a row in the opposite state can satisfy this toggle, so a repeat
    // call reports no-change instead of silently re-stamping archived_at.
    .eq('archived', !archived)
    .select('id');

  if (error) {
    markFailed(evidence, { kind: 'update', id, error: error.message });
    return { success: false, error: error.message, data: evidence };
  }

  if (!Array.isArray(data) || data.length === 0) {
    const reason = `Request ${id} is missing or already ${
      archived ? 'archived' : 'active'
    }`;
    markFailed(evidence, { kind: 'update', id, error: reason });
    return { success: false, error: reason, data: evidence };
  }

  markUpdated(evidence, id);
  return { success: true, data: evidence };
}

async function deleteRequestEntry(
  admin: SupabaseClient,
  rawId: number
): Promise<RequestEntriesResult> {
  const evidence = emptyBatchEvidence();
  const id = toRowId(rawId);
  if (id === null) {
    markFailed(evidence, { kind: 'delete', error: 'Invalid request id' });
    return { success: false, error: 'Invalid request id', data: evidence };
  }

  const { data, error } = await admin
    .from('project_requests')
    .delete()
    .eq('id', id)
    .select('id');

  if (error) {
    markFailed(evidence, { kind: 'delete', id, error: error.message });
    return { success: false, error: error.message, data: evidence };
  }

  // A delete that matched nothing changed nothing: reporting success would
  // hide a stale id from the UI.
  if (!Array.isArray(data) || data.length === 0) {
    const reason = `Request ${id} no longer exists`;
    markFailed(evidence, { kind: 'delete', id, error: reason });
    return { success: false, error: reason, data: evidence };
  }

  markDeleted(evidence, id);
  return { success: true, data: evidence };
}

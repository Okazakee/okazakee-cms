'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  getCmsActionContext,
  isValidContactUrl,
  requireAdmin,
} from '@/app/actions/cms/utils/fileHelpers';
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
} from '@/libs/cms/batchEvidence';
import type {
  MutationResult,
  RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { isValidHttpUrl } from '@/utils/cms/validation';
import { createClient } from '@/utils/supabase/server';

type ContactOperation =
  | { type: 'GET' }
  | { type: 'CREATE'; data: CreateContactData }
  | { type: 'UPDATE'; id: number; data: UpdateContactData }
  | { type: 'DELETE'; id: number }
  | { type: 'REORDER'; contacts: { id: number; position: number }[] }
  | {
      type: 'BATCH_PUBLISH';
      creates: Array<CreateContactData & { tempId?: string }>;
      updates: Array<{ id: number; data: UpdateContactData }>;
      deletes: number[];
      reorder: { id: number; position: number }[];
    };

type CreateContactData = {
  label: string;
  icon: string;
  link: string;
  bg_color: string;
  position: number;
};

type UpdateContactData = {
  label?: string;
  icon?: string;
  link?: string;
  bg_color?: string;
  position?: number;
};

type ContactsResult = MutationResult;

// Validation functions
function validateContactData(data: CreateContactData | UpdateContactData): {
  isValid: boolean;
  error?: string;
} {
  // Label validation
  if ('label' in data && data.label !== undefined) {
    if (!data.label || data.label.trim().length === 0) {
      return { isValid: false, error: 'Contact label is required' };
    }
    if (data.label.length > 50) {
      return { isValid: false, error: 'Label must be less than 50 characters' };
    }
  }

  // Icon validation
  if ('icon' in data && data.icon !== undefined) {
    if (!data.icon?.trim() || !isValidHttpUrl(data.icon)) {
      return {
        isValid: false,
        error: 'Icon must be a valid http(s) SVG image URL',
      };
    }
  }

  // Link validation
  if ('link' in data && data.link !== undefined) {
    if (!data.link || data.link.trim().length === 0) {
      return { isValid: false, error: 'Contact link is required' };
    }
    if (!isValidContactUrl(data.link)) {
      return {
        isValid: false,
        error: 'Link must be a valid URL, email (mailto:), or phone (tel:)',
      };
    }
  }

  // Background color validation
  if (data.bg_color !== undefined) {
    const hexColorPattern = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
    if (!hexColorPattern.test(data.bg_color)) {
      return {
        isValid: false,
        error: 'Background color must be a valid hex color (e.g., #FF5733)',
      };
    }
  }

  // Position validation
  if (
    data.position !== undefined &&
    (data.position < 0 || !Number.isInteger(data.position))
  ) {
    return { isValid: false, error: 'Position must be a non-negative integer' };
  }

  return { isValid: true };
}

export async function contactsActions(
  operation: ContactOperation
): Promise<ContactsResult> {
  if (operation.type === 'BATCH_PUBLISH') {
    return await batchPublishContacts(operation);
  }

  // Admin check - only admins can manage contacts
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getContactsData(supabase);

      case 'CREATE':
        return await createContact(supabase, operation.data);

      case 'UPDATE':
        return await updateContact(supabase, operation.id, operation.data);

      case 'DELETE':
        return await deleteContact(supabase, operation.id);

      case 'REORDER':
        return await reorderContacts(supabase, operation.contacts);

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Contacts action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function batchPublishContacts(
  operation: Extract<ContactOperation, { type: 'BATCH_PUBLISH' }>
): Promise<ContactsResult> {
  const evidence = emptyBatchEvidence();
  try {
    await getCmsActionContext('admin');
    const admin = getAdminClient();

    for (const [index, contact] of operation.creates.entries()) {
      const tempId = normalizeTempId(contact.tempId, 'contact', index);
      const validation = validateContactData(contact);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const { tempId: _tempId, ...insertData } = contact;
      const { data, error } = await admin
        .from('contacts')
        .insert(insertData)
        .select()
        .single();

      if (error) {
        markFailed(evidence, { kind: 'create', tempId, error: error.message });
      } else {
        markCreated(evidence, tempId, data.id);
      }
    }

    for (const contact of operation.updates) {
      const validation = validateContactData(contact.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'update',
          id: contact.id,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const { data, error } = await admin
        .from('contacts')
        .update(contact.data)
        .eq('id', contact.id)
        .select()
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'update',
          id: contact.id,
          error: error.message,
        });
      } else {
        markUpdated(evidence, data.id);
      }
    }

    if (operation.deletes.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('contacts')
        .select('id')
        .in('id', operation.deletes);

      if (fetchError) {
        markFailed(evidence, { kind: 'delete', error: fetchError.message });
      } else {
        // Returned-row evidence: unknown ids keep their drafts.
        const existingIds = new Set(
          (existingRows || []).map((row) => row.id as number)
        );
        for (const id of operation.deletes) {
          if (!existingIds.has(id)) {
            markFailed(evidence, {
              kind: 'delete',
              id,
              error: 'Contact not found',
            });
          }
        }
        const deletable = operation.deletes.filter((id) => existingIds.has(id));
        if (deletable.length > 0) {
          const { data: deletedRows, error } = await admin
            .from('contacts')
            .delete()
            .in('id', deletable)
            .select('id');

          if (error) {
            markFailed(evidence, { kind: 'delete', error: error.message });
          } else {
            const deletedIds = new Set(
              (deletedRows || []).map((row) => row.id as number)
            );
            for (const id of deletable) {
              if (deletedIds.has(id)) markDeleted(evidence, id);
              else {
                markFailed(evidence, {
                  kind: 'delete',
                  id,
                  error: 'Contact was not deleted',
                });
              }
            }
          }
        }
      }
    }

    for (const contact of operation.reorder) {
      const validation = validateContactData({ position: contact.position });
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'reorder',
          id: contact.id,
          error: validation.error ?? 'Invalid position',
        });
        continue;
      }
      const { data, error } = await admin
        .from('contacts')
        .update({ position: contact.position })
        .eq('id', contact.id)
        .select()
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'reorder',
          id: contact.id,
          error: error.message,
        });
      } else {
        markReordered(evidence, data?.id ?? contact.id);
      }
    }
    if (batchSucceeded(evidence) && batchHadCommits(evidence)) {
      const positionError = await compactContactPositions(admin);
      if (positionError) {
        markFailed(evidence, { kind: 'reorder', error: positionError });
      }
    }

    let revalidation: RevalidationStatus | undefined;
    if (batchHadCommits(evidence)) {
      revalidation = await invalidatePublicContent({
        entity: 'contacts',
        operation: 'publish',
      });
    }

    return {
      success: batchSucceeded(evidence),
      data: evidence,
      error: batchFailureSummary(evidence),
      revalidation,
    };
  } catch (error) {
    console.error('Error batch publishing contacts:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to publish contacts';
    markFailed(evidence, { kind: 'update', error: message });
    const revalidation = batchHadCommits(evidence)
      ? await invalidatePublicContent({
          entity: 'contacts',
          operation: 'publish',
        })
      : undefined;
    return {
      success: false,
      data: evidence,
      error: batchFailureSummary(evidence),
      revalidation,
    };
  }
}
async function getContactsData(
  supabase: SupabaseClient
): Promise<ContactsResult> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('position', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });

    if (error) throw error;

    return { success: true, data };
  } catch (error) {
    console.error('Error fetching contacts:', error);
    return {
      success: false,
      error: 'Failed to fetch contacts data',
    };
  }
}

async function createContact(
  _supabase: SupabaseClient,
  contactData: CreateContactData
): Promise<ContactsResult> {
  try {
    const validation = validateContactData(contactData);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('contacts')
      .insert(contactData)
      .select()
      .single();

    if (error) throw error;
    const positionError = await compactContactPositions(admin);

    const revalidation = await invalidatePublicContent({
      entity: 'contacts',
      operation: 'create',
    });
    return {
      success: !positionError,
      data,
      revalidation,
      error: positionError ?? undefined,
    };
  } catch (error) {
    console.error('Error creating contact:', error);
    return {
      success: false,
      error: 'Failed to create contact',
    };
  }
}

async function updateContact(
  _supabase: SupabaseClient,
  contactId: number,
  updateData: UpdateContactData
): Promise<ContactsResult> {
  try {
    const validation = validateContactData(updateData);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data: existingContact, error: fetchError } = await admin
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .single();

    if (fetchError || !existingContact) {
      return { success: false, error: 'Contact not found' };
    }

    const { data, error } = await admin
      .from('contacts')
      .update(updateData)
      .eq('id', contactId)
      .select();

    if (error) throw error;
    const positionError =
      updateData.position === undefined
        ? null
        : await compactContactPositions(admin);

    const revalidation = await invalidatePublicContent({
      entity: 'contacts',
      operation: 'update',
    });
    return {
      success: !positionError,
      data,
      revalidation,
      error: positionError ?? undefined,
    };
  } catch (error) {
    console.error('Error updating contact:', error);
    return {
      success: false,
      error: 'Failed to update contact',
    };
  }
}

async function deleteContact(
  _supabase: SupabaseClient,
  contactId: number
): Promise<ContactsResult> {
  try {
    const admin = getAdminClient();
    const { error } = await admin.from('contacts').delete().eq('id', contactId);

    if (error) throw error;
    const positionError = await compactContactPositions(admin);

    const revalidation = await invalidatePublicContent({
      entity: 'contacts',
      operation: 'delete',
    });
    return {
      success: !positionError,
      revalidation,
      error: positionError ?? undefined,
    };
  } catch (error) {
    console.error('Error deleting contact:', error);
    return {
      success: false,
      error: 'Failed to delete contact',
    };
  }
}

async function reorderContacts(
  _supabase: SupabaseClient,
  contacts: { id: number; position: number }[]
): Promise<ContactsResult> {
  try {
    const admin = getAdminClient();
    for (const contact of contacts) {
      const validation = validateContactData({ position: contact.position });
      if (!validation.isValid) throw new Error(validation.error);
      const { error } = await admin
        .from('contacts')
        .update({ position: contact.position })
        .eq('id', contact.id);

      if (error) throw error;
    }
    const positionError = await compactContactPositions(admin);

    const revalidation = await invalidatePublicContent({
      entity: 'contacts',
      operation: 'update',
    });
    return {
      success: !positionError,
      revalidation,
      error: positionError ?? undefined,
    };
  } catch (error) {
    console.error('Error reordering contacts:', error);
    return {
      success: false,
      error: 'Failed to reorder contacts',
    };
  }
}

async function compactContactPositions(
  admin: SupabaseClient
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('contacts')
      .select('id, position')
      .order('position', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });
    if (error) return error.message;
    for (const [position, row] of (data ?? []).entries()) {
      if (row.position === position) continue;
      const { error: updateError } = await admin
        .from('contacts')
        .update({ position })
        .eq('id', row.id);
      if (updateError) return updateError.message;
    }
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Failed to normalize contact positions';
  }
}

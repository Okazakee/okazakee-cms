'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  getCmsActionContext,
  isValidContactUrl,
  requireAdmin,
} from '@/app/actions/cms/utils/fileHelpers';
import { invalidateContent } from '@/libs/cms/invalidate';
import { createClient } from '@/utils/supabase/server';

type ContactOperation =
  | { type: 'GET' }
  | { type: 'CREATE'; data: CreateContactData }
  | { type: 'UPDATE'; id: number; data: UpdateContactData }
  | { type: 'DELETE'; id: number }
  | { type: 'REORDER'; contacts: { id: number; position: number }[] }
  | {
      type: 'BATCH_PUBLISH';
      creates: CreateContactData[];
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

type ContactsResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

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
    if (!data.icon || data.icon.trim().length === 0) {
      return { isValid: false, error: 'Icon name is required' };
    }
    if (data.icon.length > 50) {
      return {
        isValid: false,
        error: 'Icon name must be less than 50 characters',
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
  if (data.bg_color !== undefined && data.bg_color) {
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
  try {
    await getCmsActionContext('admin');
    const admin = getAdminClient();
    const errors: string[] = [];
    const changed: unknown[] = [];

    for (const contact of operation.creates) {
      const validation = validateContactData(contact);
      if (!validation.isValid) {
        errors.push(`"${contact.label}": ${validation.error}`);
        continue;
      }

      const { data, error } = await admin
        .from('contacts')
        .insert(contact)
        .select()
        .single();

      if (error) errors.push(`"${contact.label}": ${error.message}`);
      else changed.push(data);
    }

    for (const contact of operation.updates) {
      const validation = validateContactData(contact.data);
      if (!validation.isValid) {
        errors.push(`Update ${contact.id}: ${validation.error}`);
        continue;
      }

      const { data, error } = await admin
        .from('contacts')
        .update(contact.data)
        .eq('id', contact.id)
        .select()
        .single();

      if (error) errors.push(`Update ${contact.id}: ${error.message}`);
      else changed.push(data);
    }

    if (operation.deletes.length > 0) {
      const { error } = await admin
        .from('contacts')
        .delete()
        .in('id', operation.deletes);
      if (error) errors.push(`Delete: ${error.message}`);
    }

    for (const contact of operation.reorder) {
      const { error } = await admin
        .from('contacts')
        .update({ position: contact.position })
        .eq('id', contact.id);
      if (error) errors.push(`Reorder ${contact.id}: ${error.message}`);
    }

    if (
      operation.creates.length > 0 ||
      operation.updates.length > 0 ||
      operation.deletes.length > 0 ||
      operation.reorder.length > 0
    ) {
      invalidateContent({ entity: 'contacts', operation: 'publish' });
    }

    return {
      success: errors.length === 0,
      data: changed,
      error: errors.length > 0 ? errors.join('\n') : undefined,
    };
  } catch (error) {
    console.error('Error batch publishing contacts:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to publish contacts',
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
      .order('position', { ascending: true });

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

    invalidateContent({ entity: 'contacts', operation: 'create' });
    return { success: true, data };
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

    invalidateContent({ entity: 'contacts', operation: 'update' });
    return { success: true, data };
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

    invalidateContent({ entity: 'contacts', operation: 'delete' });
    return { success: true };
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
      const { error } = await admin
        .from('contacts')
        .update({ position: contact.position })
        .eq('id', contact.id);

      if (error) throw error;
    }

    invalidateContent({ entity: 'contacts', operation: 'update' });
    return { success: true };
  } catch (error) {
    console.error('Error reordering contacts:', error);
    return {
      success: false,
      error: 'Failed to reorder contacts',
    };
  }
}

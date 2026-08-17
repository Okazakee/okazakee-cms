'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateBlurhashFromBuffer,
  getAdminClient,
  getCmsActionContext,
  getStoragePathFromPublicUrl,
  isValidDate,
  isValidHttpUrl,
  prepareImageUpload,
  processImage,
  removePublicFileIfDifferent,
  removePublicFileIfPresent,
  requireAdmin,
  sanitizeFilename,
  uploadPreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import { invalidateContent } from '@/libs/cms/invalidate';
import type { CareerEntry } from '@/types/fetchedData.types';
import { isValidBlurhash } from '@/utils/blurhashUtils';
import { createClient } from '@/utils/supabase/server';

type CareerOperation =
  | { type: 'GET' }
  | { type: 'CREATE'; data: CreateCareerData }
  | { type: 'UPDATE'; id: number; data: UpdateCareerData }
  | { type: 'DELETE'; id: number }
  | {
      type: 'UPLOAD_LOGO';
      careerId: number;
      file: File;
      currentLogoUrl?: string;
      blurhashURL?: string;
    }
  | { type: 'ROLLBACK_CREATE'; entryId: number }
  | {
      type: 'BATCH_PUBLISH';
      creates: Array<{
        data: CreateCareerData;
        file?: File | null;
        blurhashURL?: string;
      }>;
      updates: Array<{
        id: number;
        data: UpdateCareerData;
        file?: File | null;
        currentLogoUrl?: string;
        blurhashURL?: string;
      }>;
      deletes: number[];
    };

type CreateCareerData = {
  title: string;
  company: string;
  website_url: string;
  logo: string;
  blurhashURL: string;
  location_en: string;
  location_it: string;
  remote: 'full' | 'hybrid' | 'onSite';
  startDate: string;
  endDate: string | null;
  description_en: string;
  description_it: string;
  skills: string;
  company_description_en: string;
  company_description_it: string;
};

type UpdateCareerData = Partial<CreateCareerData>;

type CareerResult = {
  success: boolean;
  data?:
    | CareerEntry
    | CareerEntry[]
    | { logo: string; blurhashURL: string }
    | null;
  error?: string;
};

function toCareerDbData(
  data: CreateCareerData | UpdateCareerData
): Record<string, unknown> {
  const { blurhashURL, ...rest } = data;
  return blurhashURL === undefined
    ? rest
    : { ...rest, blurhashurl: blurhashURL };
}

function normalizeCareerEntry(row: unknown): CareerEntry {
  const record = row as Record<string, unknown>;
  return {
    ...record,
    blurhashURL: (record.blurhashURL ?? record.blurhashurl ?? '') as string,
  } as CareerEntry;
}

// Validation functions
function validateCareerData(data: CreateCareerData | UpdateCareerData): {
  isValid: boolean;
  error?: string;
} {
  // Required fields validation
  if (
    data.title !== undefined &&
    (!data.title || data.title.trim().length === 0)
  ) {
    return { isValid: false, error: 'Job title is required' };
  }

  if (
    data.company !== undefined &&
    (!data.company || data.company.trim().length === 0)
  ) {
    return { isValid: false, error: 'Company name is required' };
  }

  if (
    data.description_en !== undefined &&
    (!data.description_en || data.description_en.trim().length === 0)
  ) {
    return { isValid: false, error: 'English description is required' };
  }

  if (
    data.description_it !== undefined &&
    (!data.description_it || data.description_it.trim().length === 0)
  ) {
    return { isValid: false, error: 'Italian description is required' };
  }

  // Length validation
  if (data.title && data.title.length > 200) {
    return {
      isValid: false,
      error: 'Job title must be less than 200 characters',
    };
  }

  if (data.company && data.company.length > 200) {
    return {
      isValid: false,
      error: 'Company name must be less than 200 characters',
    };
  }

  if (data.description_en && data.description_en.length > 1000) {
    return {
      isValid: false,
      error: 'English description must be less than 1000 characters',
    };
  }

  if (data.description_it && data.description_it.length > 1000) {
    return {
      isValid: false,
      error: 'Italian description must be less than 1000 characters',
    };
  }

  // URL validation
  if (data.website_url?.trim() && !isValidHttpUrl(data.website_url)) {
    return { isValid: false, error: 'Website URL must be a valid URL' };
  }

  // Date validation
  if (data.startDate && !isValidDate(data.startDate)) {
    return { isValid: false, error: 'Start date must be a valid date' };
  }

  if (data.endDate && !isValidDate(data.endDate)) {
    return { isValid: false, error: 'End date must be a valid date' };
  }

  // Date logic validation
  if (
    data.startDate &&
    data.endDate &&
    new Date(data.startDate) > new Date(data.endDate)
  ) {
    return { isValid: false, error: 'Start date cannot be after end date' };
  }

  return { isValid: true };
}

export async function careerActions(
  operation: CareerOperation
): Promise<CareerResult> {
  if (operation.type === 'BATCH_PUBLISH') {
    return await batchPublishCareer(operation);
  }

  // Admin check - only admins can manage career
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getCareerData(supabase);

      case 'CREATE':
        return await createCareer(supabase, operation.data);

      case 'UPDATE':
        return await updateCareer(supabase, operation.id, operation.data);

      case 'DELETE':
        return await deleteCareer(supabase, operation.id);

      case 'UPLOAD_LOGO':
        return await uploadCareerLogo(
          supabase,
          operation.careerId,
          operation.file,
          operation.currentLogoUrl,
          operation.blurhashURL
        );

      case 'ROLLBACK_CREATE':
        return await rollbackCareerCreate(operation.entryId);

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Career action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function batchPublishCareer(
  operation: Extract<CareerOperation, { type: 'BATCH_PUBLISH' }>
): Promise<CareerResult> {
  try {
    await getCmsActionContext('admin');
    const admin = getAdminClient();
    const errors: string[] = [];
    const changed: CareerEntry[] = [];

    for (const item of operation.creates) {
      const validation = validateCareerData(item.data);
      if (!validation.isValid) {
        errors.push(`"${item.data.title}": ${validation.error}`);
        continue;
      }

      const insertData: CreateCareerData = { ...item.data };
      let uploaded: { publicUrl: string; path: string } | null = null;

      if (item.file) {
        const prepared = await prepareImageUpload(item.file, item.blurhashURL, {
          maxWidth: 256,
          maxHeight: 256,
          quality: 80,
        });
        if (!prepared.success) {
          errors.push(`"${item.data.title}": ${prepared.error}`);
          continue;
        }
        uploaded = await uploadPreparedImage(
          admin,
          'website',
          `Website Assets/career/${Date.now()}-${sanitizeFilename(item.data.company || 'company')}`,
          prepared.image
        );
        insertData.logo = uploaded.publicUrl;
        insertData.blurhashURL = prepared.image.blurhash;
      }

      const { data, error } = await admin
        .from('career_entries')
        .insert(toCareerDbData(insertData))
        .select()
        .single();

      if (error) {
        if (uploaded)
          await admin.storage.from('website').remove([uploaded.path]);
        errors.push(`"${item.data.title}": ${error.message}`);
        continue;
      }

      changed.push(normalizeCareerEntry(data));
    }

    for (const item of operation.updates) {
      const validation = validateCareerData(item.data);
      if (!validation.isValid) {
        errors.push(`Update ${item.id}: ${validation.error}`);
        continue;
      }

      const updateData: UpdateCareerData = { ...item.data };
      let uploaded: { publicUrl: string; path: string } | null = null;

      if (item.file) {
        const prepared = await prepareImageUpload(item.file, item.blurhashURL, {
          maxWidth: 256,
          maxHeight: 256,
          quality: 80,
        });
        if (!prepared.success) {
          errors.push(`Update ${item.id}: ${prepared.error}`);
          continue;
        }
        uploaded = await uploadPreparedImage(
          admin,
          'website',
          `Website Assets/career/${item.id}-${sanitizeFilename(item.data.company || `company-${item.id}`)}`,
          prepared.image
        );
        updateData.logo = uploaded.publicUrl;
        updateData.blurhashURL = prepared.image.blurhash;
      }

      const { data, error } = await admin
        .from('career_entries')
        .update(toCareerDbData(updateData))
        .eq('id', item.id)
        .select()
        .single();

      if (error) {
        if (uploaded)
          await admin.storage.from('website').remove([uploaded.path]);
        errors.push(`Update ${item.id}: ${error.message}`);
        continue;
      }

      if (uploaded && item.currentLogoUrl) {
        await removePublicFileIfDifferent(
          admin,
          item.currentLogoUrl,
          'website',
          uploaded.path
        );
      }

      changed.push(normalizeCareerEntry(data));
    }

    if (operation.deletes.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('career_entries')
        .select('id, logo')
        .in('id', operation.deletes);

      if (fetchError) {
        errors.push(`Delete: ${fetchError.message}`);
      } else {
        const { error } = await admin
          .from('career_entries')
          .delete()
          .in('id', operation.deletes);
        if (error) {
          errors.push(`Delete: ${error.message}`);
        } else {
          for (const row of existingRows || []) {
            await removePublicFileIfPresent(
              admin,
              row.logo as string | null,
              'website'
            );
          }
        }
      }
    }

    if (
      operation.creates.length > 0 ||
      operation.updates.length > 0 ||
      operation.deletes.length > 0
    ) {
      invalidateContent({ entity: 'career', operation: 'publish' });
    }

    return {
      success: errors.length === 0,
      data: changed,
      error: errors.length > 0 ? errors.join('\n') : undefined,
    };
  } catch (error) {
    console.error('Error batch publishing career entries:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to publish career entries',
    };
  }
}

async function getCareerData(supabase: SupabaseClient): Promise<CareerResult> {
  // Uncached direct read: editors must see current DB state immediately.
  try {
    const { data: careerEntries, error } = await supabase
      .from('career_entries')
      .select('*')
      .order('id', { ascending: false });

    if (error) throw error;

    return {
      success: true,
      data: careerEntries?.map(normalizeCareerEntry) ?? null,
    };
  } catch (error) {
    console.error('Error fetching career data:', error);
    return {
      success: false,
      error: 'Failed to fetch career data',
    };
  }
}

async function createCareer(
  _supabase: SupabaseClient,
  data: CreateCareerData
): Promise<CareerResult> {
  try {
    const validation = validateCareerData(data);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data: newCareer, error } = await admin
      .from('career_entries')
      .insert(toCareerDbData(data))
      .select()
      .single();

    if (error) throw error;

    invalidateContent({ entity: 'career', operation: 'create' });
    return { success: true, data: normalizeCareerEntry(newCareer) };
  } catch (error) {
    console.error('Error creating career entry:', error);
    return {
      success: false,
      error: 'Failed to create career entry',
    };
  }
}

async function updateCareer(
  _supabase: SupabaseClient,
  id: number,
  data: UpdateCareerData
): Promise<CareerResult> {
  try {
    const validation = validateCareerData(data);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data: existingCareer, error: fetchError } = await admin
      .from('career_entries')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingCareer) {
      return { success: false, error: 'Career entry not found' };
    }

    const { data: updatedCareer, error } = await admin
      .from('career_entries')
      .update(toCareerDbData(data))
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    invalidateContent({ entity: 'career', operation: 'update' });
    return { success: true, data: normalizeCareerEntry(updatedCareer) };
  } catch (error) {
    console.error('Error updating career entry:', error);
    return {
      success: false,
      error: 'Failed to update career entry',
    };
  }
}

async function deleteCareer(
  _supabase: SupabaseClient,
  id: number
): Promise<CareerResult> {
  try {
    const admin = getAdminClient();
    const { data: existingCareer, error: fetchError } = await admin
      .from('career_entries')
      .select('id, logo')
      .eq('id', id)
      .single();

    if (fetchError || !existingCareer) {
      return { success: false, error: 'Career entry not found' };
    }

    if (existingCareer.logo) {
      const logoPath = getStoragePathFromPublicUrl(
        existingCareer.logo as string,
        'website'
      );
      if (logoPath) {
        await admin.storage.from('website').remove([logoPath]);
      }
    }

    const { error } = await admin.from('career_entries').delete().eq('id', id);

    if (error) throw error;

    invalidateContent({ entity: 'career', operation: 'delete' });
    return { success: true };
  } catch (error) {
    console.error('Error deleting career entry:', error);
    return {
      success: false,
      error: 'Failed to delete career entry',
    };
  }
}

/** Rollback a created entry and its logo (e.g. on apply failure). */
async function rollbackCareerCreate(entryId: number): Promise<CareerResult> {
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const admin = getAdminClient();
    const { data: entry, error: fetchError } = await admin
      .from('career_entries')
      .select('id, logo')
      .eq('id', entryId)
      .single();

    if (fetchError || !entry) return { success: true };

    if (entry.logo) {
      const logoPath = getStoragePathFromPublicUrl(
        entry.logo as string,
        'website'
      );
      if (logoPath) {
        await admin.storage.from('website').remove([logoPath]);
      }
    }

    const { error } = await admin
      .from('career_entries')
      .delete()
      .eq('id', entryId);
    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('Error rolling back career create:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Rollback failed',
    };
  }
}

async function uploadCareerLogo(
  supabase: SupabaseClient,
  careerId: number,
  file: File,
  currentLogoUrl?: string,
  blurhashURL?: string
): Promise<CareerResult> {
  try {
    const fileValidation = validateImageFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();
    const { data: existingCareer, error: fetchError } = await admin
      .from('career_entries')
      .select('id, company')
      .eq('id', careerId)
      .single();

    if (fetchError || !existingCareer) {
      return { success: false, error: 'Career entry not found' };
    }

    const isWebP = file.type === 'image/webp';
    let buffer: Buffer;
    let blurhash: string | undefined;
    let format: 'webp' | 'png' = 'webp';

    if (isWebP) {
      const arrayBuffer = await file.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      blurhash = isValidBlurhash(blurhashURL)
        ? blurhashURL
        : await generateBlurhashFromBuffer(buffer);
    } else {
      const processed = await processImage(file);
      if (!processed.success || !processed.buffer) {
        return {
          success: false,
          error: processed.error || 'Failed to process image',
        };
      }
      buffer = processed.buffer;
      blurhash = isValidBlurhash(blurhashURL)
        ? blurhashURL
        : processed.blurhash;
      format = processed.format ?? 'webp';
    }

    const sanitizedCompany = sanitizeFilename(
      existingCareer.company || 'company'
    );
    const fileName = `Website Assets/career/${careerId}-${sanitizedCompany}.webp`;

    await admin.storage.from('website').remove([fileName]);

    const { error: uploadError } = await admin.storage
      .from('website')
      .upload(fileName, buffer, {
        cacheControl: '3600',
        contentType: format === 'png' ? 'image/png' : 'image/webp',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = admin.storage
      .from('website')
      .getPublicUrl(fileName);

    const updateData: { logo: string; blurhashurl?: string | null } = {
      logo: urlData.publicUrl,
      blurhashurl: blurhash ?? null,
    };

    const { error: updateError } = await admin
      .from('career_entries')
      .update(updateData)
      .eq('id', careerId);

    if (updateError) throw updateError;

    await removePublicFileIfDifferent(
      supabase,
      currentLogoUrl,
      'website',
      fileName
    );

    invalidateContent({ entity: 'career', operation: 'asset-update' });
    return {
      success: true,
      data: { logo: urlData.publicUrl, blurhashURL: blurhash || '' },
    };
  } catch (error) {
    console.error('Error uploading career logo:', error);
    return {
      success: false,
      error: 'Failed to upload career logo',
    };
  }
}

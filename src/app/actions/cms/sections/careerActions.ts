'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildUniqueAssetPath,
  generateBlurhashFromBuffer,
  getAdminClient,
  getCmsActionContext,
  isValidDate,
  isValidHttpUrl,
  prepareImageUpload,
  processImage,
  removePublicFileIfDifferent,
  removePublicFileIfPresent,
  removeStorageObjectBestEffort,
  requireAdmin,
  uploadImmutablePreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import {
  batchFailureSummary,
  batchHadCommits,
  batchSucceeded,
  emptyBatchEvidence,
  markCreated,
  markDeleted,
  markFailed,
  markUpdated,
  normalizeTempId,
} from '@/libs/cms/batchEvidence';
import type {
  MutationResult,
  RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
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
        /** Client-generated temporary id; echoed back in `created`/`createdIds`. */
        tempId?: string;
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

type CareerResult = MutationResult & {
  data?: unknown;
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
  const evidence = emptyBatchEvidence();
  try {
    await getCmsActionContext('admin');
    const admin = getAdminClient();

    for (const [index, item] of operation.creates.entries()) {
      const tempId = normalizeTempId(item.tempId, 'career', index);
      const validation = validateCareerData(item.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: validation.error ?? 'Invalid data',
        });
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
          markFailed(evidence, {
            kind: 'create',
            tempId,
            error: prepared.error ?? 'Image processing failed',
          });
          continue;
        }
        uploaded = await uploadImmutablePreparedImage(
          admin,
          'website',
          'Website Assets/career',
          item.data.company || 'company',
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
        if (uploaded) {
          await removeStorageObjectBestEffort(admin, 'website', uploaded.path);
        }
        markFailed(evidence, { kind: 'create', tempId, error: error.message });
        continue;
      }

      markCreated(evidence, tempId, data.id);
    }

    for (const item of operation.updates) {
      const validation = validateCareerData(item.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const updateData: UpdateCareerData = { ...item.data };
      let uploaded: { publicUrl: string; path: string } | null = null;
      // Trusted replacement source: previous logo URL comes from the DB.
      let previousLogo: string | null = null;

      if (item.file) {
        const prepared = await prepareImageUpload(item.file, item.blurhashURL, {
          maxWidth: 256,
          maxHeight: 256,
          quality: 80,
        });
        if (!prepared.success) {
          markFailed(evidence, {
            kind: 'update',
            id: item.id,
            error: prepared.error ?? 'Image processing failed',
          });
          continue;
        }

        const { data: currentRow, error: fetchError } = await admin
          .from('career_entries')
          .select('logo')
          .eq('id', item.id)
          .single();

        if (fetchError) {
          markFailed(evidence, {
            kind: 'update',
            id: item.id,
            error: fetchError.message,
          });
          continue;
        }
        previousLogo = (currentRow?.logo as string | null) ?? null;

        uploaded = await uploadImmutablePreparedImage(
          admin,
          'website',
          'Website Assets/career',
          item.data.company || `company-${item.id}`,
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
        if (uploaded) {
          await removeStorageObjectBestEffort(admin, 'website', uploaded.path);
        }
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: error.message,
        });
        continue;
      }

      if (uploaded) {
        await removePublicFileIfDifferent(
          admin,
          previousLogo,
          'website',
          uploaded.path
        );
      }

      markUpdated(evidence, data.id);
    }

    if (operation.deletes.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('career_entries')
        .select('id, logo')
        .in('id', operation.deletes);

      if (fetchError) {
        markFailed(evidence, { kind: 'delete', error: fetchError.message });
      } else {
        // Returned-row evidence: only ids present at delete time may be
        // reported as committed, so concurrent/unknown ids keep their drafts.
        const existingIds = new Set(
          (existingRows || []).map((row) => row.id as number)
        );
        for (const id of operation.deletes) {
          if (!existingIds.has(id)) {
            markFailed(evidence, {
              kind: 'delete',
              id,
              error: 'Career entry not found',
            });
          }
        }
        const deletable = operation.deletes.filter((id) =>
          existingIds.has(id)
        );
        if (deletable.length > 0) {
          const { data: deletedRows, error } = await admin
            .from('career_entries')
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
                  error: 'Career entry was not deleted',
                });
              }
            }
            for (const row of existingRows || []) {
              if (deletedIds.has(row.id as number)) {
                await removePublicFileIfPresent(
                  admin,
                  row.logo as string | null,
                  'website'
                );
              }
            }
          }
        }
      }
    }

    let revalidation: RevalidationStatus | undefined;
    if (batchHadCommits(evidence)) {
      revalidation = await invalidatePublicContent({
        entity: 'career',
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
    console.error('Error batch publishing career entries:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to publish career entries';
    markFailed(evidence, { kind: 'update', error: message });
    const revalidation = batchHadCommits(evidence)
      ? await invalidatePublicContent({
          entity: 'career',
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

    const revalidation = await invalidatePublicContent({
      entity: 'career',
      operation: 'create',
    });
    return {
      success: true,
      data: normalizeCareerEntry(newCareer),
      revalidation,
    };
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

    const revalidation = await invalidatePublicContent({
      entity: 'career',
      operation: 'update',
    });
    return {
      success: true,
      data: normalizeCareerEntry(updatedCareer),
      revalidation,
    };
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

    // Commit the DB delete FIRST; only then remove the Storage object
    // (best-effort). Deleting the object before the row is gone would leave
    // the row pointing at a deleted logo if the DB delete failed.
    const { error } = await admin.from('career_entries').delete().eq('id', id);

    if (error) throw error;

    await removePublicFileIfPresent(
      admin,
      existingCareer.logo as string | null,
      'website'
    );

    const revalidation = await invalidatePublicContent({
      entity: 'career',
      operation: 'delete',
    });
    return { success: true, revalidation };
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

    const { error } = await admin
      .from('career_entries')
      .delete()
      .eq('id', entryId);
    if (error) throw error;

    // The row is the authoritative state: delete it first, then remove the
    // logo best-effort. Storage-first would leave a surviving row pointing at
    // a deleted logo if the DB delete failed.
    if (entry.logo) {
      await removePublicFileIfPresent(
        admin,
        entry.logo as string | null,
        'website'
      );
    }

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
  _supabase: SupabaseClient,
  careerId: number,
  file: File,
  _currentLogoUrl?: string,
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
      .select('id, company, logo')
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

    // Unique immutable path: never overwrites the previous logo, so a failed
    // DB update cannot leave the row pointing at a deleted object. The
    // previous DB-referenced logo is removed AFTER the commit.
    const fileBase = buildUniqueAssetPath(
      'Website Assets/career',
      existingCareer.company || 'company'
    );
    const fileName = `${fileBase}.${format === 'png' ? 'png' : 'webp'}`;

    const { error: uploadError } = await admin.storage
      .from('website')
      .upload(fileName, buffer, {
        cacheControl: '3600',
        contentType: format === 'png' ? 'image/png' : 'image/webp',
        upsert: false,
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

    if (updateError) {
      await removeStorageObjectBestEffort(admin, 'website', fileName);
      throw updateError;
    }

    // DB-authoritative cleanup: never trust the client-supplied URL, even when
    // the DB logo is null (a forged URL must not direct a storage delete).
    await removePublicFileIfDifferent(
      admin,
      existingCareer.logo,
      'website',
      fileName
    );

    const revalidation = await invalidatePublicContent({
      entity: 'career',
      operation: 'asset-update',
    });
    return {
      success: true,
      data: { logo: urlData.publicUrl, blurhashURL: blurhash || '' },
      revalidation,
    };
  } catch (error) {
    console.error('Error uploading career logo:', error);
    return {
      success: false,
      error: 'Failed to upload career logo',
    };
  }
}

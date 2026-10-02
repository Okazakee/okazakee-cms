'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  prepareImageUpload,
  removePublicFileIfDifferent,
  removeStorageObjectBestEffort,
  requireAdmin,
  uploadImmutablePreparedImage,
  uploadPdfBuffer,
  validateImageFile,
  validatePdfFile,
} from '@/app/actions/cms/utils/fileHelpers';
import type { MutationResult } from '@/libs/cms/mutationResult';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { createClient } from '@/utils/supabase/server';

type HeroOperation =
  | { type: 'GET' }
  | { type: 'UPDATE'; data: HeroUpdateData }
  | {
      type: 'UPLOAD_IMAGE';
      file: File;
      currentImageUrl?: string;
      blurhashURL?: string;
    }
  | {
      type: 'UPLOAD_RESUME';
      file: File;
      field: 'resume_en' | 'resume_it';
      currentResumeUrl?: string;
    }
  | {
      type: 'UPDATE_WITH_FILES';
      files: HeroFileData;
      currentData?: HeroCurrentData;
      blurhashURL?: string;
    };

type HeroUpdateData = {
  name?: string;
  role?: string;
  about?: string;
  propic?: string;
  blurhashURL?: string;
  resume_en?: string;
  resume_it?: string;
};

type HeroFileData = {
  propic?: File;
  mainImage?: File;
  resume_en?: File;
  resume_it?: File;
};

type HeroCurrentData = {
  propic?: string;
  mainImage?: string;
  resume_en?: string;
  resume_it?: string;
};

type HeroResult = MutationResult;

export async function heroActions(
  operation: HeroOperation
): Promise<HeroResult> {
  // Auth check - reject unauthenticated requests
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getHeroData(supabase);

      case 'UPDATE':
        return await updateHero(supabase, operation.data);

      case 'UPLOAD_IMAGE':
        return await uploadHeroImage(
          supabase,
          operation.file,
          operation.currentImageUrl,
          operation.blurhashURL
        );

      case 'UPLOAD_RESUME':
        return await uploadResume(
          supabase,
          operation.file,
          operation.field,
          operation.currentResumeUrl
        );

      case 'UPDATE_WITH_FILES':
        return await updateWithFiles(
          supabase,
          operation.files,
          operation.currentData,
          operation.blurhashURL
        );

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Hero action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function getHeroData(supabase: SupabaseClient): Promise<HeroResult> {
  // Uncached direct reads: editors must see current DB state immediately.
  try {
    const { data: heroSection } = await supabase
      .from('hero_section')
      .select('id, propic, blurhashURL')
      .single();
    const { data: resumeData } = await supabase
      .from('hero_section')
      .select('resume_en, resume_it')
      .single();

    if (!heroSection) {
      return {
        success: false,
        error: 'Hero section not found',
      };
    }

    return {
      success: true,
      data: {
        hero: heroSection,
        resume: resumeData,
      },
    };
  } catch (error) {
    console.error('Error fetching hero data:', error);
    return {
      success: false,
      error: 'Failed to fetch hero data',
    };
  }
}

async function updateHero(
  _supabase: SupabaseClient,
  updateData: HeroUpdateData
): Promise<HeroResult> {
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('hero_section')
      .update(updateData)
      .eq('id', 1)
      .select()
      .single();

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'hero',
      operation: 'update',
    });

    return { success: true, data, revalidation };
  } catch (error) {
    console.error('Error updating hero:', error);
    return {
      success: false,
      error: 'Failed to update hero section',
    };
  }
}

async function uploadHeroImage(
  _supabase: SupabaseClient,
  file: File,
  _currentImageUrl?: string,
  blurhashURL?: string
): Promise<HeroResult> {
  try {
    const fileValidation = validateImageFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();
    const prepared = await prepareImageUpload(file, blurhashURL, {
      maxWidth: 512,
      maxHeight: 512,
      quality: 80,
    });
    if (!prepared.success) {
      return { success: false, error: prepared.error };
    }

    // Trusted replacement source: read the previous propic from the DB rather
    // than trusting the client payload.
    const { data: currentRow, error: fetchError } = await admin
      .from('hero_section')
      .select('propic')
      .eq('id', 1)
      .single();
    if (fetchError || !currentRow)
      throw fetchError ?? new Error('Hero row not found');

    // Unique immutable path: the new object never overwrites the previous one.
    const upload = await uploadImmutablePreparedImage(
      admin,
      'website',
      'avatar',
      'avatar',
      prepared.image
    );

    // Canonical stored value: cache-busted public URL. Persist and return the
    // SAME value so CMS state matches the database row.
    const propicUrl = `${upload.publicUrl}?t=${Date.now()}`;
    const updateData: { propic: string; blurhashURL: string | null } = {
      propic: propicUrl,
      blurhashURL: prepared.image.blurhash,
    };

    const { error: updateError } = await admin
      .from('hero_section')
      .update(updateData)
      .eq('id', 1)
      .select('id')
      .single();

    if (updateError) {
      await removeStorageObjectBestEffort(admin, 'website', upload.path);
      throw updateError;
    }

    await removePublicFileIfDifferent(
      admin,
      currentRow.propic,
      'website',
      upload.path
    );

    const revalidation = await invalidatePublicContent({
      entity: 'hero',
      operation: 'asset-update',
    });

    return {
      success: true,
      data: { propic: propicUrl, blurhashURL: prepared.image.blurhash },
      revalidation,
    };
  } catch (error) {
    console.error('Error uploading hero image:', error);
    return {
      success: false,
      error: 'Failed to upload hero image',
    };
  }
}

async function uploadResume(
  _supabase: SupabaseClient,
  file: File,
  field: 'resume_en' | 'resume_it',
  _currentResumeUrl?: string
): Promise<HeroResult> {
  try {
    const fileValidation = validatePdfFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();
    const { data: currentRow, error: fetchError } = await admin
      .from('hero_section')
      .select('resume_en, resume_it')
      .eq('id', 1)
      .single();
    if (fetchError || !currentRow)
      throw fetchError ?? new Error('Hero row not found');

    // Unique immutable PDF path: never overwrites the previous resume.
    const buffer = Buffer.from(await file.arrayBuffer());
    const upload = await uploadPdfBuffer(
      admin,
      'website',
      'resumes',
      field,
      buffer
    );

    const { error: updateError } = await admin
      .from('hero_section')
      .update({ [field]: upload.publicUrl })
      .eq('id', 1)
      .select('id')
      .single();

    if (updateError) {
      await removeStorageObjectBestEffort(admin, 'website', upload.path);
      throw updateError;
    }

    await removePublicFileIfDifferent(
      admin,
      currentRow[field] as string | null,
      'website',
      upload.path
    );

    const revalidation = await invalidatePublicContent({
      entity: 'resume',
      operation: 'update',
    });

    return {
      success: true,
      data: { [field]: upload.publicUrl },
      revalidation,
    };
  } catch (error) {
    console.error('Error uploading resume:', error);
    return {
      success: false,
      error: 'Failed to upload resume',
    };
  }
}

async function updateWithFiles(
  _supabase: SupabaseClient,
  files: HeroFileData,
  _currentData?: HeroCurrentData,
  blurhashURL?: string
): Promise<HeroResult> {
  const admin = getAdminClient();
  const propicFile = files.propic ?? files.mainImage;

  // 1. Validate every file before touching storage or the DB. A single invalid
  //    file must produce zero uploads and zero commits.
  if (propicFile) {
    const validation = validateImageFile(propicFile);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
  }
  if (files.resume_en) {
    const validation = validatePdfFile(files.resume_en);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
  }
  if (files.resume_it) {
    const validation = validatePdfFile(files.resume_it);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
  }

  const updates: HeroUpdateData = {};
  const staged: Array<{
    path: string;
    field: 'propic' | 'resume_en' | 'resume_it';
  }> = [];

  // 2. Stage all objects. If any staging step fails, remove everything already
  //    staged and commit nothing.
  try {
    if (propicFile) {
      const prepared = await prepareImageUpload(propicFile, blurhashURL, {
        maxWidth: 512,
        maxHeight: 512,
        quality: 80,
      });
      if (!prepared.success) {
        throw new Error(prepared.error ?? 'Image processing failed');
      }

      const upload = await uploadImmutablePreparedImage(
        admin,
        'website',
        'avatar',
        'avatar',
        prepared.image
      );
      staged.push({ path: upload.path, field: 'propic' });
      updates.propic = `${upload.publicUrl}?t=${Date.now()}`;
      updates.blurhashURL = prepared.image.blurhash;
    }

    if (files.resume_en) {
      const buffer = Buffer.from(await files.resume_en.arrayBuffer());
      const upload = await uploadPdfBuffer(
        admin,
        'website',
        'resumes',
        'resume_en',
        buffer
      );
      staged.push({ path: upload.path, field: 'resume_en' });
      updates.resume_en = upload.publicUrl;
    }

    if (files.resume_it) {
      const buffer = Buffer.from(await files.resume_it.arrayBuffer());
      const upload = await uploadPdfBuffer(
        admin,
        'website',
        'resumes',
        'resume_it',
        buffer
      );
      staged.push({ path: upload.path, field: 'resume_it' });
      updates.resume_it = upload.publicUrl;
    }
  } catch (stageError) {
    for (const object of staged) {
      await removeStorageObjectBestEffort(admin, 'website', object.path);
    }
    return {
      success: false,
      error:
        stageError instanceof Error
          ? stageError.message
          : 'Failed to stage files',
    };
  }

  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No changes to save' };
  }

  // 3. Trusted previous values, then a single DB commit for every staged file.
  const { data: currentRow, error: fetchError } = await admin
    .from('hero_section')
    .select('propic, resume_en, resume_it')
    .eq('id', 1)
    .single();

  if (fetchError || !currentRow) {
    for (const object of staged)
      await removeStorageObjectBestEffort(admin, 'website', object.path);
    return {
      success: false,
      error: fetchError?.message ?? 'Hero row not found',
    };
  }

  const { error: updateError } = await admin
    .from('hero_section')
    .update(updates)
    .eq('id', 1)
    .select('id')
    .single();

  if (updateError) {
    for (const object of staged) {
      await removeStorageObjectBestEffort(admin, 'website', object.path);
    }
    return { success: false, error: updateError.message };
  }

  // 4. Commit succeeded: remove the previous DB-referenced objects (never the
  //    newly committed ones). Best-effort, never throws.
  for (const object of staged) {
    const previous =
      object.field === 'propic'
        ? currentRow?.propic
        : (currentRow?.[object.field] as string | null | undefined);
    await removePublicFileIfDifferent(
      admin,
      previous ?? null,
      'website',
      object.path
    );
  }

  const revalidation = await invalidatePublicContent({
    entity: 'hero',
    operation: 'asset-update',
  });

  return { success: true, data: updates, revalidation };
}

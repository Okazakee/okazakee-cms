'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  prepareImageUpload,
  removePublicFileIfDifferent,
  requireAdmin,
  uploadPreparedImage,
  validateImageFile,
  validatePdfFile,
} from '@/app/actions/cms/utils/fileHelpers';
import { invalidateContent } from '@/libs/cms/invalidate';
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

type HeroResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

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

    invalidateContent({ entity: 'hero', operation: 'update' });

    return { success: true, data };
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
  currentImageUrl?: string,
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
    const upload = await uploadPreparedImage(
      admin,
      'website',
      'avatar/avatar',
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
      .eq('id', 1);

    if (updateError) {
      await admin.storage.from('website').remove([upload.path]);
      throw updateError;
    }

    await removePublicFileIfDifferent(
      admin,
      currentImageUrl,
      'website',
      upload.path
    );

    invalidateContent({ entity: 'hero', operation: 'asset-update' });

    return {
      success: true,
      data: { propic: propicUrl, blurhashURL: prepared.image.blurhash },
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
  supabase: SupabaseClient,
  file: File,
  field: 'resume_en' | 'resume_it',
  currentResumeUrl?: string
): Promise<HeroResult> {
  try {
    const fileValidation = validatePdfFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const fileName = `resumes/${field}.pdf`;
    const admin = getAdminClient();

    await admin.storage.from('website').remove([fileName]);

    const { error: uploadError } = await admin.storage
      .from('website')
      .upload(fileName, file, {
        cacheControl: '3600',
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = admin.storage
      .from('website')
      .getPublicUrl(fileName);

    const { error: updateError } = await admin
      .from('hero_section')
      .update({ [field]: urlData.publicUrl })
      .eq('id', 1);

    if (updateError) {
      await admin.storage.from('website').remove([fileName]);
      throw updateError;
    }

    await removePublicFileIfDifferent(
      supabase,
      currentResumeUrl,
      'website',
      fileName
    );

    invalidateContent({ entity: 'resume', operation: 'update' });

    return {
      success: true,
      data: { [field]: urlData.publicUrl },
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
  supabase: SupabaseClient,
  files: HeroFileData,
  currentData?: HeroCurrentData,
  blurhashURL?: string
): Promise<HeroResult> {
  try {
    const updates: HeroUpdateData = {};
    const resumeUpdates: Record<string, string> = {};

    // Handle profile picture upload (frontend sends mainImage, backend also accepts propic)
    const propicFile = files.propic ?? files.mainImage;
    const currentPropic = currentData?.propic ?? currentData?.mainImage;
    if (propicFile) {
      const imageResult = await uploadHeroImage(
        supabase,
        propicFile,
        currentPropic,
        blurhashURL
      );
      if (!imageResult.success) {
        return imageResult;
      }
      const imageData = imageResult.data as {
        propic: string;
        blurhashURL: string;
      };
      updates.propic = imageData.propic;
      updates.blurhashURL = imageData.blurhashURL;
    }

    // Handle resume uploads
    if (files.resume_en) {
      const resumeResult = await uploadResume(
        supabase,
        files.resume_en,
        'resume_en',
        currentData?.resume_en
      );
      if (!resumeResult.success) {
        return resumeResult;
      }
      const resumeData = resumeResult.data as { resume_en: string };
      resumeUpdates.resume_en = resumeData.resume_en;
    }

    if (files.resume_it) {
      const resumeResult = await uploadResume(
        supabase,
        files.resume_it,
        'resume_it',
        currentData?.resume_it
      );
      if (!resumeResult.success) {
        return resumeResult;
      }
      const resumeData = resumeResult.data as { resume_it: string };
      resumeUpdates.resume_it = resumeData.resume_it;
    }

    return {
      success: true,
      data: { ...updates, ...resumeUpdates },
    };
  } catch (error) {
    console.error('Error updating with files:', error);
    return {
      success: false,
      error: 'Failed to update with files',
    };
  }
}

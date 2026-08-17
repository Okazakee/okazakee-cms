'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateBlurhashFromBuffer,
  getAdminClient,
  getCmsActionContext,
  getStoragePathFromPublicUrl,
  prepareImageUpload,
  processImage,
  removePublicFileIfDifferent,
  removePublicFileIfPresent,
  requireAllowedPostWriter,
  requireAuth,
  sanitizeFilename,
  uploadPreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import { invalidateContent } from '@/libs/cms/invalidate';
import { isValidBlurhash } from '@/utils/blurhashUtils';
import { createClient } from '@/utils/supabase/server';

type BlogOperation =
  | { type: 'GET' }
  | { type: 'GET_AUTHORS' }
  | { type: 'CREATE'; data: CreateBlogData }
  | { type: 'UPDATE'; id: number; data: UpdateBlogData }
  | { type: 'DELETE'; id: number }
  | {
      type: 'UPLOAD_IMAGE_FOR_NEW_POST';
      file: File;
      titleEn: string;
      blurhashURL?: string;
    }
  | { type: 'ROLLBACK_CREATE'; postId: number; imagePath: string }
  | {
      type: 'UPLOAD_IMAGE';
      blogId: number;
      file: File;
      currentImageUrl?: string;
      blurhashURL?: string;
    }
  | {
      type: 'BATCH_PUBLISH';
      creates: Array<{
        data: CreateBlogData;
        file: File;
        blurhashURL?: string;
      }>;
      updates: Array<{
        id: number;
        data: UpdateBlogData;
        file?: File | null;
        currentImageUrl?: string;
        blurhashURL?: string;
      }>;
      deletes: number[];
    };

export type Author = {
  id: string;
  display_name: string;
  avatar_url: string | null;
};

type CreateBlogData = {
  title_en: string;
  title_it: string;
  image: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  created_at?: string;
  author_id: string;
  hidden?: boolean;
};

type UpdateBlogData = Partial<CreateBlogData>;

type BlogResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

// Validation functions
function validateBlogData(data: CreateBlogData | UpdateBlogData): {
  isValid: boolean;
  error?: string;
} {
  // Required fields validation
  if (
    data.title_en !== undefined &&
    (!data.title_en || data.title_en.trim().length === 0)
  ) {
    return { isValid: false, error: 'English title is required' };
  }

  if (
    data.title_it !== undefined &&
    (!data.title_it || data.title_it.trim().length === 0)
  ) {
    return { isValid: false, error: 'Italian title is required' };
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

  if (
    data.body_en !== undefined &&
    (!data.body_en || data.body_en.trim().length === 0)
  ) {
    return { isValid: false, error: 'English content is required' };
  }

  if (
    data.body_it !== undefined &&
    (!data.body_it || data.body_it.trim().length === 0)
  ) {
    return { isValid: false, error: 'Italian content is required' };
  }

  // Length validation
  if (data.title_en && data.title_en.length > 200) {
    return {
      isValid: false,
      error: 'English title must be less than 200 characters',
    };
  }

  if (data.title_it && data.title_it.length > 200) {
    return {
      isValid: false,
      error: 'Italian title must be less than 200 characters',
    };
  }

  if (data.description_en && data.description_en.length > 500) {
    return {
      isValid: false,
      error: 'English description must be less than 500 characters',
    };
  }

  if (data.description_it && data.description_it.length > 500) {
    return {
      isValid: false,
      error: 'Italian description must be less than 500 characters',
    };
  }

  return { isValid: true };
}

export async function blogActions(
  operation: BlogOperation
): Promise<BlogResult> {
  if (operation.type === 'BATCH_PUBLISH') {
    return await batchPublishBlog(operation);
  }

  // Auth check - reject unauthenticated requests
  try {
    await requireAuth();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getBlogData(supabase);

      case 'GET_AUTHORS':
        return await getAuthors(supabase);

      case 'CREATE':
        return await createBlog(supabase, operation.data);

      case 'UPDATE':
        return await updateBlog(supabase, operation.id, operation.data);

      case 'DELETE':
        return await deleteBlog(supabase, operation.id);

      case 'UPLOAD_IMAGE_FOR_NEW_POST':
        return await uploadBlogImageForNewPost(
          operation.file,
          operation.titleEn,
          operation.blurhashURL
        );

      case 'ROLLBACK_CREATE':
        return await rollbackBlogCreate(operation.postId, operation.imagePath);

      case 'UPLOAD_IMAGE':
        return await uploadBlogImage(
          supabase,
          operation.blogId,
          operation.file,
          operation.currentImageUrl,
          operation.blurhashURL
        );

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Blog action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function batchPublishBlog(
  operation: Extract<BlogOperation, { type: 'BATCH_PUBLISH' }>
): Promise<BlogResult> {
  try {
    const context = await getCmsActionContext('post-writer');
    const admin = getAdminClient();
    const errors: string[] = [];
    const created: unknown[] = [];
    const updated: unknown[] = [];

    for (const item of operation.creates) {
      const validation = validateBlogData(item.data);
      if (!validation.isValid) {
        errors.push(`"${item.data.title_en}": ${validation.error}`);
        continue;
      }

      const prepared = await prepareImageUpload(item.file, item.blurhashURL);
      if (!prepared.success) {
        errors.push(`"${item.data.title_en}": ${prepared.error}`);
        continue;
      }

      const sanitizedTitle = sanitizeFilename(item.data.title_en || 'untitled');
      const upload = await uploadPreparedImage(
        admin,
        'website',
        `Website Assets/blog/${Date.now()}-${sanitizedTitle}`,
        prepared.image
      );

      const insertData = {
        ...item.data,
        author_id: item.data.author_id || context.user.id,
        image: upload.publicUrl,
        blurhashURL: prepared.image.blurhash,
      };

      const { data, error } = await admin
        .from('blog_posts')
        .insert(insertData)
        .select()
        .single();

      if (error) {
        await admin.storage.from('website').remove([upload.path]);
        errors.push(`"${item.data.title_en}": ${error.message}`);
        continue;
      }

      created.push(data);
    }

    for (const item of operation.updates) {
      const validation = validateBlogData(item.data);
      if (!validation.isValid) {
        errors.push(`Update ${item.id}: ${validation.error}`);
        continue;
      }

      let uploaded: {
        publicUrl: string;
        path: string;
        blurhash: string;
      } | null = null;
      const updateData: UpdateBlogData = { ...item.data };

      if (item.file) {
        const prepared = await prepareImageUpload(item.file, item.blurhashURL);
        if (!prepared.success) {
          errors.push(`Update ${item.id}: ${prepared.error}`);
          continue;
        }
        const titleForPath = sanitizeFilename(
          item.data.title_en || `blog-${item.id}`
        );
        const upload = await uploadPreparedImage(
          admin,
          'website',
          `Website Assets/blog/${item.id}-${titleForPath}`,
          prepared.image
        );
        uploaded = {
          ...upload,
          blurhash: prepared.image.blurhash,
        };
        updateData.image = upload.publicUrl;
        updateData.blurhashURL = prepared.image.blurhash;
      }

      const { data, error } = await admin
        .from('blog_posts')
        .update(updateData)
        .eq('id', item.id)
        .select()
        .single();

      if (error) {
        if (uploaded)
          await admin.storage.from('website').remove([uploaded.path]);
        errors.push(`Update ${item.id}: ${error.message}`);
        continue;
      }

      if (uploaded && item.currentImageUrl) {
        await removePublicFileIfDifferent(
          admin,
          item.currentImageUrl,
          'website',
          uploaded.path
        );
      }

      updated.push(data);
    }

    if (operation.deletes.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('blog_posts')
        .select('id, image')
        .in('id', operation.deletes);

      if (fetchError) {
        errors.push(`Delete: ${fetchError.message}`);
      } else {
        const { error } = await admin
          .from('blog_posts')
          .delete()
          .in('id', operation.deletes);

        if (error) {
          errors.push(`Delete: ${error.message}`);
        } else {
          for (const row of existingRows || []) {
            await removePublicFileIfPresent(
              admin,
              row.image as string | null,
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
      invalidateContent({
        entity: 'blog',
        operation: 'publish',
        ids: [
          ...updated.map((r) => (r as { id: number }).id),
          ...operation.deletes,
        ],
      });
    }

    return {
      success: errors.length === 0,
      data: { created, updated },
      error: errors.length > 0 ? errors.join('\n') : undefined,
    };
  } catch (error) {
    console.error('Error batch publishing blog posts:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to publish blog posts',
    };
  }
}

async function getBlogData(supabase: SupabaseClient): Promise<BlogResult> {
  try {
    // For CMS, fetch all blog posts without limit
    const { data: blogPosts, error } = await supabase
      .from('blog_posts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Database error:', error);
      return {
        success: false,
        error: `Database error: ${error.message}`,
      };
    }

    return { success: true, data: blogPosts || [] };
  } catch (error) {
    console.error('Error fetching blog data:', error);
    return {
      success: false,
      error: `Failed to fetch blog data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function getAuthors(supabase: SupabaseClient): Promise<BlogResult> {
  try {
    // Fetch all users who have profiles (have logged in at least once)
    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('id, display_name, avatar_url')
      .order('display_name', { ascending: true });

    if (error) {
      console.error('Database error:', error);
      return {
        success: false,
        error: `Database error: ${error.message}`,
      };
    }

    return { success: true, data: profiles || [] };
  } catch (error) {
    console.error('Error fetching authors:', error);
    return {
      success: false,
      error: `Failed to fetch authors: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function createBlog(
  _supabase: SupabaseClient,
  data: CreateBlogData
): Promise<BlogResult> {
  try {
    const validation = validateBlogData(data);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const { id: userId } = await requireAllowedPostWriter();
    const insertData = {
      ...data,
      blurhashURL: data.blurhashURL ?? '',
      author_id: data.author_id || userId,
    };

    const admin = getAdminClient();
    const { data: newBlog, error } = await admin
      .from('blog_posts')
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    invalidateContent({ entity: 'blog', operation: 'create' });
    return { success: true, data: newBlog };
  } catch (error) {
    console.error('Error creating blog post:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create blog post',
    };
  }
}

async function updateBlog(
  _supabase: SupabaseClient,
  id: number,
  data: UpdateBlogData
): Promise<BlogResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const validation = validateBlogData(data);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data: existingBlog, error: fetchError } = await admin
      .from('blog_posts')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingBlog) {
      return { success: false, error: 'Blog post not found' };
    }

    const { data: updatedBlog, error } = await admin
      .from('blog_posts')
      .update(data)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    invalidateContent({ entity: 'blog', operation: 'update', id });
    return { success: true, data: updatedBlog };
  } catch (error) {
    console.error('Error updating blog post:', error);
    return {
      success: false,
      error: 'Failed to update blog post',
    };
  }
}

async function deleteBlog(
  _supabase: SupabaseClient,
  id: number
): Promise<BlogResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const admin = getAdminClient();
    const { data: existingBlog, error: fetchError } = await admin
      .from('blog_posts')
      .select('id, image')
      .eq('id', id)
      .single();

    if (fetchError || !existingBlog) {
      return { success: false, error: 'Blog post not found' };
    }

    if (existingBlog.image) {
      const imagePath = getStoragePathFromPublicUrl(
        existingBlog.image as string,
        'website'
      );
      if (imagePath) {
        await admin.storage.from('website').remove([imagePath]);
      }
    }

    const { error } = await admin.from('blog_posts').delete().eq('id', id);

    if (error) throw error;

    invalidateContent({ entity: 'blog', operation: 'delete', id });
    return { success: true };
  } catch (error) {
    console.error('Error deleting blog post:', error);
    return {
      success: false,
      error: 'Failed to delete blog post',
    };
  }
}

/** Upload image with a deterministic path (timestamp + title slug). Returns URL and blurhash for use in INSERT. */
async function uploadBlogImageForNewPost(
  file: File,
  titleEn: string,
  blurhashURL?: string
): Promise<BlogResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return {
      success: false,
      error: 'Unauthorized: You do not have permission to upload images',
    };
  }

  try {
    const fileValidation = validateImageFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();
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

    const sanitizedTitle = sanitizeFilename(titleEn || 'untitled');
    const fileName = `Website Assets/blog/${Date.now()}-${sanitizedTitle}.webp`;

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

    return {
      success: true,
      data: {
        image: urlData.publicUrl,
        blurhashURL: blurhash ?? '',
        path: fileName,
      },
    };
  } catch (error) {
    console.error('Error uploading blog image for new post:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload image',
    };
  }
}

/** Rollback a created post and its uploaded image (e.g. on apply failure). */
async function rollbackBlogCreate(
  postId: number,
  imagePath: string
): Promise<BlogResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const admin = getAdminClient();
    await admin.storage.from('website').remove([imagePath]);
    const { error } = await admin.from('blog_posts').delete().eq('id', postId);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error rolling back blog create:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Rollback failed',
    };
  }
}

async function uploadBlogImage(
  _supabase: SupabaseClient,
  blogId: number,
  file: File,
  currentImageUrl?: string,
  blurhashURL?: string
): Promise<BlogResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return {
      success: false,
      error: 'Unauthorized: You do not have permission to upload images',
    };
  }

  try {
    const fileValidation = validateImageFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();

    const { data: existingBlog, error: fetchError } = await admin
      .from('blog_posts')
      .select('id, title_en')
      .eq('id', blogId)
      .single();

    if (fetchError || !existingBlog) {
      return { success: false, error: 'Blog post not found' };
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

    const sanitizedTitle = sanitizeFilename(
      existingBlog.title_en || 'untitled'
    );
    const fileName = `Website Assets/blog/${blogId}-${sanitizedTitle}.webp`;

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

    const updateData: { image: string; blurhashURL?: string | null } = {
      image: urlData.publicUrl,
    };
    if (blurhash !== undefined) {
      updateData.blurhashURL = blurhash || null;
    }

    const { error: updateError } = await admin
      .from('blog_posts')
      .update(updateData)
      .eq('id', blogId);

    if (updateError) throw updateError;

    await removePublicFileIfDifferent(
      admin,
      currentImageUrl,
      'website',
      fileName
    );

    return {
      success: true,
      data: { image: urlData.publicUrl, blurhashURL: blurhash },
    };
  } catch (error) {
    console.error('Error uploading blog image:', error);
    return {
      success: false,
      error: 'Failed to upload blog image',
    };
  }
}

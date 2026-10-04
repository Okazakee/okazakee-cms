'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  getCmsActionContext,
  prepareImageUpload,
  removePublicFileIfDifferent,
  removePublicFileIfPresent,
  removeStorageObjectBestEffort,
  requireAllowedPostWriter,
  requireAuth,
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
        /** Client-generated temporary id; echoed back in `created`/`createdIds`. */
        tempId?: string;
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

type BlogResult = MutationResult;

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
  const evidence = emptyBatchEvidence();
  try {
    const context = await getCmsActionContext('post-writer');
    const admin = getAdminClient();

    for (const [index, item] of operation.creates.entries()) {
      const tempId = normalizeTempId(item.tempId, 'blog', index);
      const validation = validateBlogData(item.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const prepared = await prepareImageUpload(item.file, item.blurhashURL);
      if (!prepared.success) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: prepared.error ?? 'Image processing failed',
        });
        continue;
      }

      const upload = await uploadImmutablePreparedImage(
        admin,
        'website',
        'Website Assets/blog',
        item.data.title_en || 'untitled',
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
        await removeStorageObjectBestEffort(admin, 'website', upload.path);
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: error.message,
        });
        continue;
      }

      markCreated(evidence, tempId, data.id);
    }

    for (const item of operation.updates) {
      const validation = validateBlogData(item.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      let uploaded: {
        publicUrl: string;
        path: string;
        blurhash: string;
      } | null = null;
      const updateData: UpdateBlogData = { ...item.data };
      // Trusted replacement source: the previous object URL is read from the
      // DB, never trusted from the client payload, so a forged
      // `currentImageUrl` cannot delete an unrelated object.
      let previousImage: string | null = null;

      if (item.file) {
        const prepared = await prepareImageUpload(item.file, item.blurhashURL);
        if (!prepared.success) {
          markFailed(evidence, {
            kind: 'update',
            id: item.id,
            error: prepared.error ?? 'Image processing failed',
          });
          continue;
        }

        const { data: currentRow, error: fetchError } = await admin
          .from('blog_posts')
          .select('image')
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
        previousImage = (currentRow?.image as string | null) ?? null;

        const upload = await uploadImmutablePreparedImage(
          admin,
          'website',
          'Website Assets/blog',
          item.data.title_en || `blog-${item.id}`,
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
        // Remove the previous DB-referenced object only AFTER the commit.
        await removePublicFileIfDifferent(
          admin,
          previousImage,
          'website',
          uploaded.path
        );
      }

      markUpdated(evidence, data.id);
    }

    if (operation.deletes.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('blog_posts')
        .select('id, image')
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
              error: 'Blog post not found',
            });
          }
        }
        const deletable = operation.deletes.filter((id) => existingIds.has(id));
        if (deletable.length > 0) {
          const { data: deletedRows, error } = await admin
            .from('blog_posts')
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
                  error: 'Blog post was not deleted',
                });
              }
            }
            for (const row of existingRows || []) {
              if (deletedIds.has(row.id as number)) {
                await removePublicFileIfPresent(
                  admin,
                  row.image as string | null,
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
        entity: 'blog',
        operation: 'publish',
        ids: [
          ...Object.values(evidence.createdIds),
          ...evidence.updated,
          ...evidence.deleted,
        ],
      });
    }

    return {
      success: batchSucceeded(evidence),
      data: evidence,
      error: batchFailureSummary(evidence),
      revalidation,
    };
  } catch (error) {
    console.error('Error batch publishing blog posts:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to publish blog posts';
    markFailed(evidence, { kind: 'update', error: message });
    const revalidation = batchHadCommits(evidence)
      ? await invalidatePublicContent({
          entity: 'blog',
          operation: 'publish',
          ids: [
            ...Object.values(evidence.createdIds),
            ...evidence.updated,
            ...evidence.deleted,
          ],
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

    const revalidation = await invalidatePublicContent({
      entity: 'blog',
      operation: 'create',
    });
    return { success: true, data: newBlog, revalidation };
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

    const revalidation = await invalidatePublicContent({
      entity: 'blog',
      operation: 'update',
      id,
    });
    return { success: true, data: updatedBlog, revalidation };
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

    // Commit the DB delete FIRST; only then remove the Storage object
    // (best-effort). Deleting the object before the row is gone would leave
    // the row pointing at a deleted image if the DB delete failed.
    const { error } = await admin.from('blog_posts').delete().eq('id', id);

    if (error) throw error;

    await removePublicFileIfPresent(
      admin,
      existingBlog.image as string | null,
      'website'
    );

    const revalidation = await invalidatePublicContent({
      entity: 'blog',
      operation: 'delete',
      id,
    });
    return { success: true, revalidation };
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

    // Shared format-aware pipeline: extension + MIME follow the actual
    // processed format (WebP passthrough or Sharp fallback to PNG).
    const prepared = await prepareImageUpload(file, blurhashURL);
    if (!prepared.success) {
      return {
        success: false,
        error: prepared.error,
      };
    }

    const upload = await uploadImmutablePreparedImage(
      admin,
      'website',
      'Website Assets/blog',
      titleEn || 'untitled',
      prepared.image
    );

    return {
      success: true,
      data: {
        image: upload.publicUrl,
        blurhashURL: prepared.image.blurhash,
        path: upload.path,
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
    // The row is the authoritative state: delete it first, then remove the
    // uploaded image best-effort. Storage-first would leave a surviving row
    // pointing at a deleted object if the DB delete failed.
    const { error } = await admin.from('blog_posts').delete().eq('id', postId);
    if (error) throw error;
    await removeStorageObjectBestEffort(admin, 'website', imagePath);
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
  _currentImageUrl?: string,
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
      .select('id, title_en, image')
      .eq('id', blogId)
      .single();

    if (fetchError || !existingBlog) {
      return { success: false, error: 'Blog post not found' };
    }

    // Shared format-aware pipeline: extension + MIME follow the actual
    // processed format (WebP passthrough or Sharp fallback to PNG).
    const prepared = await prepareImageUpload(file, blurhashURL);
    if (!prepared.success) {
      return {
        success: false,
        error: prepared.error,
      };
    }

    // Unique immutable path: the new object never overwrites the previous one,
    // so a failed DB update can never leave the row pointing at a deleted
    // object. The previous DB-referenced object is removed AFTER the commit,
    // using the trusted DB value rather than the client payload.
    const upload = await uploadImmutablePreparedImage(
      admin,
      'website',
      'Website Assets/blog',
      existingBlog.title_en || `blog-${blogId}`,
      prepared.image
    );

    const updateData: { image: string; blurhashURL?: string | null } = {
      image: upload.publicUrl,
    };
    updateData.blurhashURL = prepared.image.blurhash || null;

    const { error: updateError } = await admin
      .from('blog_posts')
      .update(updateData)
      .eq('id', blogId)
      .select('id')
      .single();

    if (updateError) {
      // Best-effort staged cleanup must never mask the DB error.
      await removeStorageObjectBestEffort(admin, 'website', upload.path);
      throw updateError;
    }

    await removePublicFileIfDifferent(
      admin,
      existingBlog.image,
      'website',
      upload.path
    );

    const revalidation = await invalidatePublicContent({
      entity: 'blog',
      operation: 'asset-update',
      id: blogId,
    });

    return {
      success: true,
      data: { image: upload.publicUrl, blurhashURL: prepared.image.blurhash },
      revalidation,
    };
  } catch (error) {
    console.error('Error uploading blog image:', error);
    return {
      success: false,
      error: 'Failed to upload blog image',
    };
  }
}

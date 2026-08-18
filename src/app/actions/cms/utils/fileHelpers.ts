import type { SupabaseClient } from '@supabase/supabase-js';
import { encode as blurkitEncode } from 'blurkit/node';
import { findAllowedCmsUser, getUserGithubUsername } from './auth';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { createClient } from '@/utils/supabase/server';
import { FALLBACK_BLURHASH, isValidBlurhash } from '@/utils/blurhashUtils';

// Pure validation helpers live in @/utils/cms/validation (unit-tested).
// Re-exported here to keep every existing call site unchanged.
import {
  getStoragePathFromPublicUrl,
  isValidContactUrl,
  isValidDate,
  isValidHttpUrl,
  isValidUrl,
  sanitizeFilename,
  validateImageFile,
  validatePdfFile,
} from '@/utils/cms/validation';

export {
  getStoragePathFromPublicUrl,
  isValidContactUrl,
  isValidDate,
  isValidHttpUrl,
  isValidUrl,
  sanitizeFilename,
  validateImageFile,
  validatePdfFile,
};

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

type CmsActionRole = 'authenticated' | 'admin' | 'post-writer';

export type CmsActionContext = {
  supabase: ServerSupabaseClient;
  user: { id: string; email: string; githubUsername: string | null };
  role: string | null;
};

export async function getCmsActionContext(
  requiredRole: CmsActionRole = 'authenticated'
): Promise<CmsActionContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error('Unauthorized: Authentication required');
  }

  const githubUsername = getUserGithubUsername(user);
  const role =
    requiredRole === 'authenticated'
      ? null
      : (await findAllowedCmsUser(supabase, user.email, githubUsername))
          ?.role || null;

  if (requiredRole === 'admin' && role !== 'admin') {
    throw new Error('Unauthorized: Admin access required');
  }

  if (
    requiredRole === 'post-writer' &&
    !CMS_POST_WRITER_ROLES.includes(
      role as (typeof CMS_POST_WRITER_ROLES)[number]
    )
  ) {
    throw new Error(
      'Unauthorized: You do not have permission to create or edit posts'
    );
  }

  return {
    supabase,
    user: {
      id: user.id,
      email: user.email || '',
      githubUsername,
    },
    role,
  };
}

/**
 * Verifies the user is authenticated before allowing CMS operations.
 * Delegates to the canonical authorization implementation.
 */
export async function requireAuth(): Promise<{ id: string; email: string }> {
  const context = await getCmsActionContext();
  return { id: context.user.id, email: context.user.email };
}

/**
 * Verifies the user is an admin before allowing admin-only CMS operations.
 * Delegates to the canonical authorization implementation.
 */
export async function requireAdmin(): Promise<{ id: string; email: string }> {
  const context = await getCmsActionContext('admin');
  return { id: context.user.id, email: context.user.email };
}

/** Roles that are allowed to create/update blog and portfolio posts (must match RLS if using JWT role) */
const CMS_POST_WRITER_ROLES = ['admin', 'editor'] as const;

/**
 * Verifies the user is in cms_allowed_users with a role that can create posts.
 * Use this before INSERT on blog_posts/portfolio_posts when RLS expects JWT role (which we don't set).
 * Delegates to the canonical authorization implementation.
 */
export async function requireAllowedPostWriter(): Promise<{
  id: string;
  email: string;
  role: string;
}> {
  const context = await getCmsActionContext('post-writer');
  return {
    id: context.user.id,
    email: context.user.email,
    role: context.role ?? '',
  };
}

/**
 * Service-role Supabase client. Use only in server code after validating the request (e.g. requireAllowedPostWriter).
 * Bypasses RLS. Canonical implementation: src/libs/cms/supabase/admin.ts
 */
export function getAdminClient(): SupabaseClient {
  return getCmsAdminClient();
}

/**
 * Result type for auth check - use this in actions
 */
export type AuthResult =
  | { authenticated: true; userId: string }
  | { authenticated: false; error: string };

const DEFAULT_MAX_HEIGHT = 1080;
const DEFAULT_WEBP_QUALITY = 80;

type ProcessImageOptions = {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
};

type ProcessImageResult = {
  success: boolean;
  buffer?: Buffer;
  width?: number;
  height?: number;
  blurhash?: string;
  format?: 'webp' | 'png'; // Format actually used
  error?: string;
};

type PreparedImageUpload = {
  buffer: Buffer;
  blurhash: string;
  extension: 'webp' | 'png';
  contentType: 'image/webp' | 'image/png';
};

/**
 * Processes an image: resize to max dimensions, convert to WebP
 * Returns the processed buffer and metadata
 */
export async function processImage(
  file: File,
  options?: ProcessImageOptions
): Promise<ProcessImageResult> {
  // Lazy-load sharp: importing it statically pulls the native addon into the
  // module graph of every CMS action (dashboard boot included). Dynamic
  // import keeps the addon out of the critical path.
  const sharp = (await import('sharp')).default;
  try {
    const maxWidth = options?.maxWidth;
    const maxHeight = options?.maxHeight || DEFAULT_MAX_HEIGHT;
    const quality = options?.quality || DEFAULT_WEBP_QUALITY;

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    let pipeline = sharp(inputBuffer);

    if (maxWidth && maxHeight) {
      pipeline = pipeline.resize(maxWidth, maxHeight, {
        fit: 'cover',
        position: 'center',
      });
    } else {
      const metadata = await sharp(inputBuffer).metadata();
      if ((metadata.height || 0) > maxHeight) {
        pipeline = pipeline.resize(undefined, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
    }

    let processedBuffer: Buffer;
    let format: 'webp' | 'png' = 'webp';
    try {
      processedBuffer = await pipeline.webp({ quality }).toBuffer();
    } catch {
      processedBuffer = await pipeline.png().toBuffer();
      format = 'png';
    }

    const { hash: blurhash } = await blurkitEncode(inputBuffer, { size: 32 });

    const outMeta = await sharp(processedBuffer).metadata();

    return {
      success: true,
      buffer: processedBuffer,
      width: outMeta.width,
      height: outMeta.height,
      blurhash,
      format,
    };
  } catch (error) {
    console.error('Error processing image:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process image',
    };
  }
}

/**
 * Generates a blurhash from a raw image Buffer (e.g. a pre-processed WebP).
 */
export async function generateBlurhashFromBuffer(
  buffer: Buffer
): Promise<string> {
  try {
    const { hash } = await blurkitEncode(buffer, { size: 32 });
    return hash;
  } catch {
    return FALLBACK_BLURHASH;
  }
}

export async function prepareImageUpload(
  file: File,
  blurhashURL?: string,
  options?: ProcessImageOptions
): Promise<
  | { success: true; image: PreparedImageUpload }
  | { success: false; error: string }
> {
  const validation = validateImageFile(file);
  if (!validation.isValid) {
    return { success: false, error: validation.error || 'Invalid image file' };
  }

  if (file.type === 'image/webp') {
    const buffer = Buffer.from(await file.arrayBuffer());
    const blurhash = isValidBlurhash(blurhashURL)
      ? blurhashURL
      : await generateBlurhashFromBuffer(buffer);

    return {
      success: true,
      image: {
        buffer,
        blurhash,
        extension: 'webp',
        contentType: 'image/webp',
      },
    };
  }

  const processed = await processImage(file, options);
  if (!processed.success || !processed.buffer) {
    return {
      success: false,
      error: processed.error || 'Failed to process image',
    };
  }

  return {
    success: true,
    image: {
      buffer: processed.buffer,
      blurhash: isValidBlurhash(blurhashURL)
        ? blurhashURL
        : processed.blurhash || FALLBACK_BLURHASH,
      extension: processed.format ?? 'webp',
      contentType: processed.format === 'png' ? 'image/png' : 'image/webp',
    },
  };
}

export async function uploadPreparedImage(
  supabase: SupabaseClient,
  bucket: string,
  pathWithoutExtension: string,
  prepared: PreparedImageUpload
): Promise<{ publicUrl: string; path: string }> {
  const path = `${pathWithoutExtension}.${prepared.extension}`;
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, prepared.buffer, {
      cacheControl: '3600',
      contentType: prepared.contentType,
      upsert: true,
    });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

/**
 * Best-effort removal of a Storage object. NEVER throws: after a DB write has
 * committed, a failing storage cleanup must not fail the mutation (the
 * orphaned object is harmless; a broken DB reference is not).
 */
export async function removeStorageObjectBestEffort(
  supabase: SupabaseClient,
  bucket: string,
  filePath: string
): Promise<void> {
  try {
    const { error } = await supabase.storage.from(bucket).remove([filePath]);
    if (error) {
      console.error(`Failed to remove storage object ${filePath}:`, error);
    }
  } catch (error) {
    console.error(`Failed to remove storage object ${filePath}:`, error);
  }
}

/**
 * Best-effort removal of the file behind a public URL, if it exists.
 * Never throws — see removeStorageObjectBestEffort.
 */
export async function removePublicFileIfPresent(
  supabase: SupabaseClient,
  fileUrl: string | null | undefined,
  bucket: string
): Promise<void> {
  if (!fileUrl) return;
  const filePath = getStoragePathFromPublicUrl(fileUrl, bucket);
  if (!filePath) return;
  await removeStorageObjectBestEffort(supabase, bucket, filePath);
}

/**
 * Best-effort removal of the file behind a public URL when it differs from
 * the newly stored path (e.g. a previous format variant). Never throws.
 */
export async function removePublicFileIfDifferent(
  supabase: SupabaseClient,
  fileUrl: string | null | undefined,
  bucket: string,
  nextPath: string
): Promise<void> {
  if (!fileUrl) return;
  const filePath = getStoragePathFromPublicUrl(fileUrl, bucket);
  if (!filePath || filePath === nextPath) return;
  await removeStorageObjectBestEffort(supabase, bucket, filePath);
}

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encode as blurkitEncode } from 'blurkit/node';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
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
import { getCmsStorageOrigin } from '@/libs/cms/storage/bucket';
import { isAnimatedWebpBytes } from '@/utils/cms/webpAnimation';
import { createClient } from '@/utils/supabase/server';
import {
  findAllowedCmsUser,
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
} from './auth';

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

type CmsActionRole = 'authenticated' | 'allowlisted' | 'admin' | 'post-writer';

export type CmsActionContext = {
  supabase: ServerSupabaseClient;
  user: {
    id: string;
    email: string;
    githubUserId: string | null;
    githubUsername: string | null;
  };
  role: string | null;
};

export async function getCmsActionContext(
  requiredRole: CmsActionRole = 'allowlisted'
): Promise<CmsActionContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error('Unauthorized: Authentication required');
  }

  const githubUserId = getUserGithubId(user);
  const verifiedEmail = getVerifiedUserEmail(user);
  // Display-only handle from the verified identity; never user_metadata.
  const githubUsername = getUserGithubUsername(user);
  // Trust boundary: the session client authenticates the requester
  // (auth.getUser() above). The CMS role lookup must go through the
  // service_role admin client — authenticated has no SELECT on
  // cms_allowed_users since the hardening (anon/authenticated = no access).
  // Order: githubUserID -> verified-email (returns immediately) -> legacy
  // display handle. No user_metadata trust anywhere.
  const role =
    requiredRole === 'authenticated'
      ? null
      : (
          await findAllowedCmsUser(getCmsAdminClient(), {
            email: verifiedEmail,
            githubUserId,
            githubUsernameLegacy: githubUsername,
          })
        )?.role || null;

  if (requiredRole === 'allowlisted' && !role) {
    throw new Error('Unauthorized: You are not allowlisted for the CMS');
  }

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
      githubUserId,
      githubUsername,
    },
    role,
  };
}

/**
 * Verifies the user is authenticated AND allowlisted before allowing CMS
 * operations. Authentication alone is not authorization: an authenticated
 * Supabase account that is not in cms_allowed_users must not reach CMS data.
 * Delegates to the canonical authorization implementation.
 */
export async function requireAuth(): Promise<{ id: string; email: string }> {
  const context = await getCmsActionContext('allowlisted');
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

/**
 * Animated WebP is decoded frame-by-frame into a single tall surface, so the
 * total decoded pixel count is capped before libvips touches any frame
 * (~128 MB as RGBA). A 512x512 animation still fits ~120 frames; a larger
 * upload is rejected instead of risking an OOM in the serverless function.
 */
const MAX_ANIMATED_DECODED_PIXELS = 32 * 1024 * 1024;

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
 *
 * Animated WebP keeps every frame: sharp is told to read all pages and the
 * resize is applied per frame (libvips honours the animation's page height).
 * An animation that already fits the requested bounds is returned unchanged,
 * since re-encoding it would only add generation loss.
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
    const animated = isAnimatedWebpBytes(inputBuffer);

    // Container metadata only (no frame decode): page dimensions and frame
    // count are enough for both guards below.
    const metadata = await sharp(inputBuffer).metadata();
    const pageWidth = metadata.width || 0;
    const pageHeight = metadata.height || 0;
    const pages = metadata.pages || 1;

    if (animated) {
      if (pageWidth * pageHeight * pages > MAX_ANIMATED_DECODED_PIXELS) {
        return {
          success: false,
          error:
            'Animated image is too large to process (over 32 megapixels across all frames). Please export a smaller animation.',
        };
      }

      if (
        (!maxWidth || pageWidth <= maxWidth) &&
        (!maxHeight || pageHeight <= maxHeight)
      ) {
        return {
          success: true,
          buffer: inputBuffer,
          width: pageWidth,
          height: pageHeight,
          blurhash: await generateBlurhashFromBuffer(inputBuffer),
          format: 'webp',
        };
      }
    }

    let pipeline = sharp(inputBuffer, { animated });

    if (maxWidth && maxHeight) {
      pipeline = pipeline.resize(maxWidth, maxHeight, {
        fit: 'cover',
        position: 'center',
      });
    } else if (pageHeight > maxHeight) {
      pipeline = pipeline.resize(undefined, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      });
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

    // Static WebP is already the canonical upload format (the browser canvas
    // pipeline wrote it), so it is stored as-is: re-encoding would only add
    // generation loss. Animated WebP is NOT passed through here — it falls
    // through to processImage(), which keeps every frame while resizing.
    if (!isAnimatedWebpBytes(buffer)) {
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

/**
 * Builds a unique, immutable storage path (without extension) for a new asset:
 * `<prefix>/<timestamp>-<random>-<sanitized-label>`. Because every upload gets
 * a fresh path, an upload can never overwrite an existing object, so a failed
 * DB write leaves the previous DB-referenced object untouched.
 */
export function buildUniqueAssetPath(prefix: string, label?: string): string {
  const safeLabel = sanitizeFilename(label || 'file').slice(0, 40);
  const stamp = Date.now();
  const random = randomUUID();
  return `${prefix}/${stamp}-${random}-${safeLabel}`;
}

/**
 * Uploads a prepared image to a freshly generated unique path. Never upserts:
 * an existing object is never overwritten. Returns the stored path so callers
 * can remove it if the subsequent DB write fails.
 */
export async function uploadImmutablePreparedImage(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string,
  label: string | undefined,
  prepared: PreparedImageUpload
): Promise<{ publicUrl: string; path: string }> {
  const path = `${buildUniqueAssetPath(prefix, label)}.${prepared.extension}`;
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, prepared.buffer, {
      cacheControl: '3600',
      contentType: prepared.contentType,
      upsert: false,
    });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

/**
 * Uploads a PDF to a freshly generated unique path. Immutable for the same
 * reason as uploadImmutablePreparedImage.
 */
export async function uploadPdfBuffer(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string,
  label: string | undefined,
  buffer: Buffer
): Promise<{ publicUrl: string; path: string }> {
  const path = `${buildUniqueAssetPath(prefix, label)}.pdf`;
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    cacheControl: '3600',
    contentType: 'application/pdf',
    upsert: false,
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
 * Strict origin + exact bucket-prefix match; cross-bucket/cross-origin
 * URLs are a no-op. Never throws — see removeStorageObjectBestEffort.
 */
export async function removePublicFileIfPresent(
  supabase: SupabaseClient,
  fileUrl: string | null | undefined,
  bucket: string,
  origin?: string
): Promise<void> {
  if (!fileUrl) return;
  let resolved = origin;
  if (!resolved) {
    try {
      resolved = getCmsStorageOrigin();
    } catch {
      return;
    }
  }
  const filePath = getStoragePathFromPublicUrl(fileUrl, bucket, resolved);
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
  nextPath: string,
  origin?: string
): Promise<void> {
  if (!fileUrl) return;
  let resolved = origin;
  if (!resolved) {
    try {
      resolved = getCmsStorageOrigin();
    } catch {
      return;
    }
  }
  const filePath = getStoragePathFromPublicUrl(fileUrl, bucket, resolved);
  if (!filePath || filePath === nextPath) return;
  await removeStorageObjectBestEffort(supabase, bucket, filePath);
}

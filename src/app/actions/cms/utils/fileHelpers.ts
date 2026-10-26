import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encode as blurkitEncode } from 'blurkit/node';
import { getCmsStorageOrigin } from '@/libs/cms/storage/bucket';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import {
  FALLBACK_BLUR_DATA_URL,
  isValidBlurPlaceholder,
} from '@/utils/blurhashUtils';
// Pure validation helpers live in @/utils/cms/validation (unit-tested).
// Re-exported here to keep every existing call site unchanged.
import {
  getStoragePathFromPublicUrl,
  isValidContactUrl,
  isValidDate,
  isValidHttpUrl,
  isValidUrl,
  sanitizeFilename,
  validateImageBytes,
  validateImageFile,
  validateImageFileContent,
  validatePdfBytes,
  validatePdfFile,
  validatePdfFileContent,
} from '@/utils/cms/validation';
import { type CmsRole, isCmsAdminRole } from '@/utils/cms/roles';
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
  validateImageBytes,
  validateImageFile,
  validateImageFileContent,
  validatePdfBytes,
  validatePdfFile,
  validatePdfFileContent,
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
  role: CmsRole | null;
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
  const role: CmsRole | null =
    requiredRole === 'authenticated'
      ? null
      : ((
          await findAllowedCmsUser(getCmsAdminClient(), {
            email: verifiedEmail,
            githubUserId,
            githubUsernameLegacy: githubUsername,
          })
        )?.role ?? null);

  if (requiredRole === 'allowlisted' && !role) {
    throw new Error('Unauthorized: You are not allowlisted for the CMS');
  }

  if (requiredRole === 'admin' && !isCmsAdminRole(role)) {
    throw new Error('Unauthorized: Admin access required');
  }

  if (
    requiredRole === 'post-writer' &&
    !(role !== null && CMS_POST_WRITER_ROLES.includes(role))
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

/**
 * Roles that are allowed to create/update blog and portfolio posts (must match
 * RLS if using JWT role). Superadmin is a superset of admin and must keep every
 * editorial permission. Role policy is owned by `@/utils/cms/roles`.
 */
const CMS_POST_WRITER_ROLES: readonly CmsRole[] = [
  'superadmin',
  'admin',
  'editor',
];

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
 * Fixed, user-safe failure for bytes that pass the container checks but cannot
 * be decoded by libwebp. Shared by the static passthrough and the animated
 * fits-bounds passthrough so both report the same contract.
 */
const UNDECODABLE_WEBP_ERROR =
  'The image data could not be decoded as WebP. Please re-export the image and try again.';

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
  /**
   * How the requested box is filled. `cover` (default) crops to the exact
   * bounds, which suits portrait/thumbnail targets; `inside` fits the whole
   * image within the bounds and keeps its aspect ratio for wide assets such as
   * header logos.
   */
  fit?: 'cover' | 'inside';
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
 * An animation that already fits the requested bounds is returned unchanged
 * (after every frame is proven decodable), since re-encoding it would only add
 * generation loss.
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
        // The animation is returned byte-for-byte, so every frame — not just
        // the first — must decode. Container metadata (and even the first
        // frame) can be fine while a later ANMF frame is corrupt. The 32 MPx
        // guard above bounds this decode; an oversized animation never gets
        // here and is re-encoded in full below instead.
        if (!(await canDecodeWebp(inputBuffer, { animated: true }))) {
          return { success: false, error: UNDECODABLE_WEBP_ERROR };
        }

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

    if (maxWidth && maxHeight && options?.fit === 'inside') {
      // Contain: fit the whole image inside the bounds and never enlarge it,
      // so a wide logo is not centre-cropped into a fixed box.
      pipeline = pipeline.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    } else if (maxWidth && maxHeight) {
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

    const { dataURL: blurhash } = await blurkitEncode(inputBuffer, {
      size: 32,
    });

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
 * Generates a ready-to-use blur placeholder data URL from a raw image
 * Buffer (e.g. a pre-processed WebP).
 */
export async function generateBlurhashFromBuffer(
  buffer: Buffer
): Promise<string> {
  try {
    const { dataURL } = await blurkitEncode(buffer, { size: 32 });
    return dataURL;
  } catch {
    return FALLBACK_BLUR_DATA_URL;
  }
}

/**
 * Proves libwebp can actually decode WebP bytes that are about to be stored
 * verbatim. The full RIFF/chunk walk in `validateImageBytes` only validates
 * container structure: a well-formed `VP8 `/`VP8L`/`ANMF` container may still
 * hold a bitstream no decoder accepts, and both passthroughs never re-encode,
 * so structural validity alone would store it. A 1x1 raw derivative forces a
 * real decode while its output buffer stays tiny — no encoder pass and no
 * full-size raw output. `animated: true` decodes every frame, which is what an
 * unchanged animation requires. Sharp's defaults stay in effect, including
 * `failOn: 'warning'` and `limitInputPixels`, so the decode is no more
 * permissive than `processImage`'s own resize decode.
 */
async function canDecodeWebp(
  buffer: Buffer,
  options?: { animated?: boolean }
): Promise<boolean> {
  // Lazy import, like processImage: keeps the native addon out of the module
  // graph of every CMS action.
  const sharp = (await import('sharp')).default;
  try {
    await sharp(buffer, { animated: options?.animated === true })
      .resize({
        width: 1,
        height: 1,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer();
    return true;
  } catch {
    return false;
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

  // Authoritative byte check: signature, declared-MIME agreement and trailer
  // completeness run before any buffer is processed or stored.
  const content = await validateImageFileContent(file);
  if (!content.isValid) {
    return { success: false, error: content.error || 'Invalid image file' };
  }

  if (file.type === 'image/webp') {
    const buffer = Buffer.from(await file.arrayBuffer());

    // The passthrough branch stores client bytes verbatim, so the full RIFF
    // container (declared size + chunk walk) is verified first.
    const byteValidation = validateImageBytes(buffer, file.type);
    if (!byteValidation.isValid) {
      return {
        success: false,
        error: byteValidation.error || 'Invalid image file',
      };
    }

    // Static WebP is already the canonical upload format (the browser canvas
    // pipeline wrote it), so it is stored as-is: re-encoding would only add
    // generation loss. Animated WebP is NOT passed through here — it falls
    // through to processImage(), which keeps every frame while resizing.
    if (!isAnimatedWebpBytes(buffer)) {
      // Byte-for-byte storage means the container walk above is not enough:
      // the VP8/VP8L bitstream itself must decode. A supplied placeholder
      // never counts as proof.
      if (!(await canDecodeWebp(buffer))) {
        return { success: false, error: UNDECODABLE_WEBP_ERROR };
      }

      const blurhash = isValidBlurPlaceholder(blurhashURL)
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
      blurhash: isValidBlurPlaceholder(blurhashURL)
        ? blurhashURL
        : processed.blurhash || FALLBACK_BLUR_DATA_URL,
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
  // Header/trailer completeness before the write: a spoofed or truncated
  // document must never become a public resume link.
  const content = validatePdfBytes(buffer);
  if (!content.isValid) {
    throw new Error(content.error ?? 'Please select a valid PDF file');
  }

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

/**
 * Server-side copy of a Storage object within one bucket. Returns the
 * destination path on success, null on failure. Never throws: callers fall
 * back to the source path (which stays valid) when the copy fails.
 */
export async function copyStorageObjectBestEffort(
  supabase: SupabaseClient,
  bucket: string,
  fromPath: string,
  toPath: string
): Promise<string | null> {
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .copy(fromPath, toPath);
    if (error) {
      console.error(
        `Failed to copy storage object ${fromPath} to ${toPath}:`,
        error
      );
      return null;
    }
    return toPath;
  } catch (error) {
    console.error(
      `Failed to copy storage object ${fromPath} to ${toPath}:`,
      error
    );
    return null;
  }
}

/**
 * Moves a staged pre-insert upload into its per-post folder after the row
 * commits: copies `<stagedPath>` to `<prefix>/<staged-basename>`, removes the
 * staged object best-effort, and returns the final public URL + path.
 * Returns null (row keeps pointing at the staged object, which stays valid)
 * when the copy fails. Never throws.
 */
export async function finalizeStagedPostImage(
  supabase: SupabaseClient,
  bucket: string,
  stagedPath: string,
  prefix: string
): Promise<{ publicUrl: string; path: string } | null> {
  const tail = stagedPath.split('/').pop() ?? '';
  if (!tail) return null;
  const finalPath = `${prefix}/${tail}`;
  if (finalPath === stagedPath) return null;
  const copied = await copyStorageObjectBestEffort(
    supabase,
    bucket,
    stagedPath,
    finalPath
  );
  if (!copied) return null;
  await removeStorageObjectBestEffort(supabase, bucket, stagedPath);
  const { data } = supabase.storage.from(bucket).getPublicUrl(finalPath);
  return { publicUrl: data.publicUrl, path: finalPath };
}

/**
 * Best-effort removal of every object under a prefix (e.g. `blog/<id>` when
 * its post is deleted). Never throws: a surviving orphan is harmless, a
 * thrown cleanup is not.
 */
export async function removePrefixBestEffort(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string
): Promise<void> {
  try {
    const paths: string[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .list(prefix, { limit, offset });
      if (error || !data || data.length === 0) break;
      for (const entry of data) {
        const name = (entry as { name: string }).name;
        if (!name) continue;
        const id = (entry as { id: string | null }).id;
        if (id === null || id === undefined) {
          await removePrefixBestEffort(supabase, bucket, `${prefix}/${name}`);
        } else {
          paths.push(`${prefix}/${name}`);
        }
      }
      if (data.length < limit) break;
      offset += limit;
    }
    for (let i = 0; i < paths.length; i += 100) {
      try {
        const { error: removeError } = await supabase.storage
          .from(bucket)
          .remove(paths.slice(i, i + 100));
        if (removeError) {
          console.error(
            `Failed to remove storage objects under ${prefix}:`,
            removeError
          );
        }
      } catch (error) {
        console.error(
          `Failed to remove storage objects under ${prefix}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error(`Failed to remove storage prefix ${prefix}:`, error);
  }
}

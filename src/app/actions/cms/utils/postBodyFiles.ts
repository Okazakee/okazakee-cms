/**
 * Server-side body-image pipeline for post publish (server-only: shares
 * the service-role upload helpers with the cover flow).
 *
 * Editing is blob-staged on the client (zero server writes until Publish),
 * so this module owns the commit side:
 * - validate staged files + pending-ref resolution before any upload;
 * - upload into the post folder and rewrite `pending:<id>` refs to
 *   `![alt-blurhash](publicUrl)`;
 * - roll back staged objects when the row write fails;
 * - best-effort removal of body objects the new markdown no longer
 *   references (cover paths are always kept).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  committedImageMarkdown,
  parseBodyImages,
  rewritePendingRef,
  sanitizeImageAlt,
  validateBodyImages,
  type BodyImageUpload,
} from '@/utils/cms/postBody';
import { getStoragePathFromPublicUrl } from '@/utils/cms/validation';
import {
  prepareImageUpload,
  removeStorageObjectBestEffort,
  uploadImmutablePreparedImage,
} from './fileHelpers';

export const MAX_BODY_IMAGES_PER_PUBLISH = 20;

const BODY_IMAGE_OPTIONS = {
  maxWidth: 1920,
  maxHeight: 1920,
  quality: 82,
  fit: 'inside' as const,
};

/**
 * Fails fast before any upload: file count/duplicates plus pending-ref
 * resolution and image-line structure across both bodies.
 */
export function validateBodyImagePayload(
  files: BodyImageUpload[] | undefined,
  bodies: Array<string | undefined>
): string | null {
  const list = files ?? [];
  if (list.length > MAX_BODY_IMAGES_PER_PUBLISH) {
    return `At most ${MAX_BODY_IMAGES_PER_PUBLISH} body images per publish`;
  }
  const seen = new Set<string>();
  for (const item of list) {
    if (!item.localId || seen.has(item.localId)) {
      return 'Duplicate body image reference';
    }
    seen.add(item.localId);
    if (!item.file) return 'Body image file is missing';
  }
  const pending = new Set<string>();
  for (const body of bodies) {
    if (!body) continue;
    for (const ref of parseBodyImages(body)) {
      if (ref.pendingId) pending.add(ref.pendingId);
    }
  }
  for (const id of pending) {
    if (!seen.has(id)) {
      return 'A body image was removed before publish; re-insert it';
    }
  }
  for (const body of bodies) {
    if (!body) continue;
    const issues = validateBodyImages(body, seen);
    if (issues.length > 0) {
      const first = issues[0];
      if (first) {
        return `Body image syntax error (line ${first.line}): ${first.message}`;
      }
    }
  }
  return null;
}

/**
 * Upload failure that still carries the objects staged before the throw,
 * so callers can roll every one of them back instead of orphaning the
 * ones that succeeded.
 */
export class BodyUploadError extends Error {
  staged: string[];
  constructor(message: string, staged: string[]) {
    super(message);
    this.name = 'BodyUploadError';
    this.staged = staged;
  }
}

/** Staged paths carried by a BodyUploadError (empty for other errors). */
export function bodyUploadStaged(error: unknown): string[] {
  return error instanceof BodyUploadError ? error.staged : [];
}

/**
 * Uploads staged body images into the post folder. Throws BodyUploadError
 * on the first failure — callers remove every staged path it carries and
 * commit nothing.
 */
export async function uploadBodyImages(
  admin: SupabaseClient,
  bucket: string,
  prefix: string,
  label: string,
  files: BodyImageUpload[] | undefined
): Promise<{ rewrites: Map<string, string>; staged: string[] }> {
  const rewrites = new Map<string, string>();
  const staged: string[] = [];
  try {
    for (const item of files ?? []) {
      const prepared = await prepareImageUpload(
        item.file,
        item.blurhash,
        BODY_IMAGE_OPTIONS
      );
      if (!prepared.success) {
        throw new Error(prepared.error ?? 'Body image processing failed');
      }
      const alt = sanitizeImageAlt(item.alt, label);
      const upload = await uploadImmutablePreparedImage(
        admin,
        bucket,
        prefix,
        alt,
        prepared.image
      );
      staged.push(upload.path);
      rewrites.set(
        item.localId,
        committedImageMarkdown(alt, prepared.image.blurhash, upload.publicUrl)
      );
    }
  } catch (error) {
    throw new BodyUploadError(
      error instanceof Error ? error.message : 'Body image upload failed',
      staged
    );
  }
  return { rewrites, staged };
}

/** Applies upload rewrites to both locale bodies. */
export function applyBodyImageRewrites(
  bodies: { body_en?: string; body_it?: string },
  rewrites: Map<string, string>
): { body_en?: string; body_it?: string } {
  const rewriteOne = (body: string | undefined): string | undefined => {
    if (!body) return body;
    let next = body;
    for (const [localId, committed] of rewrites) {
      next = rewritePendingRef(next, localId, committed);
    }
    return next;
  };
  return {
    ...bodies,
    body_en: rewriteOne(bodies.body_en),
    body_it: rewriteOne(bodies.body_it),
  };
}

/** Best-effort removal of staged objects after a failed row write. */
export async function removeBodyUploads(
  admin: SupabaseClient,
  bucket: string,
  staged: string[]
): Promise<void> {
  for (const path of staged) {
    await removeStorageObjectBestEffort(admin, bucket, path);
  }
}

/**
 * Removes body objects under the post prefix that the new markdown no
 * longer references. Keeps the cover paths and anything still referenced;
 * ignores external/cross-bucket URLs. Never throws.
 */
export async function cleanupOrphanedBodyImages(
  admin: SupabaseClient,
  bucket: string,
  origin: string,
  prefix: string,
  oldBodies: Array<string | undefined>,
  newBodies: Array<string | undefined>,
  keepUrls: Array<string | null | undefined>
): Promise<void> {
  try {
    const collect = (bodies: Array<string | undefined>): Set<string> => {
      const paths = new Set<string>();
      for (const body of bodies) {
        if (!body) continue;
        for (const ref of parseBodyImages(body)) {
          if (ref.pending) continue;
          const path = getStoragePathFromPublicUrl(ref.url, bucket, origin);
          if (path?.startsWith(`${prefix}/`)) paths.add(path);
        }
      }
      return paths;
    };
    const oldPaths = collect(oldBodies);
    if (oldPaths.size === 0) return;
    const newPaths = collect(newBodies);
    const keep = new Set<string>();
    for (const url of keepUrls) {
      if (!url) continue;
      const path = getStoragePathFromPublicUrl(url, bucket, origin);
      if (path) keep.add(path);
    }
    for (const path of oldPaths) {
      if (!newPaths.has(path) && !keep.has(path)) {
        await removeStorageObjectBestEffort(admin, bucket, path);
      }
    }
  } catch (error) {
    console.error('Body orphan cleanup failed (best-effort):', error);
  }
}

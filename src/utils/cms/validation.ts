/**
 * Pure CMS validation helpers.
 *
 * Extracted from `src/app/actions/cms/utils/fileHelpers.ts` during the CMS
 * decoupling (Phase 1) so they can be unit-tested without pulling in
 * Supabase/Sharp/next server code. fileHelpers re-exports these to keep all
 * existing call sites unchanged.
 */

import {
  detectRasterFormat,
  FILE_HEADER_BYTES,
  FILE_TAIL_BYTES,
  gifHasTrailer,
  hasPdfHeader,
  hasPdfTrailer,
  hasWebpImageChunkHeader,
  imageFormatForMime,
  inspectWebpContainer,
  jpegHasEoi,
  PDF_MARKER_SEARCH_BYTES,
  pngHasIend,
  type RasterFormat,
  startsWithMarkup,
  webpDeclaredPayloadSize,
} from './fileSignatures';

// Allowed image MIME types (raster formats only - NO SVG for security)
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

/**
 * Application upload contract — 10 MB max for both images and PDFs.
 * Keep in sync with:
 * - client-side validators: `useFileUpload` maxSizeMB in CMS section
 *   components (default 10);
 * - framework limit: next.config.ts `serverActions.bodySizeLimit` ('10mb'),
 *   otherwise Next rejects the request before the action runs.
 */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_SIZE_BYTES = MAX_UPLOAD_SIZE_BYTES;
const MAX_FILENAME_LENGTH = 255;

/**
 * Sanitizes a string for use in filenames
 * Removes special characters, replaces spaces with hyphens, converts to lowercase
 */
export function sanitizeFilename(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .substring(0, 50); // Limit length
}

/**
 * Validates an uploaded file for images
 * Rejects SVGs to prevent XSS/script injection attacks
 * Accepts WebP files (expected to be pre-processed client-side)
 *
 * This is the cheap, synchronous metadata pre-filter: it trusts the
 * client-declared MIME/name/size and can run in the browser. It is NOT proof
 * of content. `validateImageFileContent` / `validateImageBytes` are the
 * authoritative byte checks and every storage write path calls them.
 */
export function validateImageFile(file: File): {
  isValid: boolean;
  error?: string;
} {
  // Reject SVG explicitly (security risk - can contain scripts)
  if (
    file.type === 'image/svg+xml' ||
    file.name.toLowerCase().endsWith('.svg')
  ) {
    return {
      isValid: false,
      error:
        'SVG files are not allowed for security reasons. Please use JPG, PNG, or WebP.',
    };
  }

  // Accept WebP files (should be pre-processed client-side)
  if (file.type === 'image/webp') {
    // File size validation (10MB limit)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return {
        isValid: false,
        error:
          'Image file is too large. Please select an image smaller than 10MB',
      };
    }
    // File name validation
    if (file.name.length > MAX_FILENAME_LENGTH) {
      return { isValid: false, error: 'File name is too long' };
    }
    return { isValid: true };
  }

  // File type validation - only allow specific raster formats
  if (
    !ALLOWED_IMAGE_TYPES.includes(
      file.type as (typeof ALLOWED_IMAGE_TYPES)[number]
    )
  ) {
    return {
      isValid: false,
      error: 'Please select a valid image file (JPG, PNG, WebP, GIF, or AVIF)',
    };
  }

  // File size validation (10MB limit - will be compressed anyway)
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      error:
        'Image file is too large. Please select an image smaller than 10MB',
    };
  }

  // File name validation
  if (file.name.length > MAX_FILENAME_LENGTH) {
    return { isValid: false, error: 'File name is too long' };
  }

  return { isValid: true };
}

/**
 * Validates an uploaded PDF file
 *
 * Metadata pre-filter only (client-declared MIME/name/size); the
 * authoritative header/trailer check is `validatePdfFileContent` /
 * `validatePdfBytes`, enforced by `uploadPdfBuffer` and the hero pre-flight.
 */
export function validatePdfFile(file: File): {
  isValid: boolean;
  error?: string;
} {
  // File type validation
  const fileType = file.type.toLowerCase();
  const hasPdfExtension = file.name.toLowerCase().endsWith('.pdf');
  const hasPdfMimeType = fileType === 'application/pdf';
  const hasGenericMimeType =
    fileType === '' || fileType === 'application/octet-stream';

  if (!hasPdfMimeType && !(hasPdfExtension && hasGenericMimeType)) {
    return { isValid: false, error: 'Please select a valid PDF file' };
  }

  // File size validation (10MB limit for PDFs)
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      error: 'PDF file is too large. Please select a file smaller than 10MB',
    };
  }

  // File name validation
  if (file.name.length > MAX_FILENAME_LENGTH) {
    return { isValid: false, error: 'File name is too long' };
  }

  return { isValid: true };
}

/**
 * Minimum bytes that can carry a supported signature plus a chunk/trailer.
 * Anything shorter is empty or hopelessly truncated, so it is rejected before
 * any parser sees it.
 */
export const MIN_IMAGE_CONTENT_BYTES = 16;
export const MIN_PDF_CONTENT_BYTES = 32;

export type FileContentValidation = { isValid: boolean; error?: string };

const IMAGE_EMPTY_ERROR = 'Please select a non-empty image file';
const IMAGE_INCOMPLETE_ERROR =
  'The image file is incomplete or corrupted. Please select a valid JPG, PNG, WebP, GIF, or AVIF image.';
const IMAGE_SIGNATURE_ERROR =
  'File content is not a supported image. Please use JPG, PNG, WebP, GIF, or AVIF.';
const IMAGE_MISMATCH_ERROR =
  'The file content does not match its image type. Please re-export the image and try again.';
const IMAGE_MARKUP_ERROR =
  'SVG and HTML files are not allowed for security reasons. Please use JPG, PNG, or WebP.';
const PDF_SIGNATURE_ERROR = 'Please select a valid PDF file';
const PDF_INCOMPLETE_ERROR =
  'The PDF file is incomplete or corrupted. Please select a valid PDF file.';

function tailOf(bytes: Uint8Array): Uint8Array {
  return bytes.length > FILE_TAIL_BYTES
    ? bytes.subarray(bytes.length - FILE_TAIL_BYTES)
    : bytes;
}

/**
 * Content-level inspection of the leading bytes: rejects markup (SVG/HTML)
 * regardless of declared MIME/name, requires a supported raster signature and
 * requires the signature to agree with the declared MIME type (`image/jpg` is
 * accepted as the legacy JPEG alias; filenames are never trusted).
 */
function inspectImageHead(
  head: Uint8Array,
  declaredType: string
): { valid: true; format: RasterFormat } | { valid: false; error: string } {
  if (startsWithMarkup(head)) {
    return { valid: false, error: IMAGE_MARKUP_ERROR };
  }
  const format = detectRasterFormat(head);
  if (!format) {
    return { valid: false, error: IMAGE_SIGNATURE_ERROR };
  }
  if (imageFormatForMime(declaredType) !== format) {
    return { valid: false, error: IMAGE_MISMATCH_ERROR };
  }
  return { valid: true, format };
}

/** Tail-based completeness checks; WebP is handled by the full container walk. */
function imageTailComplete(format: RasterFormat, tail: Uint8Array): boolean {
  switch (format) {
    case 'png':
      return pngHasIend(tail);
    case 'jpeg':
      return jpegHasEoi(tail);
    case 'gif':
      return gifHasTrailer(tail);
    case 'webp':
      // Callers with the whole buffer use inspectWebpContainer instead.
      return true;
    case 'avif':
      // ISO-BMFF completeness is verified by Sharp's decode before storage.
      return true;
  }
}

function imageBytesComplete(format: RasterFormat, bytes: Uint8Array): boolean {
  if (format === 'webp') return inspectWebpContainer(bytes);
  return imageTailComplete(format, tailOf(bytes));
}

/**
 * Authoritative in-memory image check: signature + declared-MIME agreement +
 * container completeness (PNG IEND, JPEG EOI, GIF trailer, WebP RIFF/chunk
 * walk). Used by `prepareImageUpload` on the buffer it is about to store.
 *
 * This proves the bytes are the format they claim to be; it is not malware
 * scanning. Raster images are still decoded by Sharp before any write.
 */
export function validateImageBytes(
  bytes: Uint8Array,
  declaredType: string
): FileContentValidation {
  if (bytes.length === 0) {
    return { isValid: false, error: IMAGE_EMPTY_ERROR };
  }
  if (bytes.length < MIN_IMAGE_CONTENT_BYTES) {
    return { isValid: false, error: IMAGE_INCOMPLETE_ERROR };
  }
  const inspection = inspectImageHead(
    bytes.subarray(0, FILE_HEADER_BYTES),
    declaredType
  );
  if (!inspection.valid) {
    return { isValid: false, error: inspection.error };
  }
  if (!imageBytesComplete(inspection.format, bytes)) {
    return { isValid: false, error: IMAGE_INCOMPLETE_ERROR };
  }
  return { isValid: true };
}

/**
 * File-shaped image check that reads only the header and the trailer (plus the
 * declared RIFF size) — cheap enough to run before the full buffer is read.
 * WebP structure is verified on the full buffer via `validateImageBytes` in
 * the upload choke point; AVIF completeness is verified by Sharp's decode.
 */
export async function validateImageFileContent(
  file: File
): Promise<FileContentValidation> {
  if (file.size === 0) {
    return { isValid: false, error: IMAGE_EMPTY_ERROR };
  }
  if (file.size < MIN_IMAGE_CONTENT_BYTES) {
    return { isValid: false, error: IMAGE_INCOMPLETE_ERROR };
  }

  const head = new Uint8Array(
    await file.slice(0, FILE_HEADER_BYTES).arrayBuffer()
  );
  const inspection = inspectImageHead(head, file.type);
  if (!inspection.valid) {
    return { isValid: false, error: inspection.error };
  }

  if (inspection.format === 'webp') {
    const declared = webpDeclaredPayloadSize(head);
    if (
      declared === null ||
      8 + declared > file.size ||
      file.size - (8 + declared) > 1 ||
      !hasWebpImageChunkHeader(head)
    ) {
      return { isValid: false, error: IMAGE_INCOMPLETE_ERROR };
    }
    return { isValid: true };
  }

  if (inspection.format === 'avif') {
    return { isValid: true };
  }

  const tail = new Uint8Array(
    await file.slice(Math.max(0, file.size - FILE_TAIL_BYTES)).arrayBuffer()
  );
  if (!imageTailComplete(inspection.format, tail)) {
    return { isValid: false, error: IMAGE_INCOMPLETE_ERROR };
  }
  return { isValid: true };
}

function checkPdfSlices(
  head: Uint8Array,
  tail: Uint8Array
): FileContentValidation {
  if (!hasPdfHeader(head)) {
    return { isValid: false, error: PDF_SIGNATURE_ERROR };
  }
  if (!hasPdfTrailer(tail)) {
    return { isValid: false, error: PDF_INCOMPLETE_ERROR };
  }
  return { isValid: true };
}

/**
 * Authoritative in-memory PDF check: `%PDF-` header (first 1 KiB, where the
 * spec allows it) and `%%EOF` trailer (last 1 KiB). Used by `uploadPdfBuffer`
 * so a spoofed or truncated document is never written to Storage.
 *
 * This proves the bytes are a complete PDF container, not that their content
 * is benign; PDFs are served as inert documents from a separate origin.
 */
export function validatePdfBytes(bytes: Uint8Array): FileContentValidation {
  if (bytes.length === 0) {
    return { isValid: false, error: PDF_SIGNATURE_ERROR };
  }
  if (bytes.length < MIN_PDF_CONTENT_BYTES) {
    return { isValid: false, error: PDF_INCOMPLETE_ERROR };
  }
  const head = bytes.subarray(
    0,
    Math.min(PDF_MARKER_SEARCH_BYTES, bytes.length)
  );
  const tail =
    bytes.length > PDF_MARKER_SEARCH_BYTES
      ? bytes.subarray(bytes.length - PDF_MARKER_SEARCH_BYTES)
      : bytes;
  return checkPdfSlices(head, tail);
}

/** File-shaped PDF check used by the hero pre-flight before any staging. */
export async function validatePdfFileContent(
  file: File
): Promise<FileContentValidation> {
  if (file.size === 0) {
    return { isValid: false, error: PDF_SIGNATURE_ERROR };
  }
  if (file.size < MIN_PDF_CONTENT_BYTES) {
    return { isValid: false, error: PDF_INCOMPLETE_ERROR };
  }
  const head = new Uint8Array(
    await file.slice(0, PDF_MARKER_SEARCH_BYTES).arrayBuffer()
  );
  const tail = new Uint8Array(
    await file
      .slice(Math.max(0, file.size - PDF_MARKER_SEARCH_BYTES))
      .arrayBuffer()
  );
  return checkPdfSlices(head, tail);
}

/**
 * Extracts the storage path (within the bucket) from a Supabase public object URL.
 * Strict: requires the URL origin to equal the configured Supabase origin and
 * the pathname to start with the exact `/storage/v1/object/public/<bucket>/`
 * prefix (segment match, not substring). Query strings are ignored. After
 * percent-decoding, rejects empty, backslash, NUL, and dot-segment paths.
 * Returns null on any mismatch — callers treat null as cleanup no-op so
 * cross-bucket/cross-origin URLs are never deleted.
 */
export function getStoragePathFromPublicUrl(
  fileUrl: string,
  bucket: string,
  origin: string
): string | null {
  try {
    const url = new URL(fileUrl);
    const expectedOrigin = new URL(origin).origin;
    if (url.origin !== expectedOrigin) return null;
    const prefix = `/storage/v1/object/public/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const encoded = url.pathname.slice(prefix.length);
    if (!encoded) return null;
    const filePath = decodeURIComponent(encoded);
    if (!filePath) return null;
    if (filePath.includes('\\') || filePath.includes('\0')) return null;
    const segments = filePath.split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') return null;
    }
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Validates a URL string (generic predicate - accepts any scheme `new URL`
 * accepts). Context-specific scheme allowlists are a Phase 2 fix; do not rely
 * on this helper alone as a security policy.
 */
export function isValidUrl(urlString: string): boolean {
  if (!urlString || urlString.trim() === '') return true; // Empty is valid (optional field)
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * URL validator for web links (website/source/demo/store fields).
 * Empty is valid (optional field); otherwise only http/https are allowed.
 */
export function isValidHttpUrl(urlString: string): boolean {
  if (!urlString || urlString.trim() === '') return true;
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * URL validator for contact links: http/https/mailto/tel only.
 */
export function isValidContactUrl(urlString: string): boolean {
  if (!urlString || urlString.trim() === '') return true;
  try {
    const url = new URL(urlString);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Validates a date string
 */
export function isValidDate(dateString: string): boolean {
  if (!dateString) return false;
  const date = new Date(dateString);
  return date instanceof Date && !Number.isNaN(date.getTime());
}

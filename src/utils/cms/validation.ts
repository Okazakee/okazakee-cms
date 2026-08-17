/**
 * Pure CMS validation helpers.
 *
 * Extracted from `src/app/actions/cms/utils/fileHelpers.ts` during the CMS
 * decoupling (Phase 1) so they can be unit-tested without pulling in
 * Supabase/Sharp/next server code. fileHelpers re-exports these to keep all
 * existing call sites unchanged.
 */

// Allowed image MIME types (raster formats only - NO SVG for security)
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
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
 * Extracts the storage path (within the bucket) from a Supabase public object URL.
 * Returns null if the URL is not from the given bucket or path is empty.
 */
export function getStoragePathFromPublicUrl(
  fileUrl: string,
  bucket: string
): string | null {
  try {
    const url = new URL(fileUrl);
    const pathParts = url.pathname.split('/');
    const bucketIndex = pathParts.indexOf(bucket);
    if (bucketIndex === -1) return null;
    const filePath = decodeURIComponent(
      pathParts.slice(bucketIndex + 1).join('/')
    );
    return filePath || null;
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

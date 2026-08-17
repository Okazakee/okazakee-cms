/**
 * Client-side image processing utility
 * Converts images to WebP format using browser Canvas API and generates blurhash
 */
import { encode as blurkitEncode } from 'blurkit/browser';
import { FALLBACK_BLURHASH } from '@/utils/blurhashUtils';

type ProcessImageOptions = {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0-1, default 0.85
};

type ProcessImageResult = {
  success: boolean;
  file?: File;
  blurhash?: string;
  error?: string;
};

/**
 * Processes an image: resize and convert to WebP
 * Returns a File object ready for upload
 */
export async function processImageToWebP(
  file: File,
  options?: ProcessImageOptions
): Promise<ProcessImageResult> {
  try {
    const maxWidth = options?.maxWidth;
    const maxHeight = options?.maxHeight;
    const quality = options?.quality ?? 0.85;

    // If file is already WebP and no resizing needed, return as-is
    if (file.type === 'image/webp' && !maxWidth && !maxHeight) {
      return { success: true, file };
    }

    // Create image element
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = objectUrl;
    });

    // Calculate dimensions
    let canvasWidth: number;
    let canvasHeight: number;
    let drawWidth: number;
    let drawHeight: number;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = img.width;
    let sourceHeight = img.height;

    if (maxWidth && maxHeight) {
      // Cover mode: scale to cover the area, then crop to exact dimensions
      canvasWidth = maxWidth;
      canvasHeight = maxHeight;

      // Calculate scale to cover the entire area
      const widthRatio = maxWidth / img.width;
      const heightRatio = maxHeight / img.height;
      const scale = Math.max(widthRatio, heightRatio);

      // Scaled dimensions
      const scaledWidth = img.width * scale;
      const scaledHeight = img.height * scale;

      // Calculate how much we need to crop from the scaled image
      const cropX = (scaledWidth - maxWidth) / 2;
      const cropY = (scaledHeight - maxHeight) / 2;

      // Draw the full image scaled, then crop by drawing only the center portion
      // We'll draw the image scaled, but only show the center portion
      drawWidth = scaledWidth;
      drawHeight = scaledHeight;
      sourceX = cropX / scale;
      sourceY = cropY / scale;
      sourceWidth = maxWidth / scale;
      sourceHeight = maxHeight / scale;
    } else if (maxWidth && img.width > maxWidth) {
      // Resize to fit width
      const ratio = maxWidth / img.width;
      canvasWidth = maxWidth;
      canvasHeight = img.height * ratio;
      drawWidth = canvasWidth;
      drawHeight = canvasHeight;
    } else if (maxHeight && img.height > maxHeight) {
      // Resize to fit height
      const ratio = maxHeight / img.height;
      canvasWidth = img.width * ratio;
      canvasHeight = maxHeight;
      drawWidth = canvasWidth;
      drawHeight = canvasHeight;
    } else {
      // No resizing needed
      canvasWidth = img.width;
      canvasHeight = img.height;
      drawWidth = canvasWidth;
      drawHeight = canvasHeight;
    }

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      URL.revokeObjectURL(objectUrl);
      return { success: false, error: 'Failed to get canvas context' };
    }

    // Draw image
    if (maxWidth && maxHeight) {
      // Cover mode: draw cropped portion of source image, scaled to canvas size
      ctx.drawImage(
        img,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight, // Source rectangle
        0,
        0,
        canvasWidth,
        canvasHeight // Destination rectangle
      );
    } else {
      ctx.drawImage(img, 0, 0, drawWidth, drawHeight);
    }

    // Convert to WebP blob
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert canvas to blob'));
          }
        },
        'image/webp',
        quality
      );
    });

    URL.revokeObjectURL(objectUrl);

    // Generate blurhash (simplified - you might want to use a proper library)
    const blurhash = await generateBlurhash(canvas);

    // Create File object from blob
    const webpFile = new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), {
      type: 'image/webp',
      lastModified: Date.now(),
    });

    return {
      success: true,
      file: webpFile,
      blurhash,
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
 * Generates a real blurhash from a canvas element using the blurhash library
 */
async function generateBlurhash(canvas: HTMLCanvasElement): Promise<string> {
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
    const { hash } = await blurkitEncode(blob, { size: 32 });
    return hash;
  } catch {
    return FALLBACK_BLURHASH;
  }
}

/**
 * Generates a blurhash from any image File or URL string.
 * Useful for generating blurhash when an image is set via CDN URL rather than file upload.
 */
export async function generateBlurhashFromImage(
  source: File | string
): Promise<string> {
  try {
    const input = typeof source === 'string' ? new URL(source) : source;
    const { hash } = await blurkitEncode(input, { size: 32 });
    return hash;
  } catch {
    return FALLBACK_BLURHASH;
  }
}

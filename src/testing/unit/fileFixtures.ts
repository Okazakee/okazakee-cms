/**
 * Real byte-level upload fixtures shared by the CMS upload tests.
 *
 * The upload pipeline verifies content before any Storage write, so tests must
 * use genuine containers instead of fabricated "RIFF" headers. These fixtures
 * are tiny but structurally valid:
 *
 * - static WebP: a plain `VP8 ` WebP (68 B) exported by libwebp;
 * - animated WebP: 3-frame `VP8X` + `ANIM` + `ANMF` file (24x18, 322 B,
 *   exported by libwebp) — also used by the animated-path suites;
 * - PNG: 1x1 RGBA image with a real IEND trailer;
 * - PDF: a single-page document with `%PDF-1.4` header and `%%EOF` trailer.
 *
 * Nothing here performs I/O or imports server modules, so the fixtures work in
 * every Vitest environment.
 */

/** Plain static WebP (VP8 chunk, no animation). */
export const STATIC_WEBP_BASE64 =
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoIAAgAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=';

/** 3-frame animated WebP (VP8X animation flag + ANIM + ANMF chunks). */
export const ANIMATED_WEBP_BASE64 =
  'UklGRjoBAABXRUJQVlA4WAoAAAACAAAAFwAAEQAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABEAAGQAAAJWUDggQAAAAFADAJ0BKhgAEgA+kUKcSiWjoqGoCACwEgllAMaqgABAURwAAP7upj/+xZy2BeP/+5wP+5wP+5wP42ykJ2cKAABBTk1GVAAAAAAAAAAAABcAABEAAGQAAABWUDggPAAAAFQDAJ0BKhgAEgA+kUKcSgKAgAABIJZQDGboB+AH4AAERCcAAP7e1j/9GC4Dge+l//YzH7Rn+cJbYoEAAEFOTUZSAAAAAAAAAAAAFwAAEQAAZAAAAFZQOCA6AAAAlAIAnQEqGAASAD6RQpxKAoCAAAEgllAMwcFqlqAA/vVYv/+5wP/9nA//2cD+Ov9eqWuTjgLLeAAAAA==';

/** 1x1 RGBA PNG with a complete IEND chunk. */
export const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 1x1 baseline JPEG ending with the EOI marker. */
export const MINIMAL_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z';

/** 1x1 GIF89a ending with the 0x3B trailer. */
export const MINIMAL_GIF_BASE64 =
  'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

/** 1x1 AVIF (ISO-BMFF `ftyp` box with the `avif` brand). */
export const MINIMAL_AVIF_BASE64 =
  'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB8AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAnbWRhdBIACgc4AAaQENBpMhIZQmMEwAA0AACQQMkcYUKw4IA=';

export function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function staticWebpBytes(): Uint8Array<ArrayBuffer> {
  return base64Bytes(STATIC_WEBP_BASE64);
}

export function animatedWebpBytes(): Uint8Array<ArrayBuffer> {
  return base64Bytes(ANIMATED_WEBP_BASE64);
}

export function pngBytes(): Uint8Array<ArrayBuffer> {
  return base64Bytes(MINIMAL_PNG_BASE64);
}

export function jpegBytes(): Uint8Array<ArrayBuffer> {
  return base64Bytes(MINIMAL_JPEG_BASE64);
}

export function gifBytes(): Uint8Array<ArrayBuffer> {
  return base64Bytes(MINIMAL_GIF_BASE64);
}

export function avifBytes(): Uint8Array<ArrayBuffer> {
  return base64Bytes(MINIMAL_AVIF_BASE64);
}

/** Wraps raw bytes in a `File` with the declared name/MIME under test. */
export function fileFromBytes(
  bytes: Uint8Array,
  name: string,
  type: string
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/**
 * A syntactically valid single-page PDF (same shape as the storage-seed
 * fixture): `%PDF-1.4` header, one page, and the `%%EOF` trailer.
 */
export function minimalPdfBytes(
  label = 'Fixture resume'
): Uint8Array<ArrayBuffer> {
  const body = [
    '%PDF-1.4',
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj',
    `4 0 obj<< /Length ${label.length + 40} >>stream`,
    `BT /F1 12 Tf 10 50 Td (${label}) Tj ET`,
    'endstream',
    'endobj',
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj',
    'trailer<< /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');
  const encoded = new TextEncoder().encode(body);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

export function staticWebpFile(name = 'image.webp'): File {
  return new File([staticWebpBytes()], name, { type: 'image/webp' });
}

export function animatedWebpFile(name = 'image.webp'): File {
  return new File([animatedWebpBytes()], name, { type: 'image/webp' });
}

export function pngFile(name = 'image.png'): File {
  return new File([pngBytes()], name, { type: 'image/png' });
}

export function minimalPdfFile(name = 'resume.pdf'): File {
  return new File([minimalPdfBytes()], name, { type: 'application/pdf' });
}

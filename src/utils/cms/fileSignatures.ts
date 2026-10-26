/**
 * Byte-level file signatures shared by the client-safe validators
 * (`@/utils/cms/validation`) and the server upload pipeline
 * (`fileHelpers`). Isomorphic and pure: no `node:` imports, no I/O, so the
 * same checks can run in the browser and inside a Server Action.
 *
 * These helpers prove what a file *is* (container signature + completeness).
 * They are NOT malware scanning: a syntactically valid image/PDF can still be
 * hostile to a downstream parser, which is why every raster image is also
 * decoded by Sharp before storage and PDFs are served as inert documents.
 */

/** Enough of the header to identify every supported container (RIFF+VP8X, ftyp, PDF). */
export const FILE_HEADER_BYTES = 32;
/** Enough of the tail to find PNG IEND, JPEG EOI, GIF trailer and PDF %%EOF. */
export const FILE_TAIL_BYTES = 1024;
/** PDF 32000 allows the `%PDF-` header within the first 1024 bytes. */
export const PDF_MARKER_SEARCH_BYTES = 1024;

/** Supported raster containers. SVG/HTML are deliberately absent. */
export type RasterFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif';

const RIFF_MAGIC = 'RIFF';
const WEBP_FORMAT = 'WEBP';
const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';
const GIF_SIGNATURES = ['GIF87a', 'GIF89a'] as const;
const AVIF_BRANDS = ['avif', 'avis'] as const;
const WEBP_IMAGE_CHUNKS = ['VP8 ', 'VP8L', 'VP8X'] as const;

const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  value: string
): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function indexOfAscii(bytes: Uint8Array, value: string): number {
  const last = bytes.length - value.length;
  for (let start = 0; start <= last; start += 1) {
    if (matchesAscii(bytes, start, value)) return start;
  }
  return -1;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Identifies the raster container from its leading bytes. Returns null when no
 * supported signature matches, which includes SVG/HTML text and every other
 * non-raster format.
 */
export function detectRasterFormat(head: Uint8Array): RasterFormat | null {
  if (matchesAscii(head, 0, PNG_SIGNATURE)) return 'png';
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  ) {
    return 'jpeg';
  }
  for (const signature of GIF_SIGNATURES) {
    if (matchesAscii(head, 0, signature)) return 'gif';
  }
  if (matchesAscii(head, 0, RIFF_MAGIC) && matchesAscii(head, 8, WEBP_FORMAT)) {
    return 'webp';
  }
  // ISO-BMFF: `ftyp` at offset 4 plus an AVIF brand (major or compatible).
  if (matchesAscii(head, 4, 'ftyp') && readUint32BE(head, 0) >= 16) {
    for (let offset = 8; offset + 4 <= head.length; offset += 4) {
      for (const brand of AVIF_BRANDS) {
        if (matchesAscii(head, offset, brand)) return 'avif';
      }
    }
  }
  return null;
}

/**
 * True when the content starts with markup (`<svg`, `<?xml`, `<!doctype`, an
 * HTML tag) after an optional UTF-8 BOM and ASCII whitespace. This is the
 * content-level SVG/HTML ban: a text file can never masquerade as a raster
 * image just because the client declared an image MIME type.
 */
export function startsWithMarkup(head: Uint8Array): boolean {
  let index = 0;
  if (
    head.length >= 3 &&
    head[0] === 0xef &&
    head[1] === 0xbb &&
    head[2] === 0xbf
  ) {
    index = 3;
  }
  while (index < head.length && ASCII_WHITESPACE.has(head[index])) {
    index += 1;
  }
  return index < head.length && head[index] === 0x3c; // '<'
}

/**
 * RIFF payload size declared in the WebP header, or null when the header is
 * not a WebP container. The payload starts at byte 8, so a complete file has
 * `size === 8 + payload` (a single pad byte is tolerated).
 */
export function webpDeclaredPayloadSize(head: Uint8Array): number | null {
  if (head.length < 12) return null;
  if (
    !matchesAscii(head, 0, RIFF_MAGIC) ||
    !matchesAscii(head, 8, WEBP_FORMAT)
  ) {
    return null;
  }
  return readUint32LE(head, 4);
}

/** First WebP chunk must be an image chunk, never arbitrary payload. */
export function hasWebpImageChunkHeader(head: Uint8Array): boolean {
  return WEBP_IMAGE_CHUNKS.some((chunk) => matchesAscii(head, 12, chunk));
}

/**
 * Full WebP container check: RIFF/WEBP header, declared payload that matches
 * the actual byte length, and a well-formed chunk walk that yields at least
 * one image chunk. Every chunk size must fit inside the declared payload, so
 * a truncated or padded-with-garbage file is rejected before it can be stored
 * byte-for-byte.
 */
export function inspectWebpContainer(bytes: Uint8Array): boolean {
  const declared = webpDeclaredPayloadSize(bytes);
  if (declared === null) return false;

  const payloadEnd = 8 + declared;
  if (payloadEnd > bytes.length) return false;
  // A RIFF file may carry one trailing pad byte outside the declared payload.
  if (bytes.length - payloadEnd > 1) return false;

  let offset = 12;
  let sawImageChunk = false;
  while (offset < payloadEnd) {
    if (offset + 8 > payloadEnd) return false;

    const chunkSize = readUint32LE(bytes, offset + 4);
    const chunkEnd = offset + 8 + chunkSize;
    if (chunkEnd > payloadEnd) return false;

    if (!sawImageChunk) {
      sawImageChunk = WEBP_IMAGE_CHUNKS.some((chunk) =>
        matchesAscii(bytes, offset, chunk)
      );
    }

    const paddedEnd = chunkEnd + (chunkSize & 1);
    if (paddedEnd > payloadEnd) {
      // The final chunk may end exactly at the payload edge without padding.
      if (chunkEnd !== payloadEnd) return false;
      break;
    }
    offset = paddedEnd;
  }

  return sawImageChunk;
}

/** PNG trailer: the IEND chunk type preceded by its zero length field. */
export function pngHasIend(tail: Uint8Array): boolean {
  // IEND is the last chunk, so scan backwards and stop at the first match.
  for (let index = tail.length - 4; index >= 4; index -= 1) {
    if (!matchesAscii(tail, index, 'IEND')) continue;
    if (
      tail[index - 4] === 0 &&
      tail[index - 3] === 0 &&
      tail[index - 2] === 0 &&
      tail[index - 1] === 0
    ) {
      return true;
    }
  }
  return false;
}

/** JPEG trailer: EOI marker (FF D9), tolerating trailing zero padding only. */
export function jpegHasEoi(tail: Uint8Array): boolean {
  let index = tail.length - 1;
  while (index > 0 && tail[index] === 0) index -= 1;
  return index >= 1 && tail[index] === 0xd9 && tail[index - 1] === 0xff;
}

/** GIF trailer: 0x3B is the mandatory last byte of the stream. */
export function gifHasTrailer(tail: Uint8Array): boolean {
  let index = tail.length - 1;
  while (index > 0 && tail[index] === 0) index -= 1;
  return index >= 0 && tail[index] === 0x3b;
}

/** `%PDF-` within the leading bytes (the spec allows leading junk). */
export function hasPdfHeader(head: Uint8Array): boolean {
  return indexOfAscii(head, '%PDF-') >= 0;
}

/** `%%EOF` within the trailing bytes. */
export function hasPdfTrailer(tail: Uint8Array): boolean {
  return indexOfAscii(tail, '%%EOF') >= 0;
}

/** Maps a declared MIME type to the raster format it must contain. */
export function imageFormatForMime(type: string): RasterFormat | null {
  switch (type.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    default:
      return null;
  }
}

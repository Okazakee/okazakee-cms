/**
 * Animated WebP detection shared by the browser upload pipeline
 * (`useFileUpload` / `imageProcessor`) and the server image pipeline
 * (`fileHelpers`), so both sides agree on when an image must be handled as an
 * animation instead of a single frame.
 *
 * Animated WebP is always encoded in the extended container format: a `VP8X`
 * chunk whose flags byte carries the animation bit (`0x02`). Frame data lives
 * in `ANIM` / `ANMF` chunks, which is the signal Next's image optimizer looks
 * for; both are always present in a valid animated file, but the VP8X flag is
 * contained in the first 21 bytes of the container and cannot be confused with
 * an ASCII "ANIM" sequence inside a metadata (EXIF/XMP) chunk.
 */

/** RIFF header (12) + VP8X chunk header (8) + VP8X flags byte (1). */
export const WEBP_HEADER_BYTES = 32;

const RIFF_MAGIC = 'RIFF';
const WEBP_FORMAT = 'WEBP';
const VP8X_CHUNK = 'VP8X';
const VP8X_FLAGS_OFFSET = 20;
const ANIMATION_FLAG = 0x02;

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

/**
 * True when the given WebP container header declares an animation.
 * Accepts partial buffers as long as the first 21 bytes are present.
 */
export function isAnimatedWebpBytes(bytes: Uint8Array): boolean {
  if (bytes.length <= VP8X_FLAGS_OFFSET) return false;
  if (
    !matchesAscii(bytes, 0, RIFF_MAGIC) ||
    !matchesAscii(bytes, 8, WEBP_FORMAT) ||
    !matchesAscii(bytes, 12, VP8X_CHUNK)
  ) {
    return false;
  }
  return (bytes[VP8X_FLAGS_OFFSET] & ANIMATION_FLAG) !== 0;
}

/**
 * Browser/server variant that reads only the container header of a picked
 * file. Non-WebP files are never animated WebP, so they short-circuit.
 */
export async function isAnimatedWebpFile(file: File): Promise<boolean> {
  if (file.type !== 'image/webp') return false;
  const header = new Uint8Array(
    await file.slice(0, WEBP_HEADER_BYTES).arrayBuffer()
  );
  return isAnimatedWebpBytes(header);
}

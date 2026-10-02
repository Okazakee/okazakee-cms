import { describe, expect, it } from 'vitest';
import {
  isAnimatedWebpBytes,
  isAnimatedWebpFile,
  WEBP_HEADER_BYTES,
} from '@/utils/cms/webpAnimation';

/**
 * Real fixtures (24x18, 3 frames, ~300 B each). The animated file was exported
 * by libwebp (VP8X + ANIM + ANMF); the static one is a plain VP8 WebP.
 */
const ANIMATED_WEBP_BASE64 =
  'UklGRjoBAABXRUJQVlA4WAoAAAACAAAAFwAAEQAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABEAAGQAAAJWUDggQAAAAFADAJ0BKhgAEgA+kUKcSiWjoqGoCACwEgllAMaqgABAURwAAP7upj/+xZy2BeP/+5wP+5wP+5wP42ykJ2cKAABBTk1GVAAAAAAAAAAAABcAABEAAGQAAABWUDggPAAAAFQDAJ0BKhgAEgA+kUKcSgKAgAABIJZQDGboB+AH4AAERCcAAP7e1j/9GC4Dge+l//YzH7Rn+cJbYoEAAEFOTUZSAAAAAAAAAAAAFwAAEQAAZAAAAFZQOCA6AAAAlAIAnQEqGAASAD6RQpxKAoCAAAEgllAMwcFqlqAA/vVYv/+5wP/9nA//2cD+Ov9eqWuTjgLLeAAAAA==';
const STATIC_WEBP_BASE64 =
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoIAAgAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=';

const VP8X_FLAGS_OFFSET = 20;

function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(base64, 'base64');
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

/** Minimal WebP container header with a given VP8X chunk and flags byte. */
function webpHeader(chunk: string, flags: number, size = WEBP_HEADER_BYTES) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode(chunk), 12);
  bytes[VP8X_FLAGS_OFFSET] = flags;
  return bytes;
}

describe('isAnimatedWebpBytes', () => {
  it('detects a real animated WebP (VP8X animation flag)', () => {
    expect(isAnimatedWebpBytes(base64Bytes(ANIMATED_WEBP_BASE64))).toBe(true);
  });

  it('rejects a real static WebP (VP8 chunk, no VP8X)', () => {
    expect(isAnimatedWebpBytes(base64Bytes(STATIC_WEBP_BASE64))).toBe(false);
  });

  it('detects the animation flag combined with other VP8X flags', () => {
    // 0x12 = animation (0x02) | alpha (0x10)
    expect(isAnimatedWebpBytes(webpHeader('VP8X', 0x12))).toBe(true);
  });

  it('rejects a VP8X container without the animation flag', () => {
    // Extended format for alpha only.
    expect(isAnimatedWebpBytes(webpHeader('VP8X', 0x10))).toBe(false);
  });

  it('rejects non-WebP magic bytes', () => {
    const png = new Uint8Array(WEBP_HEADER_BYTES);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    expect(isAnimatedWebpBytes(png)).toBe(false);

    const gif = new Uint8Array(WEBP_HEADER_BYTES);
    gif.set(new TextEncoder().encode('GIF89a'), 0);
    expect(isAnimatedWebpBytes(gif)).toBe(false);
  });

  it('rejects a buffer that is too short to hold the flags byte', () => {
    const truncated = base64Bytes(ANIMATED_WEBP_BASE64).slice(0, 20);
    expect(isAnimatedWebpBytes(truncated)).toBe(false);
  });

  it('rejects a RIFF container whose format is not WEBP', () => {
    const wav = webpHeader('VP8X', 0x02);
    wav.set(new TextEncoder().encode('WAVE'), 8);
    expect(isAnimatedWebpBytes(wav)).toBe(false);
  });
});

describe('isAnimatedWebpFile', () => {
  it('reads only the header of an animated WebP file', async () => {
    const file = new File([base64Bytes(ANIMATED_WEBP_BASE64)], 'propic.webp', {
      type: 'image/webp',
    });
    await expect(isAnimatedWebpFile(file)).resolves.toBe(true);
  });

  it('reports a static WebP file as not animated', async () => {
    const file = new File([base64Bytes(STATIC_WEBP_BASE64)], 'propic.webp', {
      type: 'image/webp',
    });
    await expect(isAnimatedWebpFile(file)).resolves.toBe(false);
  });

  it('never treats a non-WebP file as animated', async () => {
    const file = new File([base64Bytes(ANIMATED_WEBP_BASE64)], 'g.png', {
      type: 'image/png',
    });
    await expect(isAnimatedWebpFile(file)).resolves.toBe(false);
  });

  it('tolerates a file shorter than the header', async () => {
    const file = new File([new Uint8Array(4)], 'broken.webp', {
      type: 'image/webp',
    });
    await expect(isAnimatedWebpFile(file)).resolves.toBe(false);
  });
});

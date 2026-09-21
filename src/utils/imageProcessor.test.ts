// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { processImageToWebP } from '@/utils/imageProcessor';

/**
 * Real 3-frame animated WebP fixture (24x18, ~300 B): VP8X animation flag,
 * ANIM + three ANMF frames.
 */
const ANIMATED_WEBP_BASE64 =
  'UklGRjoBAABXRUJQVlA4WAoAAAACAAAAFwAAEQAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABEAAGQAAAJWUDggQAAAAFADAJ0BKhgAEgA+kUKcSiWjoqGoCACwEgllAMaqgABAURwAAP7upj/+xZy2BeP/+5wP+5wP+5wP42ykJ2cKAABBTk1GVAAAAAAAAAAAABcAABEAAGQAAABWUDggPAAAAFQDAJ0BKhgAEgA+kUKcSgKAgAABIJZQDGboB+AH4AAERCcAAP7e1j/9GC4Dge+l//YzH7Rn+cJbYoEAAEFOTUZSAAAAAAAAAAAAFwAAEQAAZAAAAFZQOCA6AAAAlAIAnQEqGAASAD6RQpxKAoCAAAEgllAMwcFqlqAA/vVYv/+5wP/9nA//2cD+Ov9eqWuTjgLLeAAAAA==';

function animatedWebpFile(): File {
  const bytes = Buffer.from(ANIMATED_WEBP_BASE64, 'base64');
  return new File([new Uint8Array(bytes)], 'propic.webp', {
    type: 'image/webp',
  });
}

describe('processImageToWebP', () => {
  it('returns an animated WebP untouched instead of flattening it on a canvas', async () => {
    const file = animatedWebpFile();

    const result = await processImageToWebP(file, {
      maxWidth: 512,
      maxHeight: 512,
      quality: 0.85,
    });

    expect(result.success).toBe(true);
    // Same File instance: no canvas round-trip (which would keep only the
    // first frame). Resizing animations happens server-side.
    expect(result.file).toBe(file);
    expect(result.file?.type).toBe('image/webp');
    expect(result.file?.name).toBe('propic.webp');
  });

  it('preserves the frames of the returned file', async () => {
    const result = await processImageToWebP(animatedWebpFile(), {
      maxWidth: 512,
      maxHeight: 512,
    });

    expect(result.success).toBe(true);
    if (!result.success || !result.file) return;

    const sharp = (await import('sharp')).default;
    const bytes = new Uint8Array(await result.file.arrayBuffer());
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(3);
  });
});

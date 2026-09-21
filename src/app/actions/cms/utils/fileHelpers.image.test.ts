import { describe, expect, it, vi } from 'vitest';

// The pipeline under test never touches Supabase, but importing fileHelpers
// pulls in the server-action auth plumbing (next/headers, service-role
// client). Both are stubbed so the module can be imported outside a request.
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/libs/cms/supabase/admin', () => ({ getCmsAdminClient: vi.fn() }));

import { prepareImageUpload, uploadPreparedImage } from './fileHelpers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Real 3-frame animated WebP fixture (24x18, ~300 B). Exported by libwebp:
 * VP8X with the animation flag + ANIM + three ANMF frames.
 */
const ANIMATED_WEBP_BASE64 =
  'UklGRjoBAABXRUJQVlA4WAoAAAACAAAAFwAAEQAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABEAAGQAAAJWUDggQAAAAFADAJ0BKhgAEgA+kUKcSiWjoqGoCACwEgllAMaqgABAURwAAP7upj/+xZy2BeP/+5wP+5wP+5wP42ykJ2cKAABBTk1GVAAAAAAAAAAAABcAABEAAGQAAABWUDggPAAAAFQDAJ0BKhgAEgA+kUKcSgKAgAABIJZQDGboB+AH4AAERCcAAP7e1j/9GC4Dge+l//YzH7Rn+cJbYoEAAEFOTUZSAAAAAAAAAAAAFwAAEQAAZAAAAFZQOCA6AAAAlAIAnQEqGAASAD6RQpxKAoCAAAEgllAMwcFqlqAA/vVYv/+5wP/9nA//2cD+Ov9eqWuTjgLLeAAAAA==';

const HERO_IMAGE_OPTIONS = { maxWidth: 512, maxHeight: 512, quality: 80 };

function animatedWebpBuffer(): Buffer {
  return Buffer.from(ANIMATED_WEBP_BASE64, 'base64');
}

function toFile(buffer: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(buffer)], name, { type });
}

async function inspectWebp(buffer: Buffer) {
  const sharp = (await import('sharp')).default;
  const animated = await sharp(buffer, { animated: true }).metadata();
  return {
    format: animated.format,
    width: animated.width,
    height: animated.height,
    pageHeight: animated.pageHeight,
    pages: animated.pages,
  };
}

describe('prepareImageUpload — animated WebP', () => {
  it('keeps every frame when the animation already fits the bounds', async () => {
    const source = animatedWebpBuffer();

    const result = await prepareImageUpload(
      toFile(source, 'propic.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Fits 512x512: stored byte-for-byte, no re-encode.
    expect(result.image.buffer.equals(source)).toBe(true);
    expect(result.image.extension).toBe('webp');
    expect(result.image.contentType).toBe('image/webp');

    const inspected = await inspectWebp(result.image.buffer);
    expect(inspected.pages).toBe(3);
    expect(inspected.width).toBe(24);
    expect(inspected.pageHeight).toBe(18);
  });

  it('derives the blurhash from the animation instead of flattening it', async () => {
    const result = await prepareImageUpload(
      toFile(animatedWebpBuffer(), 'propic.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // A valid blurhash generated server-side (first frame), not the fallback.
    expect(result.image.blurhash).toMatch(
      /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{4,100}$/
    );
  });

  it('resizes an oversized animation frame-by-frame, preserving the frames', async () => {
    const sharp = (await import('sharp')).default;
    const oversized = await sharp(animatedWebpBuffer(), { animated: true })
      .resize(1200, 900)
      .webp({ quality: 80 })
      .toBuffer();

    const result = await prepareImageUpload(
      toFile(oversized, 'propic.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const inspected = await inspectWebp(result.image.buffer);
    expect(inspected.pages).toBe(3);
    // cover resize crops to the requested 512x512 per frame.
    expect(inspected.width).toBe(512);
    expect(inspected.pageHeight).toBe(512);
  });

  it('prefers a client-provided blurhash over a generated one', async () => {
    const blurhash = 'LCCFD8rlI$5Q1Rr|ob=y5Rbx$vOE';

    const result = await prepareImageUpload(
      toFile(animatedWebpBuffer(), 'propic.webp', 'image/webp'),
      blurhash,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.image.blurhash).toBe(blurhash);
  });
});

describe('uploadPreparedImage — storage contract', () => {
  it('stores an animation at the same path with the WebP content type', async () => {
    const source = animatedWebpBuffer();
    const upload = vi.fn(
      async (
        _path: string,
        _buffer: Buffer,
        _options: Record<string, unknown>
      ) => ({ error: null })
    );
    const getPublicUrl = vi.fn((path: string) => ({
      data: { publicUrl: `https://cdn.test/${path}` },
    }));
    const supabase = {
      storage: { from: vi.fn(() => ({ upload, getPublicUrl })) },
    } as unknown as SupabaseClient;

    const prepared = await prepareImageUpload(
      toFile(source, 'propic.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;

    const result = await uploadPreparedImage(
      supabase,
      'website',
      'avatar/avatar',
      prepared.image
    );

    expect(supabase.storage.from).toHaveBeenCalledWith('website');
    expect(upload).toHaveBeenCalledWith(
      'avatar/avatar.webp',
      prepared.image.buffer,
      {
        cacheControl: '3600',
        contentType: 'image/webp',
        upsert: true,
      }
    );
    // Every frame survives the round-trip to storage.
    expect(upload.mock.calls[0][1]?.equals(source)).toBe(true);
    expect(result).toEqual({
      publicUrl: 'https://cdn.test/avatar/avatar.webp',
      path: 'avatar/avatar.webp',
    });
  });
});

describe('prepareImageUpload — static images (unchanged behaviour)', () => {
  it('stores a static WebP byte-for-byte', async () => {
    const sharp = (await import('sharp')).default;
    const source = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .webp({ quality: 90 })
      .toBuffer();

    const result = await prepareImageUpload(
      toFile(source, 'propic.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.image.buffer.equals(source)).toBe(true);
    expect(result.image.extension).toBe('webp');
  });

  it('converts a raster image to WebP at the requested bounds', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .png()
      .toBuffer();

    const result = await prepareImageUpload(
      toFile(png, 'propic.png', 'image/png'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const inspected = await inspectWebp(result.image.buffer);
    expect(inspected.format).toBe('webp');
    expect(inspected.pages).toBeUndefined();
    expect(inspected.width).toBe(512);
    expect(inspected.height).toBe(512);
  });
});

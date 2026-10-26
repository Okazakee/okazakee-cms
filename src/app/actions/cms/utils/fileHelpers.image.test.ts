import { describe, expect, it, vi } from 'vitest';

// The pipeline under test never touches Supabase, but importing fileHelpers
// pulls in the server-action auth plumbing (next/headers, service-role
// client). Both are stubbed so the module can be imported outside a request.
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/libs/cms/supabase/admin', () => ({ getCmsAdminClient: vi.fn() }));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  prepareImageUpload,
  uploadImmutablePreparedImage,
  uploadPdfBuffer,
} from './fileHelpers';
import {
  fileFromBytes,
  minimalPdfBytes,
  pngBytes,
  staticWebpBytes,
} from '@/testing/unit/fileFixtures';

/**
 * Real 3-frame animated WebP fixture (24x18, ~300 B). Exported by libwebp:
 * VP8X with the animation flag + ANIM + three ANMF frames.
 */
const ANIMATED_WEBP_BASE64 =
  'UklGRjoBAABXRUJQVlA4WAoAAAACAAAAFwAAEQAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABEAAGQAAAJWUDggQAAAAFADAJ0BKhgAEgA+kUKcSiWjoqGoCACwEgllAMaqgABAURwAAP7upj/+xZy2BeP/+5wP+5wP+5wP42ykJ2cKAABBTk1GVAAAAAAAAAAAABcAABEAAGQAAABWUDggPAAAAFQDAJ0BKhgAEgA+kUKcSgKAgAABIJZQDGboB+AH4AAERCcAAP7e1j/9GC4Dge+l//YzH7Rn+cJbYoEAAEFOTUZSAAAAAAAAAAAAFwAAEQAAZAAAAFZQOCA6AAAAlAIAnQEqGAASAD6RQpxKAoCAAAEgllAMwcFqlqAA/vVYv/+5wP/9nA//2cD+Ov9eqWuTjgLLeAAAAA==';

const HERO_IMAGE_OPTIONS = { maxWidth: 512, maxHeight: 512, quality: 80 };

/** Valid 1x1 PNG data URL a client could legitimately supply. */
const VALID_BLUR_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function animatedWebpBuffer(): Buffer {
  return Buffer.from(ANIMATED_WEBP_BASE64, 'base64');
}

/**
 * Overwrites the bitstream of the LAST ANMF frame only, keeping the 16-byte
 * ANMF frame header, the nested image-chunk header and the first 10 bitstream
 * bytes (keyframe header) intact. RIFF sizes, the chunk walk and Sharp
 * metadata therefore still succeed while an all-frame decode must fail;
 * earlier frames stay valid.
 */
function corruptLastAnmfFrame(source: Buffer): Buffer {
  const bytes = Buffer.from(source);
  const payloadEnd = 8 + bytes.readUInt32LE(4);
  const anmfChunks: number[] = [];
  let offset = 12;
  while (offset + 8 <= payloadEnd) {
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'ANMF') {
      anmfChunks.push(offset);
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }
  const lastAnmf = anmfChunks[anmfChunks.length - 1];
  if (lastAnmf === undefined) throw new Error('fixture has no ANMF chunk');

  // ANMF payload: 16-byte frame header, then the nested image chunk.
  const nestedChunk = lastAnmf + 8 + 16;
  const bitstream = nestedChunk + 8;
  const bitstreamEnd = bitstream + bytes.readUInt32LE(nestedChunk + 4);
  bytes.fill(0x3f, bitstream + 10, bitstreamEnd);
  return bytes;
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

  it('derives the placeholder data URL from the animation instead of flattening it', async () => {
    const result = await prepareImageUpload(
      toFile(animatedWebpBuffer(), 'propic.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // A valid data URL generated server-side (first frame), not the fallback.
    expect(result.image.blurhash).toMatch(
      /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/
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

  it('prefers a client-provided placeholder over a generated one', async () => {
    const blurhash =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const result = await prepareImageUpload(
      toFile(animatedWebpBuffer(), 'propic.webp', 'image/webp'),
      blurhash,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.image.blurhash).toBe(blurhash);
  });

  it('rejects a corrupt later frame even with a valid placeholder (all frames required)', async () => {
    const corrupted = corruptLastAnmfFrame(animatedWebpBuffer());

    // The container still parses, so only the all-frame decode can reject it.
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(corrupted, { animated: true }).metadata();
    expect(metadata.pages).toBeGreaterThan(1);

    const result = await prepareImageUpload(
      toFile(corrupted, 'propic.webp', 'image/webp'),
      VALID_BLUR_PLACEHOLDER,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/could not be decoded/i);
  });
});

describe('uploadImmutablePreparedImage — storage contract', () => {
  it('stores every animation frame at a fresh path without overwriting a live object', async () => {
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

    const result = await uploadImmutablePreparedImage(
      supabase,
      'website-dev',
      'avatar',
      'avatar',
      prepared.image
    );
    const next = await uploadImmutablePreparedImage(
      supabase,
      'website-dev',
      'avatar',
      'avatar',
      prepared.image
    );
    expect(next.path).not.toBe(result.path);
    expect(result.path).toMatch(/^avatar\/\d+-[a-f0-9-]+-avatar\.webp$/);

    expect(supabase.storage.from).toHaveBeenCalledWith('website-dev');
    expect(upload).toHaveBeenCalledWith(result.path, prepared.image.buffer, {
      cacheControl: '3600',
      contentType: 'image/webp',
      upsert: false,
    });
    // Every frame survives the round-trip to storage.
    expect(upload.mock.calls[0][1]?.equals(source)).toBe(true);
    expect(result).toEqual({
      publicUrl: `https://cdn.test/${result.path}`,
      path: result.path,
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

/**
 * Syntactically coherent WebP container: a RIFF header whose declared payload
 * matches the byte length, plus one `VP8 ` chunk whose body is arbitrary bytes
 * rather than a VP8 bitstream. The container walk in `validateImageBytes`
 * accepts it; libwebp cannot decode it.
 */
function webpContainerWithVp8Payload(payload: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(payload);
  const paddedSize = body.length + (body.length & 1);
  const bytes = new Uint8Array(12 + 8 + paddedSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (value: string, offset: number) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii('RIFF', 0);
  view.setUint32(4, 4 + 8 + paddedSize, true);
  writeAscii('WEBP', 8);
  writeAscii('VP8 ', 12);
  view.setUint32(16, body.length, true);
  bytes.set(body, 20);
  return bytes;
}

/** PHP source disguised as a VP8 bitstream. */
const FAKE_VP8_PHP_PAYLOAD = '<?php system($_GET["c"]); ?>';

describe('prepareImageUpload — static WebP decode proof', () => {
  it('rejects a well-formed container whose VP8 payload is not decodable even with a valid placeholder', async () => {
    const result = await prepareImageUpload(
      fileFromBytes(
        webpContainerWithVp8Payload(FAKE_VP8_PHP_PAYLOAD),
        'avatar.webp',
        'image/webp'
      ),
      VALID_BLUR_PLACEHOLDER,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/could not be decoded/i);
  });

  it('rejects the same payload under a double extension (filename independence)', async () => {
    const result = await prepareImageUpload(
      fileFromBytes(
        webpContainerWithVp8Payload(FAKE_VP8_PHP_PAYLOAD),
        'avatar.php.webp',
        'image/webp'
      ),
      VALID_BLUR_PLACEHOLDER,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/could not be decoded/i);
  });

  it('rejects the payload when no placeholder is supplied', async () => {
    const result = await prepareImageUpload(
      fileFromBytes(
        webpContainerWithVp8Payload(FAKE_VP8_PHP_PAYLOAD),
        'avatar.webp',
        'image/webp'
      ),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
  });

  it('still accepts a genuine multi-dot static WebP and stores the original bytes', async () => {
    const source = staticWebpBytes();

    const result = await prepareImageUpload(
      fileFromBytes(source, 'multi.part.php.webp', 'image/webp'),
      VALID_BLUR_PLACEHOLDER,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.image.buffer.equals(Buffer.from(source))).toBe(true);
    expect(result.image.extension).toBe('webp');
    expect(result.image.contentType).toBe('image/webp');
    expect(result.image.blurhash).toBe(VALID_BLUR_PLACEHOLDER);
  });
});

describe('prepareImageUpload — byte validation before storage', () => {
  it('rejects SVG bytes declared as WebP', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'
    );

    const result = await prepareImageUpload(
      fileFromBytes(svg, 'evil.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/SVG and HTML/i);
  });

  it('rejects PNG bytes declared as WebP (MIME/content mismatch)', async () => {
    const result = await prepareImageUpload(
      fileFromBytes(pngBytes(), 'spoof.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/does not match/i);
  });

  it('rejects the 8-byte RIFF-only file the old fixtures fabricated', async () => {
    const riffOnly = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);

    const result = await prepareImageUpload(
      fileFromBytes(riffOnly, 'image.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/incomplete|corrupted/i);
  });

  it('rejects a WebP whose declared payload is truncated', async () => {
    const truncated = staticWebpBytes().slice(0, -1);

    const result = await prepareImageUpload(
      fileFromBytes(new Uint8Array(truncated), 'cut.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/incomplete|corrupted/i);
  });

  it('rejects a WebP whose chunk walk overruns the RIFF payload', async () => {
    const corrupt = new Uint8Array(staticWebpBytes());
    corrupt.set([0xff, 0xff, 0x00, 0x00], 16);

    const result = await prepareImageUpload(
      fileFromBytes(corrupt, 'corrupt.webp', 'image/webp'),
      undefined,
      HERO_IMAGE_OPTIONS
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/incomplete|corrupted/i);
  });
});

function fakeStorage() {
  const upload = vi.fn(
    async (
      _path: string,
      _data: Buffer,
      _options: Record<string, unknown>
    ) => ({ error: null })
  );
  const getPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://cdn.test/${path}` },
  }));
  const supabase = {
    storage: { from: vi.fn(() => ({ upload, getPublicUrl })) },
  } as unknown as SupabaseClient;
  return { supabase, upload };
}

describe('uploadPdfBuffer — content validation before storage', () => {
  it('rejects bytes without a PDF header before any Storage write', async () => {
    const { supabase, upload } = fakeStorage();

    await expect(
      uploadPdfBuffer(
        supabase,
        'website-dev',
        'resumes',
        'resume',
        Buffer.from('<html>not a pdf</html>')
      )
    ).rejects.toThrow(/valid PDF/i);

    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a truncated PDF (header but no %%EOF)', async () => {
    const { supabase, upload } = fakeStorage();
    const pdf = minimalPdfBytes();
    const truncated = Buffer.from(pdf.subarray(0, pdf.length - 6));

    await expect(
      uploadPdfBuffer(supabase, 'website-dev', 'resumes', 'resume', truncated)
    ).rejects.toThrow(/incomplete|corrupted/i);

    expect(upload).not.toHaveBeenCalled();
  });

  it('stores a complete PDF at a unique path with the pinned content type', async () => {
    const { supabase, upload } = fakeStorage();
    const pdf = Buffer.from(minimalPdfBytes());

    const result = await uploadPdfBuffer(
      supabase,
      'website-dev',
      'resumes',
      'resume',
      pdf
    );

    expect(result.path).toMatch(/^resumes\/\d+-[a-f0-9-]+-resume\.pdf$/);
    expect(upload).toHaveBeenCalledWith(result.path, pdf, {
      cacheControl: '3600',
      contentType: 'application/pdf',
      upsert: false,
    });
    expect(result.publicUrl).toBe(`https://cdn.test/${result.path}`);
  });
});

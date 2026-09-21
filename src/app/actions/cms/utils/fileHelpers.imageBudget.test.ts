import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/libs/cms/supabase/admin', () => ({ getCmsAdminClient: vi.fn() }));

/** WebP container header that declares an animation (VP8X animation flag). */
function animatedWebpFile(): File {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
  bytes[20] = 0x02;
  return new File([bytes], 'huge.webp', { type: 'image/webp' });
}

describe('processImage — animated decode budget', () => {
  it('rejects an oversized animation after reading metadata only', async () => {
    vi.resetModules();
    // 2048x2048 x 16 frames = 67 MPx, above the 32 MPx decoded-pixel budget.
    // sharp is the boundary here: only its container metadata is needed to
    // prove the guard fires before any frame is decoded.
    const resize = vi.fn();
    const webp = vi.fn();
    const sharp = vi.fn(() => ({
      metadata: vi.fn(async () => ({
        format: 'webp',
        width: 2048,
        height: 2048,
        pages: 16,
      })),
      resize,
      webp,
    }));
    vi.doMock('sharp', () => ({ default: sharp }));

    const { processImage } = await import('./fileHelpers');

    const result = await processImage(animatedWebpFile(), {
      maxWidth: 512,
      maxHeight: 512,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
    // Called once for metadata; no frame was decoded, resized or encoded.
    expect(sharp).toHaveBeenCalledTimes(1);
    expect(resize).not.toHaveBeenCalled();
    expect(webp).not.toHaveBeenCalled();
  });
});

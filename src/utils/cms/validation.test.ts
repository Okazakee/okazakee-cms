import { describe, expect, it } from 'vitest';
import {
  getStoragePathFromPublicUrl,
  isValidDate,
  isValidUrl,
  sanitizeFilename,
  validateImageFile,
  validatePdfFile,
} from '@/utils/cms/validation';

function makeFile(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('sanitizeFilename', () => {
  it('lowercases and trims', () => {
    expect(sanitizeFilename('  My Post  ')).toBe('my-post');
  });

  it('replaces spaces and special characters with hyphens', () => {
    // Special chars are stripped (not converted to hyphens), spaces collapse
    expect(sanitizeFilename('Hello World! How@Are You?')).toBe(
      'hello-world-howare-you'
    );
  });

  it('collapses repeated hyphens', () => {
    expect(sanitizeFilename('a  b   c')).toBe('a-b-c');
  });

  it('limits length to 50 chars', () => {
    const long = 'x'.repeat(120);
    expect(sanitizeFilename(long)).toHaveLength(50);
  });

  it('handles empty input', () => {
    expect(sanitizeFilename('')).toBe('');
  });
});

describe('validateImageFile', () => {
  it('rejects SVG by MIME type', () => {
    const result = validateImageFile(makeFile('evil.svg', 'image/svg+xml'));
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/SVG/i);
  });

  it('rejects SVG by extension even with generic MIME', () => {
    const result = validateImageFile(
      makeFile('evil.svg', 'application/octet-stream')
    );
    expect(result.isValid).toBe(false);
  });

  it('accepts JPEG, PNG, WebP, GIF, AVIF', () => {
    for (const type of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/avif',
    ]) {
      expect(
        validateImageFile(makeFile(`img.${type.split('/')[1]}`, type)).isValid
      ).toBe(true);
    }
  });

  it('rejects unsupported MIME types', () => {
    const result = validateImageFile(makeFile('doc.pdf', 'application/pdf'));
    expect(result.isValid).toBe(false);
  });

  it('rejects files over 10MB', () => {
    const result = validateImageFile(
      makeFile('big.png', 'image/png', 10 * 1024 * 1024 + 1)
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/10MB/i);
  });

  it('accepts a file exactly at 10MB boundary', () => {
    const result = validateImageFile(
      makeFile('big.png', 'image/png', 10 * 1024 * 1024)
    );
    expect(result.isValid).toBe(true);
  });

  it('rejects over-long filenames', () => {
    const longName = `${'n'.repeat(256)}.png`;
    const result = validateImageFile(makeFile(longName, 'image/png'));
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/name is too long/i);
  });
});

describe('validatePdfFile', () => {
  it('accepts PDF MIME with pdf extension', () => {
    expect(validatePdfFile(makeFile('cv.pdf', 'application/pdf')).isValid).toBe(
      true
    );
  });

  it('accepts pdf extension with empty MIME (common on some platforms)', () => {
    expect(validatePdfFile(makeFile('cv.pdf', '')).isValid).toBe(true);
  });

  it('accepts pdf extension with octet-stream MIME', () => {
    expect(
      validatePdfFile(makeFile('cv.pdf', 'application/octet-stream')).isValid
    ).toBe(true);
  });

  it('rejects non-PDF extension with non-PDF MIME', () => {
    expect(validatePdfFile(makeFile('cv.png', 'image/png')).isValid).toBe(
      false
    );
  });

  it('accepts PDF MIME even with a non-pdf filename (characterized behavior)', () => {
    // The validator treats application/pdf MIME alone as sufficient
    expect(validatePdfFile(makeFile('cv.png', 'application/pdf')).isValid).toBe(
      true
    );
  });

  it('rejects oversized PDFs', () => {
    const result = validatePdfFile(
      makeFile('cv.pdf', 'application/pdf', 10 * 1024 * 1024 + 1)
    );
    expect(result.isValid).toBe(false);
  });
});

describe('getStoragePathFromPublicUrl', () => {
  const base = 'https://xxx.supabase.co/storage/v1/object/public/website';

  it('extracts path after bucket segment', () => {
    expect(
      getStoragePathFromPublicUrl(
        `${base}/Website%20Assets/blog/123-hello.webp`,
        'website'
      )
    ).toBe('Website Assets/blog/123-hello.webp');
  });

  it('returns null when bucket is absent', () => {
    expect(
      getStoragePathFromPublicUrl(
        'https://example.com/some/path.webp',
        'website'
      )
    ).toBeNull();
  });

  it('returns null on malformed URL', () => {
    expect(getStoragePathFromPublicUrl('not-a-url', 'website')).toBeNull();
  });

  it('ignores query strings (cache busters)', () => {
    expect(
      getStoragePathFromPublicUrl(
        `${base}/avatar/avatar.webp?t=123456`,
        'website'
      )
    ).toBe('avatar/avatar.webp');
  });

  it('returns null for bucket root', () => {
    expect(getStoragePathFromPublicUrl(`${base}/`, 'website')).toBeNull();
  });
});

describe('isValidUrl', () => {
  it('accepts empty/whitespace as valid (optional field semantics)', () => {
    expect(isValidUrl('')).toBe(true);
    expect(isValidUrl('   ')).toBe(true);
  });

  it('accepts http/https URLs', () => {
    expect(isValidUrl('https://example.com/path')).toBe(true);
    expect(isValidUrl('http://localhost:3000')).toBe(true);
  });

  // Characterization: the current generic predicate accepts ANY scheme
  // `new URL` parses. Context-specific scheme allowlists are a Phase 2 fix.
  it('currently accepts non-web schemes (characterized, to be tightened)', () => {
    expect(isValidUrl('javascript:alert(1)')).toBe(true);
    expect(isValidUrl('file:///etc/passwd')).toBe(true);
    expect(isValidUrl('ftp://example.com/file')).toBe(true);
  });

  it('rejects unparseable strings', () => {
    expect(isValidUrl('not a url')).toBe(false);
    expect(isValidUrl('example.com')).toBe(false);
  });
});

describe('isValidDate', () => {
  it('accepts ISO and parseable dates', () => {
    expect(isValidDate('2026-08-17T09:00:00.000Z')).toBe(true);
    expect(isValidDate('2026-08-17')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidDate('')).toBe(false);
    expect(isValidDate('not-a-date')).toBe(false);
    expect(isValidDate('2026-99-99')).toBe(false);
  });
});

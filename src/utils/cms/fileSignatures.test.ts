import { describe, expect, it } from 'vitest';
import {
  detectRasterFormat,
  gifHasTrailer,
  hasPdfHeader,
  hasPdfTrailer,
  hasWebpImageChunkHeader,
  imageFormatForMime,
  inspectWebpContainer,
  jpegHasEoi,
  pngHasIend,
  startsWithMarkup,
  webpDeclaredPayloadSize,
} from '@/utils/cms/fileSignatures';
import {
  animatedWebpBytes,
  avifBytes,
  gifBytes,
  jpegBytes,
  minimalPdfBytes,
  pngBytes,
  staticWebpBytes,
} from '@/testing/unit/fileFixtures';

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Copy with one byte replaced, leaving the fixture untouched. */
function patched(
  bytes: Uint8Array,
  offset: number,
  values: ArrayLike<number>
): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy.set(values, offset);
  return copy;
}

describe('detectRasterFormat', () => {
  it('detects every supported container from real bytes', () => {
    expect(detectRasterFormat(staticWebpBytes())).toBe('webp');
    expect(detectRasterFormat(animatedWebpBytes())).toBe('webp');
    expect(detectRasterFormat(pngBytes())).toBe('png');
    expect(detectRasterFormat(jpegBytes())).toBe('jpeg');
    expect(detectRasterFormat(gifBytes())).toBe('gif');
    expect(detectRasterFormat(avifBytes())).toBe('avif');
  });

  it('returns null for markup, text and unknown binary content', () => {
    expect(detectRasterFormat(ascii('<svg xmlns="..."></svg>'))).toBeNull();
    expect(detectRasterFormat(ascii('plain text file'))).toBeNull();
    expect(detectRasterFormat(new Uint8Array(0))).toBeNull();
    expect(detectRasterFormat(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('requires an AVIF brand inside the ftyp box', () => {
    // A structurally valid ISO-BMFF header with a non-AVIF brand only.
    const heic = new Uint8Array(24);
    heic.set([0x00, 0x00, 0x00, 0x18], 0);
    heic.set(ascii('ftyp'), 4);
    heic.set(ascii('heic'), 8);
    expect(detectRasterFormat(heic)).toBeNull();
  });
});

describe('startsWithMarkup', () => {
  it('rejects SVG, XML, HTML and doctype prefixes', () => {
    expect(startsWithMarkup(ascii('<svg></svg>'))).toBe(true);
    expect(startsWithMarkup(ascii('<?xml version="1.0"?><svg/>'))).toBe(true);
    expect(startsWithMarkup(ascii('<!DOCTYPE html><html></html>'))).toBe(true);
  });

  it('sees through a UTF-8 BOM and leading ASCII whitespace', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const payload = ascii('  \n\t<html></html>');
    const bytes = new Uint8Array(bom.length + payload.length);
    bytes.set(bom);
    bytes.set(payload, bom.length);
    expect(startsWithMarkup(bytes)).toBe(true);
  });

  it('does not flag binary container headers', () => {
    expect(startsWithMarkup(staticWebpBytes())).toBe(false);
    expect(startsWithMarkup(pngBytes())).toBe(false);
    expect(startsWithMarkup(ascii('%PDF-1.4'))).toBe(false);
    expect(startsWithMarkup(new Uint8Array(0))).toBe(false);
  });
});

describe('WebP container structure', () => {
  it('reads the declared RIFF payload size', () => {
    expect(webpDeclaredPayloadSize(staticWebpBytes())).toBe(
      staticWebpBytes().length - 8
    );
    expect(webpDeclaredPayloadSize(animatedWebpBytes())).toBe(
      animatedWebpBytes().length - 8
    );
    expect(webpDeclaredPayloadSize(ascii('not a webp file'))).toBeNull();
  });

  it('requires the first chunk to be an image chunk', () => {
    expect(hasWebpImageChunkHeader(staticWebpBytes())).toBe(true);
    expect(hasWebpImageChunkHeader(animatedWebpBytes())).toBe(true);
    expect(
      hasWebpImageChunkHeader(
        patched(staticWebpBytes(), 12, ascii('JUNK').slice(0, 4))
      )
    ).toBe(false);
  });

  it('accepts real static and animated containers', () => {
    expect(inspectWebpContainer(staticWebpBytes())).toBe(true);
    expect(inspectWebpContainer(animatedWebpBytes())).toBe(true);
  });

  it('rejects a truncated container', () => {
    expect(inspectWebpContainer(staticWebpBytes().slice(0, -1))).toBe(false);
    expect(inspectWebpContainer(animatedWebpBytes().slice(0, -1))).toBe(false);
  });

  it('rejects a declared payload larger or smaller than the file', () => {
    const larger = patched(staticWebpBytes(), 4, [0x40, 0x00, 0x00, 0x00]);
    expect(inspectWebpContainer(larger)).toBe(false);

    const smaller = patched(staticWebpBytes(), 4, [0x08, 0x00, 0x00, 0x00]);
    expect(inspectWebpContainer(smaller)).toBe(false);
  });

  it('rejects trailing garbage outside the declared payload', () => {
    const bytes = new Uint8Array(staticWebpBytes().length + 4);
    bytes.set(staticWebpBytes());
    expect(inspectWebpContainer(bytes)).toBe(false);
  });

  it('rejects a chunk whose size overruns the payload', () => {
    const corrupt = patched(staticWebpBytes(), 16, [0xff, 0xff, 0x00, 0x00]);
    expect(inspectWebpContainer(corrupt)).toBe(false);
  });

  it('rejects an 8-byte RIFF header with no chunks', () => {
    const headerOnly = staticWebpBytes().slice(0, 8);
    expect(inspectWebpContainer(headerOnly)).toBe(false);
  });
});

describe('trailer scanners', () => {
  it('finds the PNG IEND chunk with its zero length field', () => {
    expect(pngHasIend(pngBytes())).toBe(true);
    expect(pngHasIend(pngBytes().slice(0, -12))).toBe(false);
    expect(pngHasIend(ascii('AAAAIENDaaaaaaaa'))).toBe(false);
  });

  it('finds the JPEG EOI marker, tolerating zero padding', () => {
    expect(jpegHasEoi(jpegBytes())).toBe(true);
    expect(jpegHasEoi(jpegBytes().slice(0, -2))).toBe(false);

    const padded = new Uint8Array(jpegBytes().length + 2);
    padded.set(jpegBytes());
    expect(jpegHasEoi(padded)).toBe(true);
  });

  it('finds the GIF trailer byte', () => {
    expect(gifHasTrailer(gifBytes())).toBe(true);
    expect(gifHasTrailer(gifBytes().slice(0, -1))).toBe(false);
    expect(gifHasTrailer(ascii('GIF89a without trailer'))).toBe(false);
  });
});

describe('PDF markers', () => {
  it('finds the header and trailer in a real document', () => {
    const pdf = minimalPdfBytes();
    expect(hasPdfHeader(pdf.subarray(0, 1024))).toBe(true);
    expect(hasPdfTrailer(pdf.subarray(-1024))).toBe(true);
  });

  it('accepts a header preceded by bytes (PDF allows up to 1 KiB)', () => {
    const prefix = ascii(' '.repeat(200));
    const pdf = minimalPdfBytes();
    const bytes = new Uint8Array(prefix.length + pdf.length);
    bytes.set(prefix);
    bytes.set(pdf, prefix.length);
    expect(hasPdfHeader(bytes.subarray(0, 1024))).toBe(true);
  });

  it('rejects documents without the header or the trailer', () => {
    expect(hasPdfHeader(ascii('<html>not a pdf</html>'))).toBe(false);
    expect(hasPdfTrailer(ascii('%PDF-1.4 no trailer here'))).toBe(false);
  });
});

describe('imageFormatForMime', () => {
  it('maps supported MIME types including the image/jpg alias', () => {
    expect(imageFormatForMime('image/jpeg')).toBe('jpeg');
    expect(imageFormatForMime('image/jpg')).toBe('jpeg');
    expect(imageFormatForMime('image/png')).toBe('png');
    expect(imageFormatForMime('image/webp')).toBe('webp');
    expect(imageFormatForMime('image/gif')).toBe('gif');
    expect(imageFormatForMime('image/avif')).toBe('avif');
    expect(imageFormatForMime('IMAGE/PNG')).toBe('png');
  });

  it('returns null for SVG, HTML and unknown types', () => {
    expect(imageFormatForMime('image/svg+xml')).toBeNull();
    expect(imageFormatForMime('text/html')).toBeNull();
    expect(imageFormatForMime('application/pdf')).toBeNull();
  });
});

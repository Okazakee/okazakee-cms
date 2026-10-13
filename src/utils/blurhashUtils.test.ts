import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BLUR_DATA_URL,
  isValidBlurPlaceholder,
  resolveBlurDataURL,
  resolveBlurPlaceholder,
} from './blurhashUtils';
import { committedImageMarkdown, parseBodyImages } from './cms/postBody';

describe('isValidBlurPlaceholder', () => {
  it('accepts new-format data URLs', () => {
    expect(isValidBlurPlaceholder(FALLBACK_BLUR_DATA_URL)).toBe(true);
  });

  it('rejects legacy raw hashes', () => {
    expect(isValidBlurPlaceholder('L6PZfSi_.AyE_3t7t7R**0o#DgR4')).toBe(
      false
    );
  });

  it('rejects missing and malformed values', () => {
    expect(isValidBlurPlaceholder(null)).toBe(false);
    expect(isValidBlurPlaceholder(undefined)).toBe(false);
    expect(isValidBlurPlaceholder('')).toBe(false);
    expect(isValidBlurPlaceholder('not-a-data-url')).toBe(false);
    expect(isValidBlurPlaceholder('data:text/plain;base64,xxx')).toBe(
      false
    );
  });
});

describe('resolveBlurDataURL', () => {
  it('passes data URLs through, degrades everything else', () => {
    expect(resolveBlurDataURL(FALLBACK_BLUR_DATA_URL)).toBe(
      FALLBACK_BLUR_DATA_URL
    );
    expect(resolveBlurDataURL('L6PZfSi_.AyE_3t7t7R**0o#DgR4')).toBe(
      undefined
    );
    expect(resolveBlurDataURL(null)).toBe(undefined);
    expect(resolveBlurDataURL('')).toBe(undefined);
  });

  it('selects the matching next/image placeholder mode', () => {
    expect(resolveBlurPlaceholder(FALLBACK_BLUR_DATA_URL)).toBe('blur');
    expect(resolveBlurPlaceholder('L6PZfSi_.AyE_3t7t7R**0o#DgR4')).toBe(
      'empty'
    );
    expect(resolveBlurPlaceholder(null)).toBe('empty');
  });
});

describe('body placeholder with dashes', () => {
  it('keeps the full remainder after the first dash', () => {
    const refs = parseBodyImages(
      '![Caption-L6PZ-abc-def](https://h.test/f.webp)'
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.caption).toBe('Caption');
    expect(refs[0]?.hash).toBe('L6PZ-abc-def');
  });

  it('round-trips a data URL placeholder to WS parsing', () => {
    const committed = committedImageMarkdown(
      'My photo',
      FALLBACK_BLUR_DATA_URL,
      'https://cdn.test/blog/1.webp'
    );
    const refs = parseBodyImages(committed);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.caption).toBe('My photo');
    expect(refs[0]?.hash).toBe(FALLBACK_BLUR_DATA_URL);
    expect(resolveBlurDataURL(refs[0]?.hash)).toBe(FALLBACK_BLUR_DATA_URL);
  });
});

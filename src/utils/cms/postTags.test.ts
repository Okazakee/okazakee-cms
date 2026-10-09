import { describe, expect, it } from 'vitest';
import {
  isCanonicalPostTags,
  parsePostTags,
  serializePostTags,
} from './postTags';

describe('parsePostTags', () => {
  it('reads legacy and canonical forms identically', () => {
    expect(parsePostTags('"a" "b"')).toEqual(['a', 'b']);
    expect(parsePostTags('["a","b"]')).toEqual(['a', 'b']);
    expect(parsePostTags('')).toEqual([]);
    expect(parsePostTags('[]')).toEqual([]);
  });

  it('trims, dedupes and drops empties', () => {
    expect(parsePostTags('" a " "a" ""')).toEqual(['a']);
  });
});

describe('serializePostTags', () => {
  it('writes the canonical JSON form', () => {
    expect(serializePostTags(['a', 'b'])).toBe('["a","b"]');
    expect(serializePostTags([])).toBe('');
    expect(serializePostTags([' a ', 'a'])).toBe('["a"]');
  });
});

describe('isCanonicalPostTags', () => {
  it('detects canonical vs legacy storage', () => {
    expect(isCanonicalPostTags('["a","b"]')).toBe(true);
    expect(isCanonicalPostTags('"a" "b"')).toBe(false);
    expect(isCanonicalPostTags('')).toBe(true);
  });
});

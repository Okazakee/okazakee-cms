import { describe, expect, it } from 'vitest';
import {
  normalizeLogoUrl,
  normalizeNavAnchor,
  navItemIds,
  parseNavAnchorDrafts,
  validateNavAnchors,
} from '@/utils/cms/navAnchors';

const defaults = parseNavAnchorDrafts(null);

describe('normalizeNavAnchor', () => {
  it('accepts a fragment-safe element id, with or without a leading hash', () => {
    expect(normalizeNavAnchor('career')).toBe('career');
    expect(normalizeNavAnchor('#career')).toBe('career');
    expect(normalizeNavAnchor(' work-history ')).toBe('work-history');
  });

  it('rejects anything that could not be an element id', () => {
    expect(normalizeNavAnchor('')).toBeNull();
    expect(normalizeNavAnchor('#')).toBeNull();
    expect(normalizeNavAnchor('/career')).toBeNull();
    expect(normalizeNavAnchor('two words')).toBeNull();
    expect(normalizeNavAnchor('2fa')).toBeNull();
    expect(normalizeNavAnchor(7)).toBeNull();
  });
});

describe('normalizeLogoUrl', () => {
  it('keeps an absolute http(s) URL', () => {
    expect(normalizeLogoUrl(' https://cdn.example.test/logo.webp ')).toBe(
      'https://cdn.example.test/logo.webp'
    );
  });

  it('treats blank and non-http values as unconfigured', () => {
    expect(normalizeLogoUrl(null)).toBeNull();
    expect(normalizeLogoUrl('  ')).toBeNull();
    expect(normalizeLogoUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLogoUrl('/local.png')).toBeNull();
  });
});

describe('parseNavAnchorDrafts', () => {
  it('always returns the six items in nav order, defaulting each anchor', () => {
    expect(defaults).toEqual([
      { id: 'home', anchor: 'home' },
      { id: 'skills', anchor: 'skills' },
      { id: 'career', anchor: 'career' },
      { id: 'portfolio', anchor: 'portfolio' },
      { id: 'blog', anchor: 'blog' },
      { id: 'contacts', anchor: 'contacts' },
    ]);
  });

  it('reads anchors by id so a reordered row still lines up with the labels', () => {
    const drafts = parseNavAnchorDrafts([
      { id: 'contacts', anchor: 'reach-out' },
      { id: 'skills', anchor: 'toolbox' },
    ]);
    expect(drafts[1]).toEqual({ id: 'skills', anchor: 'toolbox' });
    expect(drafts[5]).toEqual({ id: 'contacts', anchor: 'reach-out' });
    expect(drafts.map((entry) => entry.id)).toEqual([...navItemIds]);
  });

  it('ignores unknown ids and unusable anchors', () => {
    const drafts = parseNavAnchorDrafts([
      { id: 'nope', anchor: 'ignored' },
      { id: 'blog', anchor: '/blog' },
      { id: 'career', anchor: '' },
      'garbage',
    ]);
    expect(drafts).toEqual(defaults);
  });
});

describe('validateNavAnchors', () => {
  it('accepts a well-formed list and returns the normalised value', () => {
    const result = validateNavAnchors([
      { id: 'home', anchor: 'top' },
      { id: 'skills', anchor: '' },
      { id: 'career', anchor: '#work-history' },
    ]);
    expect(result).toEqual({
      isValid: true,
      anchors: [
        { id: 'home', anchor: 'top' },
        { id: 'skills', anchor: 'skills' },
        { id: 'career', anchor: 'work-history' },
        { id: 'portfolio', anchor: 'portfolio' },
        { id: 'blog', anchor: 'blog' },
        { id: 'contacts', anchor: 'contacts' },
      ],
    });
  });

  it('treats an absent value as "never arranged"', () => {
    expect(validateNavAnchors(null)).toEqual({
      isValid: true,
      anchors: defaults,
    });
  });

  it('rejects a value that is not a list', () => {
    expect(validateNavAnchors('nope').isValid).toBe(false);
  });

  it('rejects an unknown item id', () => {
    const result = validateNavAnchors([{ id: 'sidebar', anchor: 'x' }]);
    expect(result.isValid).toBe(false);
    expect(result.isValid === false && result.error).toContain('valid item');
  });

  it('rejects a duplicated id, which would move an anchor onto another label', () => {
    const result = validateNavAnchors([
      { id: 'blog', anchor: 'a' },
      { id: 'blog', anchor: 'b' },
    ]);
    expect(result.isValid).toBe(false);
    expect(result.isValid === false && result.error).toContain('twice');
  });

  it('rejects an anchor that is not a fragment-safe element id', () => {
    const result = validateNavAnchors([{ id: 'blog', anchor: '/blog' }]);
    expect(result.isValid).toBe(false);
    expect(result.isValid === false && result.error).toContain('element id');
  });
});

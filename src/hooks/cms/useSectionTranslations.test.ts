import { describe, expect, it } from 'vitest';
import {
  buildTranslationDelta,
  buildTranslationSections,
  unflattenDelta,
} from '@/hooks/cms/useSectionTranslations';

describe('unflattenDelta', () => {
  it('keeps numeric path segments as object maps, never arrays', () => {
    const result = unflattenDelta({
      'items.0.title': 'a',
      'items.1.title': 'b',
    });

    expect(Array.isArray((result.items as Record<string, unknown>)['0'])).toBe(
      false
    );
    expect(result).toEqual({
      items: { 0: { title: 'a' }, 1: { title: 'b' } },
    });
  });
});

describe('buildTranslationDelta', () => {
  it('includes only changed fields', () => {
    const delta = buildTranslationDelta(
      { title: 'old', subtitle: 'same' },
      { title: 'new', subtitle: 'same' }
    );

    expect(delta).toEqual({ title: 'new' });
  });

  it('returns an empty object when nothing changed', () => {
    expect(buildTranslationDelta({ a: '1' }, { a: '1' })).toEqual({});
  });

  it('nests only the changed array field per index', () => {
    const delta = buildTranslationDelta(
      { 'items.0.title': 'a', 'items.1.title': 'b' },
      { 'items.0.title': 'a', 'items.1.title': 'B' }
    );

    expect(delta).toEqual({ items: { 1: { title: 'B' } } });
  });
});

describe('buildTranslationSections', () => {
  it('emits a delta only for the changed locale', () => {
    const sections = buildTranslationSections(
      { en: { title: 'en-old' }, it: { title: 'it-same' } },
      { en: { title: 'en-new' }, it: { title: 'it-same' } }
    );

    expect(sections).toEqual({ en: { title: 'en-new' } });
  });

  it('emits nothing when no locale changed', () => {
    expect(
      buildTranslationSections(
        { en: { a: '1' }, it: { a: '2' } },
        { en: { a: '1' }, it: { a: '2' } }
      )
    ).toEqual({});
  });

  it('sends nested numeric patches as object maps for both locales', () => {
    const sections = buildTranslationSections(
      { en: { 'x.0.y': 'a' }, it: { 'x.0.y': 'a' } },
      { en: { 'x.0.y': 'b' }, it: { 'x.0.y': 'c' } }
    );

    expect(sections).toEqual({
      en: { x: { 0: { y: 'b' } } },
      it: { x: { 0: { y: 'c' } } },
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeTranslationDelta,
  isEmptyDelta,
  mergeTranslationDelta,
} from './translationDelta';

describe('mergeTranslationDelta', () => {
  it('merges nested objects without clobbering concurrent keys', () => {
    const base = { hero: { title: 'A', subtitle: 'keep me' }, other: 1 };
    const merged = mergeTranslationDelta(base, {
      hero: { title: 'B' },
    }) as typeof base;

    expect(merged.hero.title).toBe('B');
    expect(merged.hero.subtitle).toBe('keep me');
    expect(merged.other).toBe(1);
    expect(base.hero.title).toBe('A');
  });

  it('merges arrays by index', () => {
    const base = { items: [{ a: 1, b: 2 }, { c: 3 }] };
    const merged = mergeTranslationDelta(base, {
      items: [{ a: 9 }],
    }) as typeof base;

    expect(merged.items[0]).toEqual({ a: 9, b: 2 });
    expect(merged.items[1]).toEqual({ c: 3 });
  });

  it('treats an all-numeric-key object as a sparse array map', () => {
    const base = { items: ['a', 'b', 'c'] };
    const merged = mergeTranslationDelta(base, {
      items: { 1: 'B' } as unknown as string[],
    }) as typeof base;

    expect(merged.items).toEqual(['a', 'B', 'c']);
  });

  it('creates an array when the sparse map has no base array', () => {
    const merged = mergeTranslationDelta({}, { items: { 2: 'x' } as unknown });
    expect(merged).toEqual({ items: [undefined, undefined, 'x'] });
  });

  it('drops prototype-polluting keys at every depth', () => {
    const delta = JSON.parse(
      '{"ok":1,"__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"prototype":{"y":2}}}'
    );
    const merged = mergeTranslationDelta({}, delta) as Record<string, unknown>;

    expect(merged.ok).toBe(1);
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
    expect((merged.nested as Record<string, unknown>).constructor).toBe(Object);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not mutate the base on prototype-clone', () => {
    const base = { a: 1 };
    const merged = mergeTranslationDelta(base, {
      __proto__: { evil: true },
    } as Record<string, unknown>) as Record<string, unknown>;
    expect(merged.a).toBe(1);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe('computeTranslationDelta', () => {
  it('emits only changed keys and marks removals as null', () => {
    const previous = { a: 1, b: { c: 2, d: 3 }, gone: true };
    const next = { a: 1, b: { c: 5 } };
    expect(computeTranslationDelta(previous, next)).toEqual({
      b: { c: 5, d: null },
      gone: null,
    });
  });

  it('emits whole arrays when they differ', () => {
    expect(computeTranslationDelta([1, 2], [1, 3])).toEqual([1, 3]);
    expect(computeTranslationDelta([1, 2], [1, 2])).toBeUndefined();
  });

  it('round-trips through mergeTranslationDelta', () => {
    const previous = { a: 1, list: ['x', 'y'], nested: { keep: 1, change: 1 } };
    const next = { a: 1, list: ['x', 'z'], nested: { keep: 1, change: 2 } };
    const merged = mergeTranslationDelta(
      previous,
      computeTranslationDelta(previous, next)
    );
    expect(merged).toEqual(next);
  });
});

describe('isEmptyDelta', () => {
  it('recognizes empty deltas', () => {
    expect(isEmptyDelta(undefined)).toBe(true);
    expect(isEmptyDelta({})).toBe(true);
    expect(isEmptyDelta({ a: 1 })).toBe(false);
    expect(isEmptyDelta(null)).toBe(false);
  });
});

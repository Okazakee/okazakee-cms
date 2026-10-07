import { describe, expect, it } from 'vitest';
import {
  countHeroRoleEntries,
  heroBackdropClass,
  heroPortraitClass,
  heroRolePath,
  heroShapes,
  normalizeHeroShape,
  normalizeTypewriterTarget,
  resolveHeroRoles,
  squircleClipPath,
} from '@/utils/heroDisplay';

/** Geometry each preset must apply to BOTH the accent plate and the mask. */
const presetGeometry = {
  pebble: 'clip-pebble',
  square: '',
  rounded: 'rounded-[15%]',
  squircle: 'clip-squircle',
} as const;

describe('portrait shape presets', () => {
  it('keeps every stored preset', () => {
    for (const shape of ['pebble', 'square', 'rounded', 'squircle'] as const) {
      expect(normalizeHeroShape(shape)).toBe(shape);
    }
  });

  it('falls back to the pebble for absent and unknown values', () => {
    expect(normalizeHeroShape(null)).toBe('pebble');
    expect(normalizeHeroShape(undefined)).toBe('pebble');
    expect(normalizeHeroShape('hexagon')).toBe('pebble');
  });

  it('insets every preset by the same ring, inside a plate that fills the box', () => {
    const ringInset = 'inset-[2.15%]';

    for (const shape of heroShapes) {
      const mask = heroPortraitClass(shape);
      const plate = heroBackdropClass(shape);

      expect(mask).toContain('absolute');
      expect(mask).toContain(ringInset);
      expect(mask).toContain('overflow-hidden');
      expect(plate).toContain('inset-0');
      expect(plate).toContain('bg-accent-violet');

      // One geometry for both outlines keeps the ring a constant width.
      const geometry = presetGeometry[shape];
      if (geometry) {
        expect(mask).toContain(geometry);
        expect(plate).toContain(geometry);
      }
    }
  });

  it('scales the rounded radius and keeps the square preset unrounded', () => {
    expect(heroPortraitClass('rounded')).toMatch(/rounded-\[\d+%\]/);
    expect(heroPortraitClass('square')).not.toMatch(/rounded|clip-/);
  });

  it('samples the same squircle path the website clips with', () => {
    expect(squircleClipPath()).toBe(squircleClipPath());
    expect(squircleClipPath().startsWith('M ')).toBe(true);
  });
});

describe('roles editor entries', () => {
  it('numbers the roles the way the translation delta is keyed', () => {
    expect(heroRolePath(0)).toBe('top.roles.0');
    expect(heroRolePath(2)).toBe('top.roles.2');
  });

  it('counts one past the highest filled index and skips holes', () => {
    expect(countHeroRoleEntries({})).toBe(0);
    expect(countHeroRoleEntries({ 'top.role': 'Dev' })).toBe(0);
    expect(countHeroRoleEntries({ 'top.roles.0': 'Dev' })).toBe(1);
    expect(
      countHeroRoleEntries({ 'top.roles.0': 'Dev', 'top.roles.1': '' })
    ).toBe(1);
    expect(
      countHeroRoleEntries({ 'top.roles.2': 'Third', 'top.roles.1': 'Second' })
    ).toBe(3);
  });
});

describe('roles fallback', () => {
  it('renders the singular role when no list was ever written', () => {
    expect(resolveHeroRoles(undefined, 'Fullstack Developer')).toEqual([
      'Fullstack Developer',
    ]);
    expect(resolveHeroRoles({ 0: '' }, 'Fullstack Developer')).toEqual([
      'Fullstack Developer',
    ]);
  });

  it('orders the stored list and drops the holes a removal leaves', () => {
    expect(resolveHeroRoles({ 1: 'Second', 0: 'First' }, 'Legacy')).toEqual([
      'First',
      'Second',
    ]);
    expect(resolveHeroRoles(['First', null, 'Second'], 'Legacy')).toEqual([
      'First',
      'Second',
    ]);
  });
});

describe('typewriter target', () => {
  it('falls back to the first role for an absent or unknown target', () => {
    expect(normalizeTypewriterTarget(null)).toBe('role1');
    expect(normalizeTypewriterTarget('role9')).toBe('role1');
    expect(normalizeTypewriterTarget('all')).toBe('all');
  });
});

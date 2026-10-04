import { describe, expect, it } from 'vitest';
import {
  countHeroRoleEntries,
  heroPortraitClass,
  heroRolePath,
  normalizeHeroShape,
  normalizeTypewriterTarget,
  resolveHeroRoles,
  squircleClipPath,
} from '@/utils/heroDisplay';

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

  it('clips the pebble portrait exactly as the website always has', () => {
    expect(heroPortraitClass('pebble')).toBe(
      'clip-pebble relative h-full w-full'
    );
    expect(heroPortraitClass('squircle')).toBe(
      'clip-squircle relative h-full w-full'
    );
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

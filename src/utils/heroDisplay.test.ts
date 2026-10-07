import { describe, expect, it } from 'vitest';
import {
  countHeroRoleEntries,
  heroRolePath,
  normalizeHeroShape,
  normalizeTypewriterTarget,
} from '@/utils/heroDisplay';

describe('shape presets', () => {
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

describe('typewriter target', () => {
  it('falls back to the first role for an absent or unknown target', () => {
    expect(normalizeTypewriterTarget(null)).toBe('role1');
    expect(normalizeTypewriterTarget('role9')).toBe('role1');
    expect(normalizeTypewriterTarget('all')).toBe('all');
  });
});
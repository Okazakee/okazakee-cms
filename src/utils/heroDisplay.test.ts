import { describe, expect, it } from 'vitest';
import {
  countHeroRoleEntries,
  heroRolePath,
  normalizeHeroShape,
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

  it('counts empty draft slots so adding another role preserves the first', () => {
    expect(countHeroRoleEntries({})).toBe(0);
    expect(countHeroRoleEntries({ 'top.roles.0': 'Dev' })).toBe(1);
    expect(
      countHeroRoleEntries({ 'top.roles.0': 'Dev', 'top.roles.1': '' })
    ).toBe(2);
    expect(
      countHeroRoleEntries({ 'top.roles.2': 'Third', 'top.roles.1': 'Second' })
    ).toBe(3);
  });
});

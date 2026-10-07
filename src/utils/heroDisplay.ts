import type { HeroShape, TypewriterTarget } from '@/types/fetchedData.types';

/**
 * Hero copy helpers for the editor: the stored presets the dropdowns offer and
 * the translation paths the roles editor writes. The website's own
 * `src/utils/heroDisplay.ts` is what renders the portrait; the editor only has
 * to name and normalise the values it stores.
 */

export const heroShapes = ['pebble', 'square', 'rounded', 'squircle'] as const;

export const typewriterTargets = ['role1', 'role2', 'all'] as const;

export function normalizeHeroShape(
  value: string | null | undefined
): HeroShape {
  return heroShapes.find((shape) => shape === value) ?? 'pebble';
}

export function normalizeTypewriterTarget(
  value: string | null | undefined
): TypewriterTarget {
  return typewriterTargets.find((target) => target === value) ?? 'role1';
}

/** Flat translation path of one `hero-section.top.roles` entry. */
export function heroRolePath(index: number): string {
  return `top.roles.${index}`;
}

/**
 * How many rows the roles editor shows: one past the highest filled index, so
 * an entry removed from the middle leaves no phantom row behind.
 */
export function countHeroRoleEntries(flat: Record<string, string>): number {
  let count = 0;
  for (const [path, value] of Object.entries(flat)) {
    const match = /^top\.roles\.(\d+)$/.exec(path);
    if (match && value.trim()) count = Math.max(count, Number(match[1]) + 1);
  }
  return count;
}
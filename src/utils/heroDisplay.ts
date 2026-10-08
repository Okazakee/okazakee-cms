import type { HeroShape } from '@/types/fetchedData.types';

/**
 * Hero copy helpers for the editor: the stored presets the dropdowns offer and
 * the translation paths the roles editor writes. The website's own
 * `src/utils/heroDisplay.ts` is what renders the portrait; the editor only has
 * to name and normalise the values it stores.
 */

export const heroShapes = ['pebble', 'square', 'rounded', 'squircle'] as const;

export function normalizeHeroShape(
  value: string | null | undefined
): HeroShape {
  return heroShapes.find((shape) => shape === value) ?? 'pebble';
}

/** Flat translation path of one `hero-section.top.roles` entry. */
export function heroRolePath(index: number): string {
  return `top.roles.${index}`;
}

/**
 * How many rows the roles editor shows: one past the highest stored index,
 * including empty drafts so adding a role always creates an editable row.
 */
export function countHeroRoleEntries(flat: Record<string, string>): number {
  let count = 0;
  for (const path of Object.keys(flat)) {
    const match = /^top\.roles\.(\d+)$/.exec(path);
    if (match) count = Math.max(count, Number(match[1]) + 1);
  }
  return count;
}

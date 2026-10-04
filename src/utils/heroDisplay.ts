import type { HeroShape, TypewriterTarget } from '@/types/fetchedData.types';

/**
 * Hero presentation helpers — the public site's `src/utils/heroDisplay.ts`,
 * mirrored so `HeroPreview` renders the same markup the website ships.
 */

export const heroShapes = ['pebble', 'square', 'rounded', 'squircle'] as const;

export const typewriterTargets = ['role1', 'role2', 'all'] as const;

/** Wrapper classes for the clipped portrait, joined with the box utilities. */
const heroShapeClasses: Record<HeroShape, string> = {
  pebble: 'clip-pebble',
  square: 'overflow-hidden',
  rounded: 'overflow-hidden rounded-xl',
  squircle: 'clip-squircle',
};

/** Accent plate behind the portrait; the pebble draws its own svg path. */
const heroBackdropClasses: Record<HeroShape, string> = {
  pebble: '',
  square: '',
  rounded: 'rounded-3xl',
  squircle: 'clip-squircle',
};

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

/** Full class list of the element wrapping the portrait image. */
export function heroPortraitClass(shape: HeroShape): string {
  return `${heroShapeClasses[shape]} relative h-full w-full`.trim();
}

/** Full class list of the accent plate behind the portrait. */
export function heroBackdropClass(shape: HeroShape): string {
  return `absolute -inset-3 z-0 ${heroBackdropClasses[shape]}`.trim();
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toOrderedStrings(value: unknown): string[] {
  if (typeof value === 'string') return isFilledString(value) ? [value] : [];
  if (Array.isArray(value)) return value.filter(isFilledString);
  if (isPlainObject(value)) {
    return Object.keys(value)
      .filter((key) => /^(0|[1-9]\d*)$/.test(key))
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => value[key])
      .filter(isFilledString);
  }
  return [];
}

/**
 * The role lines the preview shows: the `top.roles` list when present,
 * otherwise the singular `top.role` the website still falls back to.
 */
export function resolveHeroRoles(
  stored: unknown,
  singular: string | null | undefined
): string[] {
  const roles = toOrderedStrings(stored);
  if (roles.length > 0) return roles;
  return isFilledString(singular) ? [singular] : [];
}

// Superellipse (|x|^4 + |y|^4 = 1) sampled as an objectBoundingBox path, the
// shape the website's `clip-squircle` utility clips with.
const squircleExponent = 4;
const squircleQuadrantSamples = 24;

export function squircleClipPath(): string {
  const points: string[] = [];
  const total = squircleQuadrantSamples * 4;

  for (let index = 0; index < total; index++) {
    const angle = (2 * Math.PI * index) / total - Math.PI / 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const x = Math.sign(cosine) * Math.abs(cosine) ** (2 / squircleExponent);
    const y = Math.sign(sine) * Math.abs(sine) ** (2 / squircleExponent);
    points.push(`${((x + 1) / 2).toFixed(3)},${((y + 1) / 2).toFixed(3)}`);
  }

  return `M ${points.join(' L ')} Z`;
}

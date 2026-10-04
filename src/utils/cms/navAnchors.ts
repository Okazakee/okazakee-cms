/**
 * Navigation anchors for the public header, from the CMS side.
 *
 * The six nav DESTINATIONS are fixed site-side: their routes, and the `id=`
 * attributes of the sections they scroll to, are not editor-controlled. Only
 * the anchor each link points at is editable. The editor therefore cannot
 * retarget a nav item at another page — they can only name the anchor it
 * points at, and clearing that field restores the href the site has always
 * rendered.
 *
 * Stored as an ordered `[{ id, anchor }]` jsonb array, written index-aligned
 * with `header.buttons.N` (the labels are index-addressed too) and read by
 * `id`, so a reordered row still lands on the right item.
 */

import { isValidHttpUrl } from '@/utils/cms/validation';

/** Nav item ids in render order — index-aligned with `header.buttons.N`. */
export const navItemIds = [
  'home',
  'skills',
  'career',
  'portfolio',
  'blog',
  'contacts',
] as const;

export type NavItemId = (typeof navItemIds)[number];

export type NavAnchorDraft = { id: NavItemId; anchor: string };

/**
 * Fragment-safe element id: no leading `#`, no path/query characters, must
 * start with a letter. Returns null for anything else so an unusable value can
 * never become a broken href — the item then falls back to its default.
 */
export function normalizeNavAnchor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#+/, '');
  if (!trimmed) return null;
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed : null;
}

/**
 * Reads the stored jsonb into one anchor per nav item, always six long and
 * always in `navItemIds` order, so the editor and the site agree on which
 * anchor belongs to which label.
 */
export function parseNavAnchorDrafts(value: unknown): NavAnchorDraft[] {
  const stored = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, anchor } = entry as { id?: unknown; anchor?: unknown };
      if (typeof id !== 'string') continue;
      const normalized = normalizeNavAnchor(anchor);
      if (normalized) stored.set(id, normalized);
    }
  }
  return navItemIds.map((id) => ({ id, anchor: stored.get(id) ?? id }));
}

/** Absolute http(s) URL, or null so the reader falls back to the bundled asset. */
export function normalizeLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && isValidHttpUrl(trimmed) ? trimmed : null;
}

export type NavAnchorsValidation =
  | { isValid: true; anchors: NavAnchorDraft[] }
  | { isValid: false; error: string };

/**
 * Server-side guard for the submitted anchor array. It must list exactly the
 * six known nav ids once each, and every anchor must be a fragment-safe
 * element id (blank means "use the default", which is stored as the id). A
 * label is index-addressed, so a duplicated or missing id would silently move
 * an anchor onto the wrong label — that is rejected rather than coerced.
 * Returns the normalised value so the caller writes exactly what it validated.
 */
export function validateNavAnchors(value: unknown): NavAnchorsValidation {
  if (value === undefined || value === null) {
    return { isValid: true, anchors: parseNavAnchorDrafts(null) };
  }
  if (!Array.isArray(value)) {
    return { isValid: false, error: 'Navigation anchors must be a list' };
  }

  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const anchor = entry as { id?: unknown; anchor?: unknown } | null;
    const id = anchor?.id;
    if (typeof id !== 'string' || !navItemIds.includes(id as NavItemId)) {
      return {
        isValid: false,
        error: `Navigation anchor ${index + 1} has no valid item`,
      };
    }
    if (seen.has(id)) {
      return {
        isValid: false,
        error: `Navigation anchor for "${id}" is listed twice`,
      };
    }
    seen.add(id);
    // A blank anchor means "use the item id"; only a filled-in value has to be
    // a usable element id.
    const raw = anchor?.anchor;
    if (
      raw != null &&
      String(raw).trim() !== '' &&
      normalizeNavAnchor(raw) === null
    ) {
      return {
        isValid: false,
        error: `Navigation anchor for "${id}" is not a valid element id`,
      };
    }
  }

  return { isValid: true, anchors: parseNavAnchorDrafts(value) };
}

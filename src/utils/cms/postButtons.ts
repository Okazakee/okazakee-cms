/**
 * Ordered buttons on a portfolio post, from the CMS side.
 *
 * The editor arranges an ordered list and nothing else: the label and the icon
 * of a known kind belong to the public site (okazakee-ws), so an editor cannot
 * retitle "Source code". Only `custom` carries a label, and it is required.
 *
 * Rows written before `portfolio_posts.buttons` existed only have the six
 * legacy link columns. `deriveButtonsFromPost` reads those into the same shape
 * so the editor opens on a populated builder rather than an empty one; the
 * public site has the mirror-image fallback for rows that are still unarranged.
 */

import { isValidHttpUrl } from '@/utils/cms/validation';

export const postButtonKinds = [
  'website',
  'source',
  'demo',
  'store',
  'fdroid',
  'ios',
  'custom',
] as const;

export type PostButtonKind = (typeof postButtonKinds)[number];

export type PostButton = {
  kind: PostButtonKind;
  url: string;
  /** Required for `custom`, ignored for every preset. */
  label?: string;
};

/** The six legacy columns, in the order the public site has always shown them. */
const legacyColumns = [
  ['website', 'website'],
  ['source', 'source_link'],
  ['demo', 'demo_link'],
  ['store', 'store_link'],
  ['fdroid', 'fdroid_link'],
  ['ios', 'ios_store_link'],
] as const satisfies ReadonlyArray<
  readonly [Exclude<PostButtonKind, 'custom'>, string]
>;

/**
 * The editor's buttons for a row: its own list when it has one, otherwise the
 * legacy columns. Order is render order and is preserved either way.
 */
export function deriveButtonsFromPost(post: {
  buttons?: unknown;
  [column: string]: unknown;
}): PostButton[] {
  if (Array.isArray(post.buttons) && post.buttons.length > 0) {
    return post.buttons as PostButton[];
  }

  const buttons: PostButton[] = [];
  for (const [kind, column] of legacyColumns) {
    const url = post[column];
    if (typeof url === 'string' && url.trim()) {
      buttons.push({ kind, url: url.trim() });
    }
  }
  return buttons;
}

export type PostButtonsValidation =
  | { isValid: true; buttons: PostButton[] }
  | { isValid: false; error: string };

/**
 * Server-side guard for the value the editor submits. Every URL must be an
 * absolute http(s) URL and a `custom` button must carry a label; a label on a
 * preset is dropped rather than rejected, since the site ignores it anyway.
 * Returns the normalised buttons so the caller writes exactly what it
 * validated.
 */
export function validatePostButtons(value: unknown): PostButtonsValidation {
  if (value === undefined || value === null) {
    return { isValid: true, buttons: [] };
  }
  if (!Array.isArray(value)) {
    return { isValid: false, error: 'Buttons must be a list' };
  }

  const buttons: PostButton[] = [];
  for (const [index, entry] of value.entries()) {
    const button = entry as Partial<PostButton> | null;
    const kind = button?.kind;
    if (!kind || !postButtonKinds.includes(kind)) {
      return {
        isValid: false,
        error: `Button ${index + 1} has no valid type`,
      };
    }
    const url = button?.url?.trim() ?? '';
    if (!url || !isValidHttpUrl(url)) {
      return {
        isValid: false,
        error: `Button ${index + 1} needs an absolute http(s) URL`,
      };
    }
    if (kind === 'custom') {
      const label = button?.label?.trim() ?? '';
      if (!label) {
        return { isValid: false, error: `Button ${index + 1} needs a label` };
      }
      buttons.push({ kind, url, label });
      continue;
    }
    buttons.push({ kind, url });
  }

  return { isValid: true, buttons };
}

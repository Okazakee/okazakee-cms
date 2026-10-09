/**
 * Pure marker toggle for the `****text****` violet-highlight syntax.
 *
 * The public site renders `****...****` runs as violet-tinted labels
 * (hero name/roles, about paragraph, post bodies), so the CMS stores the
 * markers as plain text. This helper computes the wrap/unwrap edit and the
 * caret to restore — the toolbar component applies it to the focused
 * textarea/input. Client-safe and unit-tested.
 */
export type HighlightEdit = {
  text: string;
  caretStart: number;
  caretEnd: number;
};

const MARKER = '****';

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return length;
  if (value < 0) return 0;
  if (value > length) return length;
  return Math.floor(value);
}

/**
 * Wraps the [start, end) range with `****` markers, unwraps it when it is
 * already wrapped, or inserts an empty `********` pair with the caret in
 * the middle when the selection is collapsed.
 */
export function toggleHighlightMarkers(
  value: string,
  start: number,
  end: number
): HighlightEdit {
  const from = clampIndex(Math.min(start, end), value.length);
  const to = clampIndex(Math.max(start, end), value.length);
  const before = value.slice(0, from);
  const selected = value.slice(from, to);
  const after = value.slice(to);

  if (
    selected.length > 0 &&
    before.endsWith(MARKER) &&
    after.startsWith(MARKER)
  ) {
    return {
      text:
        before.slice(0, before.length - MARKER.length) +
        selected +
        after.slice(MARKER.length),
      caretStart: from - MARKER.length,
      caretEnd: to - MARKER.length,
    };
  }

  if (selected.length > 0) {
    return {
      text: `${before}${MARKER}${selected}${MARKER}${after}`,
      caretStart: from + MARKER.length,
      caretEnd: to + MARKER.length,
    };
  }

  return {
    text: `${before}${MARKER}${MARKER}${after}`,
    caretStart: from + MARKER.length,
    caretEnd: from + MARKER.length,
  };
}

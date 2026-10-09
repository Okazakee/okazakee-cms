/**
 * Plain-text `****text****` marker model (client-safe, unit-tested).
 *
 * The public site renders `****...****` runs as violet-tinted labels, so
 * the CMS stores the markers as plain text. The MarkerEditor shows those
 * runs as violet spans (markers hidden) and serializes the DOM back to
 * the exact storage text on every change.
 */
export type MarkerRun = {
  text: string;
  highlighted: boolean;
};

const MARKER = '****';
const MARKER_PATTERN_SOURCE = '\\*\\*\\*\\*([^*]+?)\\*\\*\\*\\*';

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'SECTION',
  'ARTICLE',
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Splits storage text into plain/highlighted runs, in order. */
export function parseMarkerRuns(value: string): MarkerRun[] {
  const runs: MarkerRun[] = [];
  const pattern = new RegExp(MARKER_PATTERN_SOURCE, 'g');
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(value);
  while (match !== null) {
    if (match.index > last) {
      runs.push({ text: value.slice(last, match.index), highlighted: false });
    }
    runs.push({ text: match[1] ?? '', highlighted: true });
    last = match.index + match[0].length;
    match = pattern.exec(value);
  }
  if (last < value.length) {
    runs.push({ text: value.slice(last), highlighted: false });
  }
  return runs;
}

/** Renders storage text as editor HTML: runs become marker spans. */
export function markersToHtml(value: string): string {
  return parseMarkerRuns(value)
    .map((run) =>
      run.highlighted
        ? `<span data-marker="1">${escapeHtml(run.text)}</span>`
        : escapeHtml(run.text)
    )
    .join('');
}

function isBlockElement(node: Node): boolean {
  return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName);
}

/**
 * Serializes editor DOM back to storage text. Text stays raw (typed
 * characters are never interpreted), marker spans regain their `****`,
 * nested marker spans flatten, and block boundaries become newlines.
 * Whitespace-only content normalizes to '' so clearing a field empties it.
 */
export function editorDomToMarkers(
  root: Element,
  inMarker = false
): string {
  let out = '';
  root.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out += (child as Text).data;
      return;
    }
    if (child.nodeName === 'BR') {
      out += '\n';
      return;
    }
    if (child.nodeType !== 1) return;
    const element = child as HTMLElement;
    if (element.hasAttribute('data-marker') && !inMarker) {
      out += `${MARKER}${editorDomToMarkers(element, true)}${MARKER}`;
      return;
    }
    const inner = editorDomToMarkers(element, inMarker);
    if (isBlockElement(element) && out !== '' && !out.endsWith('\n')) {
      out += '\n';
    }
    out += inner;
  });
  if (!inMarker && out.trim() === '') return '';
  return out;
}

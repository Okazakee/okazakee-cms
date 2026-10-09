/**
 * Pure post-body helpers for the CMS markdown editor (client-safe,
 * unit-tested).
 *
 * Bodies are plain markdown with two house conventions (mirroring the
 * public site's MarkdownRenderer):
 * - `****text****` renders white-bold, `*text*` renders violet;
 * - images live on their own line as `![alt-blurhash](url)` where the
 *   FIRST `-` splits alt from blurhash.
 *
 * While editing, not-yet-uploaded images are client-side blobs referenced
 * as `![alt-pending:<id>](blob:…)` (zero server writes until Publish).
 * On publish the server uploads the finished snapshot into the post
 * folder and rewrites pending refs to `![alt-blurhash](publicUrl)`.
 */

export type BodyImageRef = {
  /** Full `![alt](url)` match as written. */
  raw: string;
  alt: string;
  url: string;
  /** True while the image is a client-side blob awaiting upload. */
  pending: boolean;
  /** Pending id (`pending:<id>`), or null for committed images. */
  pendingId: string | null;
  /** Alt segment before the first `-` (the caption the site shows). */
  caption: string;
  /** Segment after the first `-`, '' when the alt has no dash. */
  hash: string;
};

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const PENDING_ALT_PREFIX = 'pending:';

function splitAlt(alt: string): { caption: string; hash: string } {
  const dash = alt.indexOf('-');
  if (dash < 0) return { caption: alt, hash: '' };
  return { caption: alt.slice(0, dash), hash: alt.slice(dash + 1) };
}

/** Lists every `![alt](url)` reference in a body, in order. */
export function parseBodyImages(body: string): BodyImageRef[] {
  IMAGE_PATTERN.lastIndex = 0;
  const refs: BodyImageRef[] = [];
  let match: RegExpExecArray | null = IMAGE_PATTERN.exec(body);
  while (match !== null) {
    const alt = match[1] ?? '';
    const url = match[2] ?? '';
    const { caption, hash } = splitAlt(alt);
    const pendingId =
      url.startsWith('blob:') && hash.startsWith(PENDING_ALT_PREFIX)
        ? hash.slice(PENDING_ALT_PREFIX.length)
        : null;
    refs.push({
      raw: match[0],
      alt,
      url,
      pending: pendingId !== null,
      pendingId,
      caption,
      hash,
    });
    match = IMAGE_PATTERN.exec(body);
  }
  return refs;
}

/**
 * Sanitizes an image alt for the dash-split contract: dashes become
 * spaces (a dash would shift the blurhash segment), surrounding space is
 * trimmed, empty falls back to the file label.
 */
export function sanitizeImageAlt(alt: string, fallbackLabel: string): string {
  const cleaned = alt.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned) return cleaned;
  const fallback = fallbackLabel
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return fallback || 'image';
}

/** Builds the pending markdown for a just-picked image (blob-staged). */
export function pendingImageMarkdown(
  alt: string,
  pendingId: string,
  blobUrl: string
): string {
  return `![${alt}-${PENDING_ALT_PREFIX}${pendingId}](${blobUrl})`;
}

/**
 * Rewrites one pending ref to its committed form after upload. Matches
 * the exact `pending:<id>` marker so similarly-named alts never collide.
 */
export function rewritePendingRef(
  body: string,
  pendingId: string,
  committed: string
): string {
  const needle = `${PENDING_ALT_PREFIX}${pendingId}]`;
  if (!body.includes(needle)) return body;
  const refs = parseBodyImages(body);
  let next = body;
  for (const ref of refs) {
    if (ref.pendingId === pendingId) {
      next = next.replace(ref.raw, committed);
    }
  }
  return next;
}

/** Builds the committed markdown for an uploaded image. */
export function committedImageMarkdown(
  alt: string,
  blurhash: string,
  publicUrl: string
): string {
  return `![${alt}-${blurhash}](${publicUrl})`;
}

/**
 * Structural validation for image lines. Legacy committed lines always
 * pass through (never break an unrelated edit); only unbalanced syntax
 * and unresolvable pending refs block a publish.
 */
export type BodyImageIssue = {
  line: number;
  message: string;
};

export function validateBodyImages(
  body: string,
  resolvablePendingIds: Set<string>
): BodyImageIssue[] {
  const issues: BodyImageIssue[] = [];
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (!line.includes('![')) return;
    const refs = parseBodyImages(line);
    // Balanced `![` without a parseable `](url)` partner.
    const opens = line.split('![').length - 1;
    if (refs.length < opens) {
      issues.push({
        line: index + 1,
        message: 'Unbalanced image syntax: expected ![alt](url)',
      });
      return;
    }
    for (const ref of refs) {
      if (ref.pending && !resolvablePendingIds.has(ref.pendingId ?? '')) {
        issues.push({
          line: index + 1,
          message: 'Image was removed before publish; re-insert it',
        });
      }
    }
  });
  return issues;
}

export type TextEdit = {
  text: string;
  caretStart: number;
  caretEnd: number;
};

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return length;
  return Math.max(0, Math.min(length, Math.floor(value)));
}

/**
 * Wraps the [start, end) range with a symmetric marker pair (`****` or
 * `*`), unwrapping when already wrapped. Collapsed caret inserts an
 * empty pair with the caret inside. Single-`*` never nests inside an
 * existing run: wrapping `b` in `****b****` is refused (returns the
 * input unchanged) instead of producing ambiguous `***` sequences.
 */
export function toggleInlineMarker(
  value: string,
  start: number,
  end: number,
  marker: '****' | '*'
): TextEdit {
  const from = clampIndex(Math.min(start, end), value.length);
  const to = clampIndex(Math.max(start, end), value.length);
  const before = value.slice(0, from);
  const selected = value.slice(from, to);
  const after = value.slice(to);

  if (selected.length === 0) {
    return {
      text: `${before}${marker}${marker}${after}`,
      caretStart: from + marker.length,
      caretEnd: from + marker.length,
    };
  }

  if (
    before.endsWith(marker) &&
    after.startsWith(marker) &&
    !(marker === '*' && (before.endsWith('**') || after.startsWith('**')))
  ) {
    return {
      text:
        before.slice(0, before.length - marker.length) +
        selected +
        after.slice(marker.length),
      caretStart: from - marker.length,
      caretEnd: to - marker.length,
    };
  }

  if (marker === '*') {
    const edgeBefore = before.slice(-2);
    const edgeAfter = after.slice(0, 2);
    if (
      edgeBefore.includes('*') ||
      edgeAfter.includes('*') ||
      /^\*|\*$/.test(selected)
    ) {
      return { text: value, caretStart: from, caretEnd: to };
    }
  }

  return {
    text: `${before}${marker}${selected}${marker}${after}`,
    caretStart: from + marker.length,
    caretEnd: to + marker.length,
  };
}

/** Wraps the [start, end) range in a fenced code block on its own lines. */
export function wrapCodeFence(
  value: string,
  start: number,
  end: number,
  language = ''
): TextEdit {
  const from = clampIndex(Math.min(start, end), value.length);
  const to = clampIndex(Math.max(start, end), value.length);
  const before = value.slice(0, from);
  const selected = value.slice(from, to);
  const after = value.slice(to);
  const fence = `\`\`\`${language}`;
  const needsBeforeGap = before !== '' && !before.endsWith('\n\n');
  const needsAfterGap = after !== '' && !after.startsWith('\n\n');
  const open = `${needsBeforeGap ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${fence}\n`;
  const close = `\n\`\`\`${needsAfterGap ? (after.startsWith('\n') ? '\n' : '\n\n') : ''}`;
  const text = `${before}${open}${selected}${close}${after}`;
  const caretStart = before.length + open.length;
  return {
    text,
    caretStart,
    caretEnd: caretStart + selected.length,
  };
}

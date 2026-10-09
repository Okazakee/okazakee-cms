/**
 * Post tag list helpers (client-safe, unit-tested).
 *
 * Storage stays a plain text column: the canonical form is a JSON array
 * string (`["a","b"]`), which the public site's quoted-segment parser
 * reads identically to the legacy space-separated form (`"a" "b"`).
 * Quotes are forbidden inside a tag under both formats.
 */

/** Extracts tags with the site's own quoted-segment rule. */
export function parsePostTags(value: string): string[] {
  if (!value) return [];
  const tags: string[] = [];
  for (const match of value.matchAll(/"([^"]*?)"/g)) {
    const tag = (match[1] ?? '').trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** Canonical storage form; empty serializes to '' (renders nothing). */
export function serializePostTags(tags: string[]): string {
  const clean = tags.map((tag) => tag.trim()).filter(Boolean);
  const deduped = [...new Set(clean)];
  if (deduped.length === 0) return '';
  return JSON.stringify(deduped);
}

/** True when a raw value already round-trips through the canonical form. */
export function isCanonicalPostTags(value: string): boolean {
  if (!value) return true;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === 'string') &&
      serializePostTags(parsed as string[]) === value
    );
  } catch {
    return false;
  }
}

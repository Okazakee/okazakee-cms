import { Tag } from 'lucide-react';
import { ChipRow } from './ChipRow';

/**
 * Post tags, canon chip row (docs/DESIGN.md §5.2): the row stays on one line
 * and only loops when the chips overflow. Parsing stays here; the marquee
 * behaviour lives in ChipRow so the career chips share it.
 */
export const Tags = ({ tags }: { tags: string }) => {
  const list = tags
    ? Array.from(tags.matchAll(/"([^"]*?)"/g), (match) => match[1])
    : [];

  if (list.length === 0) return null;

  return (
    <ChipRow>
      {list.map((tag) => (
        <span
          className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded border border-border-subtle bg-surface-raised px-2 py-0.5 font-mono text-xs text-text-muted"
          key={tag}
        >
          <Tag className="mr-0.5 h-3 w-3 shrink-0 text-accent-violet/70" />
          {tag}
        </span>
      ))}
    </ChipRow>
  );
};

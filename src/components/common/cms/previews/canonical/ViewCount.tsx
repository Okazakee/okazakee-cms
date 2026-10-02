'use client';

import { Eye } from 'lucide-react';

/**
 * Static view row for previews (canonical ViewDisplay markup, no side
 * effects): the public component increments the counter, the preview only
 * shows the value it was given.
 */
export function ViewCount({ views }: { views: number | string }) {
  return (
    <div className="inline-flex items-center gap-2">
      <Eye size={14} />
      <span className="inline-block shrink-0 tabular-nums">{`${views}`}</span>
    </div>
  );
}

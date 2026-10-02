'use client';

import { StarIcon } from './StarIcon';

/**
 * Offline fork of the public GitHubStars row. The real component fetches
 * `api.github.com`; a preview must not. When no count is supplied only the
 * glyph is rendered so no invented number is shown.
 */
export function GitHubStars({ stars }: { stars?: number }) {
  return (
    <div className="inline-flex items-center gap-2">
      <StarIcon className="text-accent-violet" size={14} />
      {typeof stars === 'number' ? <span>{stars}</span> : null}
    </div>
  );
}

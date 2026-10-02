'use client';

import { useLocale } from 'next-intl';
import type { PortfolioPost } from '@/types/fetchedData.types';
import { PostBand } from './canonical/PostBand';

interface PortfolioPreviewProps {
  posts: PortfolioPost[];
  deletedPostIds?: Set<number>;
}

/** Live portfolio band preview, canonical home markup (docs/DESIGN.md §6). */
export function PortfolioPreview({
  posts,
  deletedPostIds = new Set(),
}: PortfolioPreviewProps) {
  const locale = useLocale();
  const visiblePosts = posts.filter((post) => !deletedPostIds.has(post.id));

  return (
    <PostBand
      locale={locale}
      posts={visiblePosts}
      section="portfolio"
      subtitleKey="subtitle1"
      titleKey="title1"
    />
  );
}

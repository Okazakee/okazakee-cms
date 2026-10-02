'use client';

import { useLocale } from 'next-intl';
import type { BlogPost } from '@/types/fetchedData.types';
import { PostBand } from './canonical/PostBand';

interface BlogPreviewProps {
  posts: BlogPost[];
  deletedPostIds?: Set<number>;
}

/** Live blog band preview, canonical home markup (docs/DESIGN.md §6). */
export function BlogPreview({
  posts,
  deletedPostIds = new Set(),
}: BlogPreviewProps) {
  const locale = useLocale();
  const visiblePosts = posts.filter((post) => !deletedPostIds.has(post.id));

  return (
    <PostBand
      locale={locale}
      posts={visiblePosts}
      section="blog"
      subtitleKey="subtitle2"
      tinted
      titleKey="title2"
    />
  );
}

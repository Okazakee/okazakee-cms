'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';
import { ErrorDiv } from './ErrorDiv';
import Postcard from './PostCard';
import Searchbar from './Searchbar';

export default function PostList({
  initialPosts,
  post_type,
  locale,
}: {
  initialPosts: PortfolioPost[] | BlogPost[];
  post_type: string;
  locale: string;
}) {
  const [posts, SetPosts] = useState(initialPosts);
  const [isRateLimited, SetIsRateLimited] = useState(false);

  const t = useTranslations('posts-section');

  return (
    <>
      <Searchbar
        post_type={post_type}
        SetPosts={SetPosts}
        initialPosts={initialPosts}
        SetIsRateLimited={SetIsRateLimited}
        locale={locale}
      />

      <div className="flex flex-wrap gap-6 justify-center mx-5 transition-all">
        {posts.length > 0 ? (
          posts.map((post) => (
            <Postcard key={post.id} post={post} locale={locale} />
          ))
        ) : isRateLimited ? (
          <ErrorDiv>{t('ratelimit')}</ErrorDiv>
        ) : (
          <ErrorDiv>{t('no-posts')}</ErrorDiv>
        )}
      </div>
    </>
  );
}

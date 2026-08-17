'use client';

import PostCard from '@components/common/PostCard';
import { CircleX } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { PortfolioPost } from '@/types/fetchedData.types';
import { formatLabels } from '@/utils/formatLabels';

interface PortfolioPreviewProps {
  posts: PortfolioPost[];
  deletedPostIds?: Set<number>;
}

export function PortfolioPreview({
  posts,
  deletedPostIds = new Set(),
}: PortfolioPreviewProps) {
  const pathname = usePathname();
  const locale = pathname.split('/')[1] || 'en';
  const t = useTranslations('posts-section');

  // Filter out deleted posts
  const visiblePosts = posts.filter((post) => !deletedPostIds.has(post.id));

  return (
    <section className="md:mt-20 mt-10 flex mx-auto max-w-7xl">
      <div className="xl:mx-16 text-center mb-20 max-w-480 w-full">
        <h1 className="xl:text-5xl text-2xl xs:text-3xl mb-5">{t('title1')}</h1>
        <h3
          className="mb-10 md:mb-10 md:mx-10 mx-5 text-base xs:text-lg md:text-2xl"
          dangerouslySetInnerHTML={{
            __html: formatLabels(t('subtitle1')),
          }}
        />
        {visiblePosts.length > 0 ? (
          <div className="flex flex-wrap gap-6 justify-center mx-5 transition-all">
            {visiblePosts.map((post) => (
              <PostCard key={post.id} post={post} locale={locale} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row justify-center items-center text-lg lg:text-5xl lg:mt-52 py-32 lg:py-0 lg:mb-52">
            <CircleX
              size={65}
              className="stroke-main w-[80px] h-auto mb-12 lg:mb-0"
            />
            <h1 className="lg:ml-5">{t('no-posts')}</h1>
          </div>
        )}
      </div>
    </section>
  );
}

import { Eye } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';
import { Tags } from './Tags';

export default function Postcard({
  post,
  locale,
}: {
  post: PortfolioPost | BlogPost;
  locale: string;
}) {
  const isPortfolioPost = (
    post: PortfolioPost | BlogPost
  ): post is PortfolioPost => {
    return 'source_link' in post;
  };
  const checkPostType = isPortfolioPost(post) ? 'portfolio' : 'blog';

  const description = post[`description_${locale}` as keyof typeof post];

  const initTitle =
    checkPostType === 'portfolio'
      ? post.title_en
      : post[`title_${locale}` as keyof typeof post];

  const slugifiedTitle = String(initTitle)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');

  const href = `/${locale}/${checkPostType}/${post.id}/${slugifiedTitle}`;

  return (
    <Link
      href={href}
      className="hover:bg-tertiary bg-[#c5c5c5] dark:bg-[#0e0e0e] drop-shadow-2xl dark:drop-shadow-none hover:text-lighttext border-2 p-3 border-secondary rounded-xl overflow-hidden cursor-pointer transition-all text-left flex flex-col md:w-lg w-full max-w-84 xs:min-w-[24rem] md:max-w-xl hover:scale-105"
    >
      <div className="w-full h-44 md:h-60 relative mx-auto mb-3">
        <Image
          placeholder="blur"
          blurDataURL={post.blurhashURL}
          src={post.image}
          fill
          loading="lazy"
          sizes="(min-width: 768px) 576px, 336px"
          style={{
            objectFit: 'cover',
            objectPosition: 'center',
          }}
          alt="post_image"
          className="rounded-lg"
        />
      </div>
      <div className="flex flex-col justify-between flex-1">
        <div>
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-bold text-[1.4rem] md:text-2xl shrink min-w-0">
              {initTitle}
            </h1>
            <span className="inline-flex items-center gap-1.5 text-xs text-lighttext2 dark:text-lighttext2 whitespace-nowrap">
              <Eye size={14} />
              {post.views ?? 0}
            </span>
          </div>
          <div className="h-12 mb-2 flex items-center">
            <h2 className="sm:line-clamp-2 line-clamp-3 sm:text-[1.03rem] text-sm leading-4 sm:leading-normal tracking-wide sm:tracking-tight">
              {description}
            </h2>
          </div>
        </div>
        <Tags tags={post.post_tags} />
      </div>
    </Link>
  );
}

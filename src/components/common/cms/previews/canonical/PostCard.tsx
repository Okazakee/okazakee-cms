import { Eye } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';
import { getPostHref } from './postHref';
import { Tags } from './Tags';

/**
 * Canonical post / project card (docs/DESIGN.md §5.1): media on the left from
 * `md` up, the whole card is a link, the view count floats on the media and
 * the tag row is the shared single-row component. No hover zoom. The link
 * opens in a new tab so a preview never navigates the CMS app away.
 */
export function PostCard({
  post,
  locale,
}: {
  post: PortfolioPost | BlogPost;
  locale: string;
}) {
  const isPortfolioPost = (
    value: PortfolioPost | BlogPost
  ): value is PortfolioPost => 'source_link' in value;

  const postType = isPortfolioPost(post) ? 'portfolio' : 'blog';
  const title = String(
    postType === 'portfolio'
      ? post.title_en
      : post[`title_${locale}` as keyof typeof post]
  );
  const description = String(
    post[`description_${locale}` as keyof typeof post] ?? ''
  );
  const href = getPostHref({ locale, postType, id: post.id, title });

  return (
    <Link
      className="group flex flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-card transition-all hover:border-accent-violet/50 hover:shadow-xl md:flex-row"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <div
        className={`relative aspect-video w-full shrink-0 overflow-hidden bg-surface-raised ${
          postType === 'portfolio' ? 'md:w-80' : 'md:aspect-auto md:w-72'
        }`}
      >
        <Image
          alt={title}
          blurDataURL={post.blurhashURL || undefined}
          className="object-cover"
          fill
          placeholder={post.blurhashURL ? 'blur' : 'empty'}
          sizes="(min-width: 768px) 320px, 100vw"
          src={post.image}
        />
        <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded bg-surface-base/80 px-2 py-0.5 font-mono text-[11px] text-text-muted backdrop-blur-md">
          <Eye className="h-3.5 w-3.5" />
          {post.views}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between p-6">
        <div className="mb-4">
          <h3 className="mb-2 font-heading text-lg font-semibold text-text-white transition-colors group-hover:text-accent-violet-light">
            {title}
          </h3>
          <p className="text-sm font-light leading-relaxed text-text-muted">
            {description}
          </p>
        </div>
        <Tags tags={post.post_tags} />
      </div>
    </Link>
  );
}

'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';
import { formatLabels } from '@/utils/formatLabels';
import { InnerHtml } from './InnerHtml';
import { PostCard } from './PostCard';

interface PostBandProps {
  posts: (PortfolioPost | BlogPost)[];
  locale: string;
  section: 'portfolio' | 'blog';
  titleKey: string;
  subtitleKey: string;
  tinted?: boolean;
}

/**
 * Canonical home band for projects and posts (docs/DESIGN.md §6): the blog
 * band is tinted and closes with the link to its list page. Renders nothing
 * when there is no visible post, matching the public home.
 */
export function PostBand({
  posts,
  locale,
  section,
  titleKey,
  subtitleKey,
  tinted = false,
}: PostBandProps) {
  const t = useTranslations('posts-section');

  if (posts.length === 0) return null;

  return (
    <section
      className={`border-border-subtle/50 py-24 ${
        tinted ? 'border-t bg-surface-alt' : ''
      }`}
      id={section}
    >
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-14 text-center">
          <InnerHtml
            as="h2"
            className="font-heading text-2xl font-semibold text-text-white sm:text-3xl"
            html={formatLabels(t.has(titleKey) ? t(titleKey) : '')}
          />
          <InnerHtml
            as="p"
            className="mt-2 font-mono text-xs text-accent-violet-light sm:text-sm"
            html={formatLabels(t.has(subtitleKey) ? t(subtitleKey) : '')}
          />
          <div className="mx-auto mt-3 h-0.5 w-10 rounded-full bg-accent-violet" />
        </div>

        <div className="space-y-6">
          {posts.map((post) => (
            <PostCard key={post.id} locale={locale} post={post} />
          ))}
        </div>

        <div className="mt-12 flex justify-center">
          <Link
            className="inline-flex items-center gap-2 rounded-xl bg-accent-violet-deep/80 px-6 py-2.5 font-mono text-xs text-white shadow-md shadow-accent-violet-deep/20 transition-all hover:-translate-y-0.5 hover:bg-accent-violet-deep"
            href={`/${locale}/${section}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t.has('button') ? t('button') : ''}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}

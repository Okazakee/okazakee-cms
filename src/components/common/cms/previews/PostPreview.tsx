'use client';

import {
  CirclePlay,
  Clock,
  ExternalLink,
  Globe,
  Smartphone,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import type { Author } from '@/app/actions/cms/sections/blogActions';
import { formatDMY } from '@/utils/formatDate';
import { AppleIcon, GithubIcon } from './canonical/BrandIcons';
import { ClientMarkdown } from './canonical/ClientMarkdown';
import { GitHubStars } from './canonical/GitHubStars';
import { slugifyTitle } from './canonical/postHref';
import { ShareButton } from './canonical/ShareButton';
import { Tags } from './canonical/Tags';
import { ViewCount } from './canonical/ViewCount';

type BlogFormData = {
  title_en: string;
  title_it: string;
  image: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  created_at: string;
  author_id: string;
};

type PortfolioFormData = {
  title_en: string;
  title_it: string;
  image: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  created_at: string;
  author_id: string;
  source_link: string;
  demo_link: string;
  store_link: string;
  fdroid_link?: string | null;
  website?: string | null;
  ios_store_link?: string | null;
};

type PostPreviewProps = {
  formData: BlogFormData | PortfolioFormData;
  postType: 'blog' | 'portfolio';
  locale: string;
  imageFile?: File | null;
  author: Author | null;
  views?: number;
};

/**
 * Canonical post detail preview (docs/DESIGN.md §6): title, description and
 * tags, poster, then the meta row (quick links for projects, author for posts,
 * date, stars, views, share). No view increment and no GitHub request — the
 * draft is rendered entirely from the current props. Quick links open in a new
 * tab so a preview never navigates the CMS app away.
 */
export function PostPreview({
  formData,
  postType,
  locale,
  imageFile,
  author,
  views = 0,
}: PostPreviewProps) {
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const t = useTranslations('posts-section');
  const tr = (key: string) => (t.has(key) ? t(key) : '');

  useEffect(() => {
    if (imageFile) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(imageFile);
    } else if (formData.image) {
      setImagePreview(formData.image);
    }
  }, [imageFile, formData.image]);

  const initTitle =
    postType === 'portfolio'
      ? formData.title_en
      : formData[`title_${locale}` as keyof typeof formData];

  const localeKey = `body_${locale}` as keyof typeof formData;
  const postDescription = `description_${locale}` as keyof typeof formData;
  const bodyContent = String(formData[localeKey] || '');
  const description = String(formData[postDescription] || '');
  const portfolioData =
    postType === 'portfolio' ? (formData as PortfolioFormData) : null;

  const previewUrl = `/${locale}/${postType}/preview/${slugifyTitle(
    String(initTitle)
  )}`;
  const unoptimized =
    !!imagePreview &&
    (imagePreview.startsWith('data:') || imagePreview.startsWith('blob:'));

  const linkClass =
    'inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-text-muted transition-colors hover:border-accent-violet/50 hover:text-text-white';
  const mobileLinkClass =
    'flex flex-1 items-center justify-center gap-2 rounded-lg border border-accent-violet/40 bg-accent-violet/10 px-3 py-3 font-mono text-xs text-accent-violet-light transition-colors hover:border-accent-violet hover:bg-accent-violet/20';

  const metaLinks: {
    key: string;
    href: string;
    label: string | null;
    icon: ReactNode;
    event: string;
  }[] = [];

  if (portfolioData?.website) {
    metaLinks.push({
      key: 'website',
      href: portfolioData.website,
      label: null,
      icon: <Globe size={14} />,
      event: 'Website button',
    });
  }

  if (portfolioData?.source_link) {
    metaLinks.push({
      key: 'source',
      href: portfolioData.source_link,
      label: tr('source'),
      icon: <GithubIcon size={14} />,
      event: 'View Source Code button',
    });
  }

  if (portfolioData?.demo_link) {
    metaLinks.push({
      key: 'demo',
      href: portfolioData.demo_link,
      label: tr('demo'),
      icon: <ExternalLink size={14} />,
      event: 'View Demo button',
    });
  }

  if (portfolioData?.store_link) {
    metaLinks.push({
      key: 'store',
      href: portfolioData.store_link,
      label: tr('store'),
      icon: <CirclePlay size={14} />,
      event: 'Play Store button',
    });
  }

  if (portfolioData?.fdroid_link) {
    metaLinks.push({
      key: 'fdroid',
      href: portfolioData.fdroid_link,
      label: tr('fdroid'),
      icon: <Smartphone size={14} />,
      event: 'F-Droid button',
    });
  }

  if (portfolioData?.ios_store_link) {
    metaLinks.push({
      key: 'ios',
      href: portfolioData.ios_store_link,
      label: tr('ios'),
      icon: <AppleIcon size={14} />,
      event: 'iOS Store button',
    });
  }

  const authorBlock = author ? (
    <>
      <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full bg-surface-raised">
        {author.avatar_url ? (
          <Image
            alt={author.display_name}
            className="object-cover"
            fill
            sizes="32px"
            src={author.avatar_url}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-mono text-xs text-text-muted">
            {author.display_name.charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span className="text-sm text-text-main">{author.display_name}</span>
    </>
  ) : null;

  return (
    <article className="mx-auto max-w-5xl px-6 pt-12 pb-24 md:pt-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-text-white md:text-4xl">
          {String(initTitle)}
        </h1>
        <p className="mt-5 text-base leading-relaxed text-text-muted">
          {description}
        </p>
        <div className="mt-7">
          <Tags tags={formData.post_tags} />
        </div>
      </div>

      {imagePreview && (
        <div className="relative mt-10 h-56 w-full overflow-hidden rounded-2xl border border-accent-violet bg-surface-raised md:h-96">
          <Image
            alt="post_image"
            blurDataURL={formData.blurhashURL || undefined}
            className="object-cover"
            decoding="sync"
            fetchPriority="high"
            fill
            loading="eager"
            placeholder={formData.blurhashURL ? 'blur' : 'empty'}
            priority
            sizes="(min-width: 1024px) 1024px, 100vw"
            src={imagePreview}
            unoptimized={unoptimized}
          />
        </div>
      )}

      <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center gap-4 font-mono text-xs">
        {metaLinks.length > 0 && (
          <div className="hidden items-center gap-3 md:flex">
            {metaLinks.map((link) => (
              <Link
                className={linkClass}
                data-umami-event={link.event}
                data-umami-event-post={String(initTitle)}
                href={link.href}
                key={link.key}
                rel="noopener noreferrer"
                target="_blank"
              >
                {link.icon}
                {link.label}
              </Link>
            ))}
          </div>
        )}

        {postType !== 'portfolio' && authorBlock && (
          <div className="hidden items-center gap-3 md:flex">{authorBlock}</div>
        )}

        <span className="inline-flex items-center gap-2">
          <Clock size={14} />
          <span>{formatDMY(formData.created_at)}</span>
        </span>

        {portfolioData?.source_link && <GitHubStars />}

        <ViewCount views={views} />

        <ShareButton
          buttonTitle={locale === 'en' ? 'Copy post url' : 'Copia url del post'}
          className="ml-auto"
          title={formData.title_en}
          url={previewUrl}
        />
      </div>

      {postType !== 'portfolio' && authorBlock && (
        <div className="mx-auto mt-5 flex max-w-3xl items-center gap-3 md:hidden">
          {authorBlock}
        </div>
      )}

      {metaLinks.length > 0 && (
        <div className="mx-auto mt-6 flex max-w-3xl flex-col gap-2 md:hidden">
          {metaLinks.map((link, index) =>
            index % 2 === 0 ? (
              <div className="flex gap-2" key={link.key}>
                {[metaLinks[index], metaLinks[index + 1]]
                  .filter(Boolean)
                  .map((item) => (
                    <Link
                      className={mobileLinkClass}
                      data-umami-event={item.event}
                      data-umami-event-post={String(initTitle)}
                      href={item.href}
                      key={item.key}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  ))}
              </div>
            ) : null
          )}
        </div>
      )}

      <div className="post mx-auto mt-12 max-w-3xl text-left">
        <ClientMarkdown>{bodyContent}</ClientMarkdown>
      </div>
    </article>
  );
}

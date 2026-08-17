'use client';

import { CirclePlay, Clock, ExternalLink, Globe, Smartphone } from 'lucide-react';
import { AppleIcon, GithubIcon } from '@/components/common/BrandIcons';
import { formatDMY } from '@/utils/formatDate';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import React from 'react';
import type { Author } from '@/app/actions/cms/sections/blogActions';
import ShareButton from '@/components/common/ShareButton';
import Tags from '@/components/common/Tags';
import ViewDisplay from '@/components/common/ViewDisplay';
import MarkdownRenderer from '@/components/layout/MarkdownRenderer';

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

export function PostPreview({
  formData,
  postType,
  locale,
  imageFile,
  author,
  views = 0,
}: PostPreviewProps) {
  const [imagePreview, setImagePreview] = React.useState<string | null>(null);
  const t = useTranslations('posts-section');

  React.useEffect(() => {
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

  const formattedDate = formatDMY(formData.created_at);

  const portfolioData =
    postType === 'portfolio' ? (formData as PortfolioFormData) : null;

  // Generate a preview URL (won't be real, just for display)
  const slugifiedTitle = String(initTitle)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
  const postURL = `/${locale}/${postType}/preview/${slugifiedTitle}`;

  return (
    <article className="max-w-5xl mx-auto px-4 mb-20 md:mb-32 md:mt-16 mt-10">
      <header className="flex relative mb-6 md:mb-0">
        <div>
          <h1 className="md:text-4xl text-2xl xs:text-3xl font-bold mb-4">
            {initTitle}
          </h1>
          <p className="text-base xs:text-lg">{description}</p>
        </div>
      </header>

      {/* TAGS */}
      {formData.post_tags && (
        <div className="md:my-4">
          <Tags tags={formData.post_tags} />
        </div>
      )}

      {/* Main Image */}
      {imagePreview && (
        <div className="w-full h-56 md:h-96 relative mx-auto mt-6 md:mt-0">
          <Image
            {...(formData.blurhashURL
              ? {
                  placeholder: 'blur' as const,
                  blurDataURL: formData.blurhashURL,
                }
              : {})}
            src={imagePreview}
            fill
            priority
            fetchPriority="high"
            loading="eager"
            decoding="sync"
            sizes="100vw"
            style={{
              objectFit: 'cover',
              objectPosition: 'center',
            }}
            alt="post_image"
            className="rounded-lg border-[3px] border-main"
          />
        </div>
      )}

      {/* Quick Info */}
      <div className="flex gap-5 md:justify-normal md:gap-6 sm:gap-4 my-6 md:my-8 text-lighttext items-center">
        <div
          className={`hidden gap-6 ${postType === 'portfolio' && 'md:flex'}`}
        >
          {postType === 'portfolio' &&
            portfolioData &&
            portfolioData.website &&
            portfolioData.website !== null && (
              <a
                target="_blank"
                href={portfolioData.website}
                rel="noopener noreferrer"
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <Globe size={18} />
              </a>
            )}
          {postType === 'portfolio' &&
            portfolioData &&
            portfolioData.source_link &&
            portfolioData.source_link !== null && (
              <a
                target="_blank"
                href={portfolioData.source_link}
                rel="noopener noreferrer"
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <GithubIcon size={18} />
                <div className="mt-0.5 md:mt-0">{t('source')}</div>
              </a>
            )}

          {postType === 'portfolio' &&
            portfolioData &&
            portfolioData.demo_link &&
            portfolioData.demo_link !== null && (
              <a
                target="_blank"
                href={portfolioData.demo_link}
                rel="noopener noreferrer"
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <ExternalLink size={18} />
                <div className="mt-0.5 md:mt-0">{t('demo')}</div>
              </a>
            )}
          {postType === 'portfolio' &&
            portfolioData &&
            portfolioData.store_link &&
            portfolioData.store_link !== null && (
              <a
                target="_blank"
                href={portfolioData.store_link}
                rel="noopener noreferrer"
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <CirclePlay size={18} />
                <div className="mt-0.5 md:mt-0">{t('store')}</div>
              </a>
            )}
          {postType === 'portfolio' &&
            portfolioData &&
            portfolioData.fdroid_link &&
            portfolioData.fdroid_link !== null && (
              <a
                target="_blank"
                href={portfolioData.fdroid_link}
                rel="noopener noreferrer"
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <Smartphone size={18} />
                <div className="mt-0.5 md:mt-0">{t('fdroid')}</div>
              </a>
            )}
          {postType === 'portfolio' &&
            portfolioData &&
            portfolioData.ios_store_link &&
            portfolioData.ios_store_link !== null && (
              <a
                target="_blank"
                href={portfolioData.ios_store_link}
                rel="noopener noreferrer"
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <AppleIcon size={18} />
                <div className="mt-0.5 md:mt-0">{t('ios')}</div>
              </a>
            )}
        </div>

        {/* Author - desktop only */}
        {postType !== 'portfolio' && author && (
          <div className="hidden md:flex items-center gap-3 text-darktext dark:text-lighttext">
            <div className="relative w-8 h-8 rounded-full overflow-hidden bg-gray-300 dark:bg-gray-700">
              {author.avatar_url ? (
                <Image
                  src={author.avatar_url}
                  alt={author.display_name}
                  fill
                  className="object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300">
                  {author.display_name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <span className="mt-0.5 text-base">{author.display_name}</span>
          </div>
        )}

        <div className="flex items-center text-darktext dark:text-lighttext">
          <Clock size={20} className="mr-2" />
          <span className="mt-0.5">{formattedDate}</span>
        </div>

        <ViewDisplay
          postId="preview"
          postType={postType}
          initialViews={views}
        />

        <ShareButton
          className="ml-auto"
          buttonTitle={locale === 'en' ? 'Copy post url' : 'Copia url del post'}
          url={postURL}
          title={formData.title_en}
        />
      </div>

      {/* Author - mobile only */}
      {postType !== 'portfolio' && author && (
        <div className="flex md:hidden items-center gap-3 text-darktext dark:text-lighttext mb-6">
          <div className="relative w-8 h-8 rounded-full overflow-hidden bg-gray-300 dark:bg-gray-700">
            {author.avatar_url ? (
              <Image
                src={author.avatar_url}
                alt={author.display_name}
                fill
                className="object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300">
                {author.display_name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <span className="mt-0.5 text-base">{author.display_name}</span>
        </div>
      )}

      {/* mobile btns */}
      <div
        className={`${
          postType === 'portfolio' ? 'flex flex-col gap-2 mb-8 md:hidden' : 'hidden'
        }`}
      >
        {/* Row 1: source + website side by side */}
        {postType === 'portfolio' && portfolioData && (
          <div className="flex gap-2">
            {portfolioData.source_link && portfolioData.source_link !== null && (
              <a
                target="_blank"
                href={portfolioData.source_link}
                rel="noopener noreferrer"
                className="flex flex-1 text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <GithubIcon size={18} />
                <div className="mt-0.5 md:mt-0">{t('source')}</div>
              </a>
            )}
            {portfolioData.website && portfolioData.website !== null && (
              <a
                target="_blank"
                href={portfolioData.website}
                rel="noopener noreferrer"
                className="flex flex-1 text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              >
                <Globe size={18} />
              </a>
            )}
          </div>
        )}

        {/* Demo (full width) */}
        {postType === 'portfolio' &&
          portfolioData &&
          portfolioData.demo_link &&
          portfolioData.demo_link !== null && (
            <a
              target="_blank"
              href={portfolioData.demo_link}
              rel="noopener noreferrer"
              className="flex w-full text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
            >
              <ExternalLink size={18} />
              <div className="mt-0.5 md:mt-0">{t('demo')}</div>
            </a>
          )}

        {/* Stores: adaptive layout */}
        {postType === 'portfolio' && portfolioData && (() => {
          const stores: Array<{ key: string; label: string; icon: React.ReactNode; href: string }> = [];
          if (portfolioData.store_link && portfolioData.store_link !== null) stores.push({ key: 'store', label: t('store'), icon: <CirclePlay size={18} />, href: portfolioData.store_link });
          if (portfolioData.fdroid_link && portfolioData.fdroid_link !== null) stores.push({ key: 'fdroid', label: t('fdroid'), icon: <Smartphone size={18} />, href: portfolioData.fdroid_link });
          if (portfolioData.ios_store_link && portfolioData.ios_store_link !== null) stores.push({ key: 'ios', label: t('ios'), icon: <AppleIcon size={18} />, href: portfolioData.ios_store_link });
          if (stores.length === 0) return null;
          if (stores.length === 3) {
            const topRow = stores.filter((s) => s.key !== 'fdroid');
            const bottomRow = stores.filter((s) => s.key === 'fdroid');
            return (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {topRow.map((s) => (
                    <a key={s.key} target="_blank" href={s.href} rel="noopener noreferrer" className="flex text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary">
                      {s.icon}<div className="mt-0.5 md:mt-0">{s.label}</div>
                    </a>
                  ))}
                </div>
                {bottomRow.map((s) => (
                  <a key={s.key} target="_blank" href={s.href} rel="noopener noreferrer" className="flex w-full text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary">
                    {s.icon}<div className="mt-0.5 md:mt-0">{s.label}</div>
                  </a>
                ))}
              </>
            );
          }
          const gridCols = stores.length === 1 ? '' : 'grid-cols-2';
          return (
            <div className={`grid ${gridCols} gap-2`}>
              {stores.map((s) => (
                <a key={s.key} target="_blank" href={s.href} rel="noopener noreferrer" className="flex text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary">
                  {s.icon}<div className="mt-0.5 md:mt-0">{s.label}</div>
                </a>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Project Description */}
      {bodyContent && (
        <div
          id="post"
          className="space-y-4 max-w-none text-base xs:text-lg prose dark:prose-invert text-left"
        >
          <MarkdownRenderer markdown={bodyContent} />
        </div>
      )}
    </article>
  );
}

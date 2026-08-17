import { getPost, getPosts, type PostWithAuthor } from '@utils/getData';
import {
  CirclePlay,
  Clock,
  ExternalLink,
  Globe,
  Smartphone,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AppleIcon, GithubIcon } from '@/components/common/BrandIcons';
import GitHubStars from '@/components/common/GitHubStars';
import FormattedDate from '@/components/common/FormattedDate';
import ShareButton from '@/components/common/ShareButton';
import Tags from '@/components/common/Tags';
import ViewDisplay from '@/components/common/ViewDisplay';
import MarkdownRenderer from '@/components/layout/MarkdownRenderer';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';

/* ONLY PORTFOLIO POSTS USE title_en AS TITLE FOR BOTH LANGS, BLOG POSTS CAN SWAP title_en and title_it */
const validPostTypes = new Set(['portfolio', 'blog']);
const numericIdPattern = /^\d+$/;

export default async function Page({
  params,
}: {
  params: Promise<{
    post_type: string;
    id: string;
    title: string;
    locale: string;
  }>;
}) {
  const { id, title, post_type, locale } = await params;

  if (!validPostTypes.has(post_type) || !numericIdPattern.test(id)) {
    notFound();
  }

  const post: PostWithAuthor | null = await getPost(id, post_type);

  const t = await getTranslations({ locale, namespace: 'posts-section' });

  // checks
  if (!post) {
    notFound();
  }

  type LocaleKey = 'title_en' | 'title_it';

  const initTitle =
    post_type === 'portfolio'
      ? post.title_en
      : post[`title_${locale}` as LocaleKey];

  // If the provided title doesn't match the actual post title, redirect to the correct URL
  const slugifiedTitle = initTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');

  if (title !== slugifiedTitle) {
    redirect(`/${locale}/${post_type}/${id}/${slugifiedTitle}`);
  }

  const localeKey = `body_${locale}` as keyof typeof post;

  const postDescription = `description_${locale}` as keyof typeof post;

  const postURL = `${process.env.DOMAIN_URL}/${locale}/${post_type}/${id}/${slugifiedTitle}`;

  return (
    <article className="max-w-5xl mx-auto px-4 mb-20 md:mb-32 md:mt-16 mt-10">
      <header className="flex relative mb-6 md:mb-0">
        <div>
          <h1 className="md:text-4xl text-2xl xs:text-3xl font-bold mb-4">
            {initTitle}
          </h1>
          <p className="text-base xs:text-lg">
            {String(post[postDescription])}
          </p>
        </div>
      </header>

      {/* TAGS */}
      <div className="md:my-4">
        <Tags tags={post.post_tags} />
      </div>

      {/* Main Image */}
      <div className="w-full h-56 md:h-96 relative mx-auto mt-6 md:mt-0">
        <Image
          placeholder="blur"
          blurDataURL={post.blurhashURL}
          src={post.image}
          fill
          priority
          fetchPriority="high"
          loading="eager"
          decoding="sync"
          sizes="(min-width: 1024px) 1024px, 100vw"
          style={{
            objectFit: 'cover',
            objectPosition: 'center',
          }}
          alt="post_image"
          className="rounded-lg border-[3px] border-main"
        />
      </div>

      {/* Quick Info */}
      <div className="flex gap-5 md:justify-normal md:gap-6 sm:gap-4 my-6 md:my-8 text-lighttext items-center">
        <div
          className={`hidden gap-6 ${post_type === 'portfolio' && 'md:flex'}`}
        >
          {post_type === 'portfolio' &&
            post &&
            'website' in post &&
            post.website &&
            post.website !== null && (
              <Link
                target="_blank"
                href={post.website}
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="Website button"
                data-umami-event-post={title}
              >
                <Globe size={18} />
              </Link>
            )}
          {post_type === 'portfolio' &&
            post &&
            'source_link' in post &&
            post.source_link &&
            post.source_link !== null && (
              <Link
                target="_blank"
                href={post.source_link}
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="View Source Code button"
                data-umami-event-post={title}
              >
                <GithubIcon size={18} />
                <div className="mt-0.5 md:mt-0">{t('source')}</div>
              </Link>
            )}

          {post_type === 'portfolio' &&
            post &&
            'demo_link' in post &&
            post.demo_link &&
            post.demo_link !== null && (
              <Link
                target="_blank"
                href={post.demo_link}
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="View Demo button"
                data-umami-event-post={title}
              >
                <ExternalLink size={18} />
                <div className="mt-0.5 md:mt-0">{t('demo')}</div>
              </Link>
            )}
          {post_type === 'portfolio' &&
            post &&
            'store_link' in post &&
            post.store_link &&
            post.store_link !== null && (
              <Link
                target="_blank"
                href={post.store_link}
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="Play Store button"
                data-umami-event-post={title}
              >
                <CirclePlay size={18} />
                <div className="mt-0.5 md:mt-0">{t('store')}</div>
              </Link>
            )}
          {post_type === 'portfolio' &&
            post &&
            'fdroid_link' in post &&
            post.fdroid_link &&
            post.fdroid_link !== null && (
              <Link
                target="_blank"
                href={post.fdroid_link}
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="F-Droid button"
                data-umami-event-post={title}
              >
                <Smartphone size={18} />
                <div className="mt-0.5 md:mt-0">{t('fdroid')}</div>
              </Link>
            )}
          {post_type === 'portfolio' &&
            post &&
            'ios_store_link' in post &&
            post.ios_store_link &&
            post.ios_store_link !== null && (
              <Link
                target="_blank"
                href={post.ios_store_link}
                className="flex items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="iOS Store button"
                data-umami-event-post={title}
              >
                <AppleIcon size={18} />
                <div className="mt-0.5 md:mt-0">{t('ios')}</div>
              </Link>
            )}
        </div>

        {/* Author - desktop only */}
        {post_type !== 'portfolio' && post.author && (
          <div className="hidden md:flex items-center gap-3 text-darktext dark:text-lighttext">
            <div className="relative w-8 h-8 rounded-full overflow-hidden bg-gray-300 dark:bg-gray-700">
              {post.author.avatar_url ? (
                <Image
                  src={post.author.avatar_url}
                  alt={post.author.display_name}
                  fill
                  className="object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300">
                  {post.author.display_name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <span className="mt-0.5 text-base">{post.author.display_name}</span>
          </div>
        )}

        <div className="flex items-center text-darktext dark:text-lighttext">
          <Clock size={20} className="mr-2" />
          <span className="mt-0.5">
            <FormattedDate date={post?.created_at} />
          </span>
        </div>

        {post_type === 'portfolio' &&
          post &&
          'source_link' in post &&
          post.source_link && (
            <GitHubStars sourceLink={post.source_link} />
          )}

        <ViewDisplay
          postId={id}
          postType={post_type as 'blog' | 'portfolio'}
          initialViews={post.views ?? 0}
        />

        <ShareButton
          className="ml-auto"
          buttonTitle={locale === 'en' ? 'Copy post url' : 'Copia url del post'}
          url={postURL}
          title={post.title_en}
        />
      </div>

      {/* Author - mobile only */}
      {post_type !== 'portfolio' && post.author && (
        <div className="flex md:hidden items-center gap-3 text-darktext dark:text-lighttext mb-6">
          <div className="relative w-8 h-8 rounded-full overflow-hidden bg-gray-300 dark:bg-gray-700">
            {post.author.avatar_url ? (
              <Image
                src={post.author.avatar_url}
                alt={post.author.display_name}
                fill
                className="object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300">
                {post.author.display_name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <span className="mt-0.5 text-base">{post.author.display_name}</span>
        </div>
      )}

      {/* mobile btns */}
      <div
        className={`${
          post_type === 'portfolio'
            ? 'flex flex-col gap-2 mb-8 md:hidden'
            : 'hidden'
        }`}
      >
        {/* Row 1: source + website side by side */}
        {post_type === 'portfolio' && post && (
          <div className="flex gap-2">
            {'source_link' in post &&
              post.source_link &&
              post.source_link !== null && (
                <Link
                  target="_blank"
                  href={post.source_link || ''}
                  className="flex flex-1 text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                  data-umami-event="View Source Code button"
                  data-umami-event-post={title}
                >
                  <GithubIcon size={18} />
                  <div className="mt-0.5 md:mt-0">{t('source')}</div>
                </Link>
              )}
            {'website' in post && post.website && post.website !== null && (
              <Link
                target="_blank"
                href={post.website}
                className="flex flex-1 text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                data-umami-event="Website button"
                data-umami-event-post={title}
              >
                <Globe size={18} />
              </Link>
            )}
          </div>
        )}

        {/* Demo (full width) */}
        {post_type === 'portfolio' &&
          post &&
          'demo_link' in post &&
          post.demo_link &&
          post.demo_link !== null && (
            <Link
              target="_blank"
              href={post.demo_link}
              className="flex w-full text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
              data-umami-event="View Demo button"
              data-umami-event-post={title}
            >
              <ExternalLink size={18} />
              <div className="mt-0.5 md:mt-0">{t('demo')}</div>
            </Link>
          )}

        {/* Stores: adaptive layout */}
        {post_type === 'portfolio' &&
          post &&
          (() => {
            const stores: Array<{
              key: string;
              label: string;
              icon: React.ReactNode;
              href: string;
              event: string;
            }> = [];
            if (
              'store_link' in post &&
              post.store_link &&
              post.store_link !== null
            )
              stores.push({
                key: 'store',
                label: t('store'),
                icon: <CirclePlay size={18} />,
                href: post.store_link,
                event: 'Play Store button',
              });
            if (
              'fdroid_link' in post &&
              post.fdroid_link &&
              post.fdroid_link !== null
            )
              stores.push({
                key: 'fdroid',
                label: t('fdroid'),
                icon: <Smartphone size={18} />,
                href: post.fdroid_link,
                event: 'F-Droid button',
              });
            if (
              'ios_store_link' in post &&
              post.ios_store_link &&
              post.ios_store_link !== null
            )
              stores.push({
                key: 'ios',
                label: t('ios'),
                icon: <AppleIcon size={18} />,
                href: post.ios_store_link,
                event: 'iOS Store button',
              });
            if (stores.length === 0) return null;
            if (stores.length === 3) {
              const topRow = stores.filter((s) => s.key !== 'fdroid');
              const bottomRow = stores.filter((s) => s.key === 'fdroid');
              return (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {topRow.map((s) => (
                      <Link
                        key={s.key}
                        target="_blank"
                        href={s.href}
                        className="flex text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                        data-umami-event={s.event}
                        data-umami-event-post={title}
                      >
                        {s.icon}
                        <div className="mt-0.5 md:mt-0">{s.label}</div>
                      </Link>
                    ))}
                  </div>
                  {bottomRow.map((s) => (
                    <Link
                      key={s.key}
                      target="_blank"
                      href={s.href}
                      className="flex w-full text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                      data-umami-event={s.event}
                      data-umami-event-post={title}
                    >
                      {s.icon}
                      <div className="mt-0.5 md:mt-0">{s.label}</div>
                    </Link>
                  ))}
                </>
              );
            }
            const gridCols = stores.length === 1 ? '' : 'grid-cols-2';
            return (
              <div className={`grid ${gridCols} gap-2`}>
                {stores.map((s) => (
                  <Link
                    key={s.key}
                    target="_blank"
                    href={s.href}
                    className="flex text-sm xs:text-base justify-center items-center gap-2 md:px-4 px-2 py-2 rounded-lg bg-secondary"
                    data-umami-event={s.event}
                    data-umami-event-post={title}
                  >
                    {s.icon}
                    <div className="mt-0.5 md:mt-0">{s.label}</div>
                  </Link>
                ))}
              </div>
            );
          })()}
      </div>

      {/* Project Description */}
      <div
        id="post"
        className="space-y-4 max-w-none text-base xs:text-lg prose dark:prose-invert text-left"
      >
        <MarkdownRenderer markdown={String(post[localeKey])} />
      </div>
    </article>
  );
}

export async function generateStaticParams() {
  const locales = ['en', 'it'];
  const portfolioPosts = (await getPosts(
    'portfolio',
    undefined,
    undefined,
    100
  )) as PortfolioPost[];
  const blogPosts = (await getPosts(
    'blog',
    undefined,
    undefined,
    100
  )) as BlogPost[];

  const portfolioParams = portfolioPosts.flatMap((post: PortfolioPost) =>
    locales.map((locale) => ({
      locale,
      post_type: 'portfolio',
      id: post.id.toString(),
      title: post.title_en.toLowerCase().replace(/\s+/g, '-'),
    }))
  );

  const blogParams = blogPosts.flatMap((post: BlogPost) =>
    locales.map((locale) => ({
      locale,
      post_type: 'blog',
      id: post.id.toString(),
      title:
        locale === 'en'
          ? post.title_en.toLowerCase().replace(/\s+/g, '-')
          : post.title_it.toLowerCase().replace(/\s+/g, '-'),
    }))
  );

  return [...portfolioParams, ...blogParams];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{
    post_type: string;
    id: string;
    title: string;
    locale: string;
  }>;
}) {
  const { id, post_type, locale } = await params;
  const normalizedLocale = locale === 'it' ? 'it' : 'en';

  if (!validPostTypes.has(post_type) || !numericIdPattern.test(id)) {
    return {
      title: normalizedLocale === 'en' ? 'Post Not Found' : 'Post non trovato',
      description:
        normalizedLocale === 'en'
          ? 'The requested post could not be found.'
          : 'Il post richiesto non è stato trovato',
    };
  }

  const post: PortfolioPost | BlogPost | null = await getPost(id, post_type);

  if (!post) {
    return {
      title: normalizedLocale === 'en' ? 'Post Not Found' : 'Post non trovato',
      description:
        normalizedLocale === 'en'
          ? 'The requested post could not be found.'
          : 'Il post richiesto non è stato trovato',
    };
  }

  const postDescription = `description_${normalizedLocale}` as keyof typeof post;
  const postTitle =
    post_type === 'blog'
      ? (`title_${normalizedLocale}` as keyof typeof post)
      : 'title_en';

  return {
    title: `${post[postTitle]} - Okazakee WS`,
    description: post[postDescription],
    openGraph: {
      title: `${post[postTitle]} - Okazakee WS`,
      description: post[postDescription],
      images: [
        {
          url: post.image,
          width: 1200,
          height: 630,
          alt: post[postTitle],
        },
      ],
    },
  };
}

import { ErrorDiv } from '@components/common/ErrorDiv';
import PostCard from '@components/common/PostCard';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { InnerHtml } from '@/components/common/InnerHtml';
import { formatLabels } from '@/utils/formatLabels';
import { getBlogPosts, getPortfolioPosts } from '@/utils/getData';

export default async function PostsSection({ locale }: { locale: string }) {
  const portfolioPosts = await getPortfolioPosts();
  const blogPosts = await getBlogPosts();

  const t = await getTranslations({ locale, namespace: 'posts-section' });
  const sections = ['Portfolio', 'Blog'] as const;

  if (!portfolioPosts || !blogPosts)
    return <ErrorDiv>Error loading posts sections data</ErrorDiv>;

  return (
    <div>
      {sections.map((section) => {
        const isBlog = section === 'Blog';

        const postsCheck = isBlog ? blogPosts : portfolioPosts;

        return (
          postsCheck.length > 0 && (
            <section
              key={section}
              id={section}
              className={`text-center sm:mx-20 md:mx-auto mx-5 md:w-full mt-20 md:mt-20 lg:mt-32 xl:mt-40 ${
                postsCheck.length > 2 && 'md:min-h-lvh'
              }`}
            >
              <InnerHtml
                as="h1"
                className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-5"
                html={formatLabels(t(isBlog ? 'title2' : 'title1'))}
              />
              <InnerHtml
                as="h2"
                className="mb-10 md:mb-20 text-base xs:text-lg tablet:text-2xl tablet:mx-16 md:text-2xl"
                html={formatLabels(t(isBlog ? 'subtitle2' : 'subtitle1'))}
              />
              <div className="flex flex-wrap gap-6 justify-center mx-5 transition-all">
                {postsCheck.map((post) => (
                  <PostCard key={post.id} post={post} locale={locale} />
                ))}
              </div>
              <Link href={`/${locale}/${isBlog ? 'blog' : 'portfolio'}`}>
                <button
                  type="button"
                  className="mt-10 md:mt-20 bg-secondary hover:bg-tertiary text-lighttext transition-all px-5 py-2 rounded-lg text-xl scale-[85%] sm:scale-100 xs:scale-100"
                >
                  {t('button')}
                </button>
              </Link>
            </section>
          )
        );
      })}
    </div>
  );
}

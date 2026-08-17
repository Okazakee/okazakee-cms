import { getPosts } from '@utils/getData';
import type { MetadataRoute } from 'next';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.DOMAIN_URL;
  const locales = ['en', 'it'];

  // Get all posts
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

  // Create sitemap entries for each locale and post
  const portfolioUrls =
    portfolioPosts?.flatMap((post) =>
      locales.map((locale) => ({
        url: `${baseUrl}/${locale}/portfolio/${post.id}/${post[`title_${locale === 'en' ? 'en' : 'it'}`]?.toLowerCase().replace(/\s+/g, '-') || post.title_en.toLowerCase().replace(/\s+/g, '-')}`,
        lastModified: post.created_at,
        changeFrequency: 'monthly' as const,
        priority: 0.8,
      }))
    ) || [];

  const blogUrls =
    blogPosts?.flatMap((post) =>
      locales.map((locale) => ({
        url: `${baseUrl}/${locale}/blog/${post.id}/${post[`title_${locale === 'en' ? 'en' : 'it'}`]?.toLowerCase().replace(/\s+/g, '-') || post.title_en.toLowerCase().replace(/\s+/g, '-')}`,
        lastModified: post.created_at,
        changeFrequency: 'monthly' as const,
        priority: 0.8,
      }))
    ) || [];

  // Add static pages for each locale
  const staticPages = locales.flatMap((locale) => [
    {
      url: `${baseUrl}/${locale}`,
      changeFrequency: 'weekly' as const,
      priority: 1,
    },
  ]);

  return [...staticPages, ...portfolioUrls, ...blogUrls];
}

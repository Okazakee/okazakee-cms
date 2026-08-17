import { createClient } from '@supabase/supabase-js';
import { cacheLife, cacheTag } from 'next/cache';
import { publicConfig } from '@/config/public';
import { authorTag, cacheTags, postDetailTag } from '@/libs/content/cacheTags';
import type {
  BlogPost,
  CareerEntry,
  Contact,
  HeroSection,
  PortfolioPost,
  ResumeData,
  SkillsCategory,
} from '@/types/fetchedData.types';

// Initialize Supabase client
const supabase = createClient(
  publicConfig.supabaseUrl,
  publicConfig.supabasePublishableKey
);

const isDevEnv = process.env.NODE_ENV === 'development';
const enforcePublishDate = publicConfig.contentEnforcePublishDate;
const SUPABASE_CACHE_PROFILE = 'supabaseContent';
const DEV_CACHE_LIFE = { stale: 30, revalidate: 60, expire: 300 };

const getCurrentTime = () => new Date().toISOString();

function applySupabaseCacheLife() {
  if (isDevEnv) {
    cacheLife(DEV_CACHE_LIFE);
    return;
  }

  cacheLife(SUPABASE_CACHE_PROFILE);
}

export async function getTranslationsSupabase(locale: string) {
  'use cache';
  cacheTag(cacheTags.translations);
  applySupabaseCacheLife();

  const { data, error } = await supabase
    .from('i18n_translations')
    .select('translations')
    .eq('language', locale)
    .single();

  if (error?.code === 'PGRST116') {
    return null;
  }

  if (error) {
    console.error('Error fetching translations:', error);
    throw error;
  }

  return data?.translations ? data.translations : {};
}

export async function getPrivacyPolicy(locale: string): Promise<string | null> {
  'use cache';
  cacheTag(cacheTags.privacyPolicy);
  applySupabaseCacheLife();

  const { data, error } = await supabase
    .from('i18n_translations')
    .select('privacy_policy')
    .eq('language', locale)
    .single();

  if (error?.code === 'PGRST116') {
    return null;
  }

  if (error) {
    console.error('Error fetching privacy policy:', error);
    throw error;
  }

  return data?.privacy_policy || null;
}

export async function getHeroSection(): Promise<HeroSection | null> {
  'use cache';
  cacheTag(cacheTags.hero);
  applySupabaseCacheLife();

  const { data, error } = await supabase
    .from('hero_section')
    .select('id, propic, blurhashURL')
    .single();

  if (error?.code === 'PGRST116') {
    return null;
  }

  if (error) {
    console.error(error);
    throw error;
  }

  return data;
}

export async function getSkillsCategories(): Promise<SkillsCategory[] | null> {
  'use cache';
  cacheTag(cacheTags.skills);
  applySupabaseCacheLife();

  const { data, error } = await supabase
    .from('skills_categories')
    .select(`
      id,
      name,
      position,
      skills (
        id,
        title,
        icon,
        invert,
        category_id,
        blurhashURL
      )
    `)
    .order('position', { ascending: true });

  if (error) {
    console.error(error);
    throw error;
  }

  return data;
}

export async function getPortfolioPosts(): Promise<PortfolioPost[] | null> {
  'use cache';
  cacheTag(cacheTags.portfolio);
  applySupabaseCacheLife();

  let query = supabase
    .from('portfolio_posts')
    .select('*')
    .eq('hidden', false)
    .limit(3);

  if (enforcePublishDate) {
    query = query.lte('created_at', getCurrentTime());
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching posts:', error);
    throw error;
  }

  return data;
}

export async function getBlogPosts(): Promise<BlogPost[] | null> {
  'use cache';
  cacheTag(cacheTags.blog);
  applySupabaseCacheLife();

  let query = supabase
    .from('blog_posts')
    .select('*')
    .eq('hidden', false)
    .limit(3);

  if (enforcePublishDate) {
    query = query.lte('created_at', getCurrentTime());
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching posts:', error);
    throw error;
  }

  return data;
}

export async function getContacts(): Promise<Contact[] | null> {
  'use cache';
  cacheTag(cacheTags.contacts);
  applySupabaseCacheLife();

  const { data, error } = await supabase.from('contacts').select('*');

  if (error) {
    console.error(error);
    throw error;
  }

  return data;
}

async function queryPosts(
  type: string,
  searchQuery?: string,
  locale?: string,
  limit?: number
): Promise<BlogPost[] | PortfolioPost[] | null> {
  const table = type === 'blog' ? 'blog_posts' : 'portfolio_posts';

  let query = supabase.from(table).select('*').eq('hidden', false);

  if (enforcePublishDate) {
    query = query.lte('created_at', getCurrentTime());
  }

  if (searchQuery) {
    const searchTerm = searchQuery.toLowerCase();
    query = query.or(
      `title_en.ilike.%${searchTerm}%,description_${locale}.ilike.%${searchTerm}%,post_tags.ilike.%${searchTerm}%`
    );
  }

  if (limit !== undefined) {
    query = query.limit(limit);
  }

  const { data: postsData, error: postsErr } = await query.order('created_at', {
    ascending: false,
  });

  if (postsErr) {
    console.error('Error fetching posts:', postsErr);
    throw postsErr;
  }

  return postsData;
}

export async function getPosts(
  type: string,
  searchQuery?: string,
  locale?: string,
  limit?: number
): Promise<BlogPost[] | PortfolioPost[] | null> {
  'use cache';
  cacheTag(cacheTags.posts);
  applySupabaseCacheLife();

  return queryPosts(type, searchQuery, locale, limit);
}

export async function searchPostsData(
  type: string,
  searchQuery: string,
  locale: string
): Promise<BlogPost[] | PortfolioPost[] | null> {
  return queryPosts(type, searchQuery, locale);
}

export type PostAuthor = {
  id: string;
  display_name: string;
  avatar_url: string | null;
};

export type PostWithAuthor = (PortfolioPost | BlogPost) & {
  author?: PostAuthor | null;
};

export async function getPost(
  id: string,
  type: string
): Promise<PostWithAuthor | null> {
  'use cache';
  cacheTag(cacheTags.post); // legacy broad detail tag (migration compat)
  cacheTag(postDetailTag(type === 'portfolio' ? 'portfolio' : 'blog', id));
  applySupabaseCacheLife();

  const tableName = type === 'portfolio' ? 'portfolio_posts' : 'blog_posts';

  let query = supabase
    .from(tableName)
    .select('*')
    .eq('id', id)
    .eq('hidden', false);

  if (enforcePublishDate) {
    query = query.lte('created_at', getCurrentTime());
  }

  const { data, error } = await query.single();

  if (error?.code === 'PGRST116') {
    return null;
  }

  if (error) {
    console.error(`Error fetching ${type} post:`, error);
    throw error;
  }

  let author: PostAuthor | null = null;
  if (data?.author_id) {
    cacheTag(authorTag(data.author_id));
    const { data: authorData } = await supabase
      .from('user_profiles')
      .select('id, display_name, avatar_url')
      .eq('id', data.author_id)
      .single();

    if (authorData) {
      author = authorData;
    }
  }

  return { ...data, author };
}

export async function getResumeLink(
  locale?: string
): Promise<ResumeData | null> {
  'use cache';
  cacheTag(cacheTags.resume);
  cacheTag(cacheTags.heroSection);
  applySupabaseCacheLife();

  const { data, error } = await supabase
    .from('hero_section')
    .select('resume_en, resume_it')
    .single();

  if (error?.code === 'PGRST116') {
    return null;
  }

  if (error) {
    console.error('Error fetching resume link:', error);
    throw error;
  }

  if (locale) {
    return data[`resume_${locale}` as keyof ResumeData];
  }

  return data;
}

export async function getCareerEntries(): Promise<CareerEntry[] | null> {
  'use cache';
  cacheTag(cacheTags.career);
  applySupabaseCacheLife();

  const { data, error } = await supabase
    .from('career_entries')
    .select('*')
    .order('id', { ascending: false });

  if (error) {
    console.error('Error fetching career entries:', error);
    throw error;
  }

  return (data?.map((entry) => ({
    ...entry,
    blurhashURL:
      (entry as Record<string, unknown>).blurhashURL ??
      (entry as Record<string, unknown>).blurhashurl ??
      '',
  })) || null) as CareerEntry[] | null;
}

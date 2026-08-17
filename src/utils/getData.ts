import { createClient } from '@supabase/supabase-js';
import { cacheLife, cacheTag } from 'next/cache';
import { publicConfig } from '@/config/public';
import { cacheTags } from '@/libs/content/cacheTags';

// Initialize Supabase client
const supabase = createClient(
  publicConfig.supabaseUrl,
  publicConfig.supabasePublishableKey
);

const isDevEnv = process.env.NODE_ENV === 'development';
const SUPABASE_CACHE_PROFILE = 'supabaseContent';
const DEV_CACHE_LIFE = { stale: 30, revalidate: 60, expire: 300 };

function applySupabaseCacheLife() {
  if (isDevEnv) {
    cacheLife(DEV_CACHE_LIFE);
    return;
  }

  cacheLife(SUPABASE_CACHE_PROFILE);
}

/**
 * Public content translations, fetched for CMS previews and shell labels.
 * This is data in Supabase (i18n_translations), not static CMS UI messages.
 */
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

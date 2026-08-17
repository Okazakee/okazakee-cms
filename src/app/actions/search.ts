'use server';

import { searchPostsData } from '@/utils/getData';

export async function searchPosts(
  post_type: string,
  searchQuery: string,
  locale: string
) {
  try {
    const posts = await searchPostsData(post_type, searchQuery, locale);
    return { posts };
  } catch (error) {
    console.error('Search error:', error);
    return { error: 'An error occurred while searching' };
  }
}

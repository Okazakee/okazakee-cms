'use server';

import { headers } from 'next/headers';
import { createClient } from '@/utils/supabase/server';

export async function incrementViews(
  postId: string,
  postType: 'blog' | 'portfolio'
) {
  try {
    // Get the host header to check if it's a beta domain
    const headersList = await headers();
    const host = headersList.get('host');

    // Don't count views from beta domains or localhost
    if (host?.includes('beta.') || host?.includes('localhost')) {
      return { success: true, message: 'View not counted (beta/localhost)' };
    }

    const supabase = await createClient();

    const functionName =
      postType === 'portfolio'
        ? 'increment_portfolio_post_views_bigint'
        : 'increment_blog_post_views_bigint';

    const { error } = await supabase.rpc(functionName, {
      p_id: Number(postId),
    });

    if (error) {
      console.error('Error calling increment function:', error);
      return { success: false, error: error.message };
    }

    return { success: true, message: 'View counted successfully' };
  } catch (error) {
    console.error('Error in incrementViews:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

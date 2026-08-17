import type { User } from '@supabase/supabase-js';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import {
  getUserAuthProvider,
  getUserAvatarUrl,
  getUserDisplayName,
  getUserGithubUsername,
} from './auth';

type CmsProfile = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  auth_provider: string | null;
  github_username: string | null;
};

export async function syncCmsUserProfile(user: User): Promise<void> {
  const adminClient = getCmsAdminClient();
  const githubUsername = getUserGithubUsername(user);
  const authProvider = getUserAuthProvider(user);

  const { data: existingProfile, error: readError } = await adminClient
    .from('user_profiles')
    .select(
      'id, email, display_name, avatar_url, auth_provider, github_username'
    )
    .eq('id', user.id)
    .maybeSingle<CmsProfile>();

  if (readError) throw readError;

  if (!existingProfile) {
    const { error } = await adminClient.from('user_profiles').insert({
      id: user.id,
      email: user.email || null,
      display_name: getUserDisplayName(user),
      avatar_url: getUserAvatarUrl(user),
      auth_provider: authProvider,
      github_username: githubUsername,
    });
    if (error) throw error;
    return;
  }

  const updates: Partial<CmsProfile> = {};
  if (existingProfile.email !== user.email) updates.email = user.email || null;
  if (existingProfile.auth_provider !== authProvider) {
    updates.auth_provider = authProvider;
  }
  if (githubUsername && existingProfile.github_username !== githubUsername) {
    updates.github_username = githubUsername;
  }
  if (!existingProfile.display_name) {
    updates.display_name = getUserDisplayName(user);
  }
  if (!existingProfile.avatar_url) updates.avatar_url = getUserAvatarUrl(user);

  if (Object.keys(updates).length === 0) return;

  const { error } = await adminClient
    .from('user_profiles')
    .update(updates)
    .eq('id', user.id);
  if (error) throw error;
}

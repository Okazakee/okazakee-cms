'use server';

import {
  findAllowedCmsUser,
  getUserAuthProvider,
  getUserAvatarUrl,
  getUserDisplayName,
  getUserGithubUsername,
} from './utils/auth';
import { syncCmsUserProfile } from './utils/profileSync';
import { createClient } from '@/utils/supabase/server';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';

export type CMSUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'admin' | 'editor' | '';
  authProvider: 'email' | 'github' | 'dummy';
  githubUsername: string | null;
};

async function buildCmsUser(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<CMSUser | null> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return null;
  }

  // Fetch user profile from user_profiles table
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  const githubUsername = getUserGithubUsername(user);
  // Admin client: cms_allowed_users is internal (no anon/authenticated SELECT).
  const allowedUser = await findAllowedCmsUser(
    getCmsAdminClient(),
    user.email,
    githubUsername
  );

  // If no profile exists yet (edge case), create one from auth metadata
  if (!profile) {
    const displayName = getUserDisplayName(user);
    const avatarUrl = getUserAvatarUrl(user);
    const authProvider = getUserAuthProvider(user);

    await syncCmsUserProfile(user);

    return {
      id: user.id,
      email: user.email || '',
      displayName,
      avatarUrl,
      role: allowedUser?.role || '',
      authProvider,
      githubUsername,
    };
  }

  // Ensure avatarUrl is null if empty
  const profileAvatarUrl =
    profile.avatar_url && profile.avatar_url.length > 0
      ? profile.avatar_url
      : null;

  return {
    id: user.id,
    email: user.email || '',
    displayName: profile.display_name || user.email?.split('@')[0] || 'User',
    avatarUrl: profileAvatarUrl,
    role: allowedUser?.role || '',
    authProvider:
      (profile.auth_provider as 'email' | 'github' | 'dummy') || 'email',
    githubUsername: profile.github_username || null,
  };
}

export async function getUser(): Promise<CMSUser | null> {
  const supabase = await createClient();
  try {
    return await buildCmsUser(supabase);
  } catch {
    return null;
  }
}

export type CMSHeroBootData = {
  mainImage: string | null;
  blurhashURL: string | null;
  resume_en: string | null;
  resume_it: string | null;
};

export type CMSBootData =
  | {
      status: 'ok';
      user: CMSUser;
      heroSection: CMSHeroBootData | null;
    }
  | { status: 'unauthenticated' }
  | { status: 'unauthorized' }
  | { status: 'error'; error: string };

export async function getCmsBootData(): Promise<CMSBootData> {
  const supabase = await createClient();
  try {
    const user = await buildCmsUser(supabase);
    if (!user) return { status: 'unauthenticated' };

    if (!user.role) return { status: 'unauthorized' };

    if (user.role !== 'admin') {
      return { status: 'ok', user, heroSection: null };
    }

    const heroResult = await supabase
      .from('hero_section')
      .select('propic, blurhashURL, resume_en, resume_it')
      .maybeSingle();

    if (heroResult.error) throw heroResult.error;

    return {
      status: 'ok',
      user,
      heroSection: {
        mainImage: heroResult.data?.propic || null,
        blurhashURL: heroResult.data?.blurhashURL || null,
        resume_en: heroResult.data?.resume_en || null,
        resume_it: heroResult.data?.resume_it || null,
      },
    };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to load CMS',
    };
  }
}

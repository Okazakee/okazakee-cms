'use server';

import { errorMessage } from '@/libs/cms/mutationResult';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import type { HeroSettings } from '@/types/fetchedData.types';
import { createClient } from '@/utils/supabase/server';
import {
  findAllowedCmsUser,
  getUserAuthProvider,
  getUserAvatarUrl,
  getUserDisplayName,
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
} from './utils/auth';
import { syncCmsUserProfile } from './utils/profileSync';

export type CMSUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'admin' | 'editor' | '';
  authProvider: 'email' | 'github' | 'dummy';
  githubUsername: string | null;
  githubUserId?: string | null;
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

  // Own profile via the admin client (service-role-after-check: the caller
  // is authenticated above via auth.getUser). Column-narrowed to the fields
  // buildCmsUser renders; a session SELECT * cannot survive the narrowed
  // profile column grants.
  const { data: profile } = await getCmsAdminClient()
    .from('user_profiles')
    .select(
      'id, email, display_name, avatar_url, auth_provider, github_username, github_user_id'
    )
    .eq('id', user.id)
    .single();

  const githubUserId = getUserGithubId(user);
  const githubUsername = getUserGithubUsername(user);
  // Admin client: cms_allowed_users is internal (no anon/authenticated SELECT).
  // ID-first, then verified-email (returns immediately), then legacy handle.
  const allowedUser = await findAllowedCmsUser(getCmsAdminClient(), {
    email: getVerifiedUserEmail(user),
    githubUserId,
    githubUsernameLegacy: githubUsername,
  });

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
      githubUserId,
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
    githubUserId: profile.github_user_id ?? githubUserId,
  };
}

export async function getUser(): Promise<CMSUser | null> {
  const supabase = await createClient();
  try {
    const user = await buildCmsUser(supabase);
    return user?.role ? user : null;
  } catch {
    return null;
  }
}

export type CMSHeroBootData = HeroSettings;

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
      .select('propic, blurhashURL, resume_en, resume_it, shape')
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
        shape: heroResult.data?.shape || null,
      },
    };
  } catch (error) {
    return {
      status: 'error',
      error: errorMessage(error, 'Failed to load CMS'),
    };
  }
}

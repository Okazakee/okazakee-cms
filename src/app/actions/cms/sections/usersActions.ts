'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { refresh } from 'next/cache';
import {
  findAllowedCmsUser,
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
} from '@/app/actions/cms/utils/auth';
import {
  prepareImageUpload,
  removePublicFileIfDifferent,
  removePublicFileIfPresent,
  removeStorageObjectBestEffort,
  requireAuth,
  uploadImmutablePreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import { supabaseSchema } from '@/config/shared';
import {
  errorMessage,
  type MutationResult,
  type RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { getCmsStorageBucket } from '@/libs/cms/storage/bucket';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { createClient } from '@/utils/supabase/server';

type UserOperation =
  | { type: 'GET' }
  | { type: 'ADD_EMAIL'; email: string; role?: 'admin' | 'editor' }
  | { type: 'ADD_GITHUB'; github_username: string; role?: 'admin' | 'editor' }
  | { type: 'ADD_DUMMY'; display_name: string; role?: 'admin' | 'editor' }
  | { type: 'UPDATE_ROLE'; id: number; role: 'admin' | 'editor' }
  | { type: 'REMOVE'; id: number }
  | { type: 'UPDATE_PROFILE'; profileId: string; displayName?: string };

type AllowedUser = {
  id: number;
  email: string | null;
  github_user_id: string | null;
  github_username: string | null;
  role: 'admin' | 'editor';
  invited_at: string | null;
  created_at: string;
  // Profile data (if user has logged in)
  profile?: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
};

type UsersResult = MutationResult & {
  data?: AllowedUser | AllowedUser[];
};

// Email validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GitHub username validation (alphanumeric and hyphens, 1-39 chars)
const GITHUB_USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * Check if current user is an admin
 */
async function isAdmin(
  supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never
): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  // Allowlist is internal: lookup via admin client (service_role).
  // ID-first, then verified-email (returns immediately per current
  // behavior — a non-admin email match returns null here without falling
  // through to an admin GitHub ID), then legacy display handle.
  const verifiedEmail = getVerifiedUserEmail(user);
  const githubUserId = getUserGithubId(user);
  if (githubUserId) {
    const idMatch = await findAllowedCmsUser(getCmsAdminClient(), {
      githubUserId,
    });
    if (idMatch) return idMatch.role === 'admin';
  }
  if (verifiedEmail) {
    const emailMatch = await findAllowedCmsUser(getCmsAdminClient(), {
      email: verifiedEmail,
    });
    // Email decides here: an allowlisted non-admin email must not fall
    // through to a legacy/admin GitHub identity on the same session.
    if (emailMatch) return emailMatch.role === 'admin';
    return false;
  }
  const allowedUser = await findAllowedCmsUser(getCmsAdminClient(), {
    githubUsernameLegacy: getUserGithubUsername(user),
  });
  return allowedUser?.role === 'admin';
}

export async function usersActions(
  operation: UserOperation
): Promise<UsersResult> {
  // Auth check
  try {
    await requireAuth();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();

  // Admin check for every operation. User management (including listing
  // allowlist emails/GitHub usernames) is admin-only. The blog/portfolio
  // author picker uses blogActions GET_AUTHORS, not this list.
  {
    const admin = await isAdmin(supabase);
    if (!admin) {
      return { success: false, error: 'Unauthorized: Admin access required' };
    }
  }

  try {
    switch (operation.type) {
      case 'GET':
        return await getAllowedUsers(supabase);

      case 'ADD_EMAIL':
        return await addEmailUser(supabase, operation.email, operation.role);

      case 'ADD_GITHUB':
        return await addGitHubUser(
          supabase,
          operation.github_username,
          operation.role
        );

      case 'ADD_DUMMY':
        return await addDummyUser(
          supabase,
          operation.display_name,
          operation.role
        );

      case 'UPDATE_ROLE':
        return await updateUserRole(supabase, operation.id, operation.role);

      case 'REMOVE':
        return await removeUser(supabase, operation.id);

      case 'UPDATE_PROFILE':
        return await updateUserProfile(
          supabase,
          operation.profileId,
          operation.displayName
        );

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Users action error:', error);
    return {
      success: false,
      error: errorMessage(error, 'An unknown error occurred'),
    };
  }
}

async function getAllowedUsers(
  supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never
): Promise<UsersResult> {
  // Allowlist is internal: read via admin client (service_role).
  const { data, error } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Display-only handle from the verified identity; never user_metadata.
  // Profiles match by email or immutable ID — the allowlist row is never
  // mutated here (no editable-username back-write).
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const authGithubUserId = authUser ? getUserGithubId(authUser) : null;
  const authGithubUsername = authUser ? getUserGithubUsername(authUser) : null;

  // Fetch all user profiles to match with allowed users (no cache to ensure fresh data)
  const adminClient = getCmsAdminClient();
  const { data: profiles, error: profilesError } = await adminClient
    .from('user_profiles')
    .select(
      'id, email, display_name, avatar_url, github_username, github_user_id'
    );

  if (profilesError) {
    console.error('Error fetching profiles:', profilesError);
  }

  // Match profiles with allowed users. Display handle prefers the verified
  // identity for the current session, then the stored profile, then the
  // allowlist row. No writes: backfill flows own identity persistence.
  const usersWithProfiles = (data as AllowedUser[]).map((allowedUser) => {
    // Find profile by email, immutable GitHub ID, or display handle.
    const profile = profiles?.find(
      (p) =>
        (allowedUser.email &&
          p.email?.toLowerCase() === allowedUser.email.toLowerCase()) ||
        (allowedUser.github_user_id &&
          p.github_user_id === allowedUser.github_user_id) ||
        (allowedUser.github_username &&
          p.github_username === allowedUser.github_username) ||
        (authUser?.id &&
          p.id === authUser.id &&
          allowedUser.email &&
          p.email?.toLowerCase() === allowedUser.email.toLowerCase())
    );

    let githubUsername =
      profile?.github_username || allowedUser.github_username;
    if (
      authUser &&
      profile?.id === authUser.id &&
      authGithubUsername &&
      (!authGithubUserId ||
        !allowedUser.github_user_id ||
        profile?.github_user_id === allowedUser.github_user_id)
    ) {
      githubUsername = authGithubUsername;
    }

    return {
      ...allowedUser,
      github_username: githubUsername,
      profile: profile
        ? {
            id: profile.id,
            display_name: profile.display_name,
            avatar_url: profile.avatar_url,
          }
        : null,
    };
  });

  return { success: true, data: usersWithProfiles };
}

async function addEmailUser(
  _supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  email: string,
  role: 'admin' | 'editor' = 'editor'
): Promise<UsersResult> {
  // Validate email
  if (!email || !EMAIL_REGEX.test(email)) {
    return { success: false, error: 'Please enter a valid email address' };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check if already exists
  const { data: existing } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select('id')
    .eq('email', normalizedEmail)
    .single();

  if (existing) {
    return {
      success: false,
      error: 'This email is already in the allowed list',
    };
  }

  // Add to allowlist
  const { data: newUser, error: insertError } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .insert({ email: normalizedEmail, role })
    .select()
    .single();

  if (insertError) throw insertError;

  // Password login no longer exists: an allowlisted email is claimed by
  // signing in with GitHub OAuth using that same address. No Supabase auth
  // user is provisioned and no invite email is sent.
  return { success: true, data: newUser as AllowedUser };
}

async function addGitHubUser(
  _supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  github_username: string,
  role: 'admin' | 'editor' = 'editor'
): Promise<UsersResult> {
  // Validate GitHub handle shape first (alphanumeric/hyphens, 1-39 chars).
  const cleanUsername = github_username.trim().replace(/^@/, '');

  if (!cleanUsername || !GITHUB_USERNAME_REGEX.test(cleanUsername)) {
    return { success: false, error: 'Please enter a valid GitHub username' };
  }

  // Resolve the handle to the immutable numeric GitHub user ID via the
  // public GitHub API (no auth/token). The ID authorizes; the handle is
  // display-only. Non-logged-in handles can only be added this way.
  let githubUserId: string;
  try {
    const response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(cleanUsername)}`,
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    if (response.status === 404) {
      return { success: false, error: 'GitHub user not found' };
    }
    if (!response.ok) {
      return {
        success: false,
        error: 'Could not verify the GitHub username. Please try again.',
      };
    }
    const payload = (await response.json()) as {
      id?: unknown;
      login?: unknown;
    };
    const rawId = payload.id;
    githubUserId =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId)
        : '';
    if (!/^[0-9]+$/.test(githubUserId)) {
      return {
        success: false,
        error: 'Could not verify the GitHub username. Please try again.',
      };
    }
  } catch {
    return {
      success: false,
      error: 'Could not verify the GitHub username. Please try again.',
    };
  }

  // Dedupe on the immutable ID (handles can be renamed/transferred).
  const { data: existing } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select('id')
    .eq('github_user_id', githubUserId)
    .single();

  if (existing) {
    return {
      success: false,
      error: 'This GitHub user is already in the allowed list',
    };
  }

  // Add to allowlist (no invite needed - they'll use GitHub OAuth).
  // Both columns persist: ID authorizes, handle only renders.
  const { data: newUser, error: insertError } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .insert({
      github_user_id: githubUserId,
      github_username: cleanUsername,
      role,
    })
    .select()
    .single();

  if (insertError) throw insertError;

  return { success: true, data: newUser as AllowedUser };
}

async function addDummyUser(
  _supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  displayName: string,
  role: 'admin' | 'editor' = 'editor'
): Promise<UsersResult> {
  // Validate display name
  const trimmedName = displayName.trim();
  if (!trimmedName || trimmedName.length === 0) {
    return { success: false, error: 'Please enter a display name' };
  }

  if (trimmedName.length > 100) {
    return {
      success: false,
      error: 'Display name must be 100 characters or less',
    };
  }

  // Generate a UUID for the email format
  const emailUuid = crypto.randomUUID();

  // Create dummy email for matching (format: dummy-{uuid}@dummy.local)
  const dummyEmail = `dummy-${emailUuid}@dummy.local`;

  // Use admin client to create auth user and profile (bypasses RLS)
  const adminClient = getCmsAdminClient();

  // Check if a dummy user with this email already exists in cms_allowed_users
  const { data: existingAllowed } = await adminClient
    .from('cms_allowed_users')
    .select('id')
    .eq('email', dummyEmail)
    .single();

  if (existingAllowed) {
    return {
      success: false,
      error: 'A dummy user already exists. Please try again.',
    };
  }

  // Check if profile with this email already exists (from a previous failed attempt)
  // If profile exists, we can reuse the auth user ID
  let authUserId: string | null = null;
  const { data: existingProfileByEmail } = await adminClient
    .from('user_profiles')
    .select('id')
    .eq('email', dummyEmail)
    .single();

  if (existingProfileByEmail) {
    authUserId = existingProfileByEmail.id;
  }

  // Create auth user if it doesn't exist
  if (!authUserId) {
    // Use a random password that won't be used (dummy users can't log in)
    const tempPassword = crypto.randomUUID() + crypto.randomUUID(); // Long random password
    const { data: createdAuthUser, error: authError } =
      await adminClient.auth.admin.createUser({
        email: dummyEmail,
        password: tempPassword,
        email_confirm: true, // Auto-confirm
        user_metadata: {
          is_dummy: true, // Mark as dummy user
        },
      });

    if (authError || !createdAuthUser.user) {
      console.error('Error creating dummy auth user:', authError);
      return {
        success: false,
        error: `Failed to create auth user: ${authError?.message || 'Unknown error'}`,
      };
    }

    authUserId = createdAuthUser.user.id;
  }

  // Check if profile already exists and update or create
  const { data: existingProfile } = await adminClient
    .from('user_profiles')
    .select('id')
    .eq('id', authUserId)
    .single();

  if (existingProfile) {
    // Profile exists, update it
    const { error: updateError } = await adminClient
      .from('user_profiles')
      .update({
        display_name: trimmedName,
        email: dummyEmail,
        github_username: null,
        auth_provider: 'dummy',
      })
      .eq('id', authUserId);

    if (updateError) {
      console.error('Error updating dummy user profile:', updateError);
      return {
        success: false,
        error: `Failed to update profile: ${updateError.message}`,
      };
    }
  } else {
    // Profile doesn't exist, create it
    const { error: profileError } = await adminClient
      .from('user_profiles')
      .insert({
        id: authUserId,
        display_name: trimmedName,
        email: dummyEmail,
        github_username: null,
        auth_provider: 'dummy',
        avatar_url: null,
      });

    if (profileError) {
      console.error('Error creating dummy user profile:', profileError);
      // Clean up auth user if profile creation fails
      try {
        await adminClient.auth.admin.deleteUser(authUserId);
      } catch (deleteError) {
        console.error('Error cleaning up auth user:', deleteError);
      }
      return {
        success: false,
        error: `Failed to create profile: ${profileError.message}`,
      };
    }
  }

  // Create entry in cms_allowed_users
  const { data: newUser, error: insertError } = await adminClient
    .from('cms_allowed_users')
    .insert({ email: dummyEmail, role })
    .select()
    .single();

  if (insertError) {
    // If insert fails, clean up both profile and auth user
    try {
      await adminClient.from('user_profiles').delete().eq('id', authUserId);
      await adminClient.auth.admin.deleteUser(authUserId);
    } catch (cleanupError) {
      console.error('Error cleaning up after failed insert:', cleanupError);
    }
    throw insertError;
  }

  // Revalidate CMS paths to ensure fresh data
  refresh();

  return { success: true, data: newUser as AllowedUser };
}

async function updateUserRole(
  _supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  id: number,
  role: 'admin' | 'editor'
): Promise<UsersResult> {
  // Prevent removing the last admin
  if (role === 'editor') {
    const { data: admins } = await getCmsAdminClient()
      .from('cms_allowed_users')
      .select('id')
      .eq('role', 'admin');

    if (admins && admins.length === 1 && admins[0].id === id) {
      return { success: false, error: 'Cannot demote the last admin' };
    }
  }

  const { data, error } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .update({ role })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  // Revalidate CMS paths to ensure fresh data
  refresh();

  return { success: true, data: data as AllowedUser };
}

async function removeUser(
  _supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  id: number
): Promise<UsersResult> {
  const bucket = getCmsStorageBucket();
  // Prevent removing the last admin
  const { data: user, error: lookupError } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select('role, email, github_user_id, github_username')
    .eq('id', id)
    .single();
  if (lookupError && lookupError.code !== 'PGRST116') throw lookupError;

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  if (user.role === 'admin') {
    const { data: admins, error: adminsError } = await getCmsAdminClient()
      .from('cms_allowed_users')
      .select('id')
      .eq('role', 'admin');
    if (adminsError) throw adminsError;

    if (!admins || admins.length <= 1) {
      return { success: false, error: 'Cannot remove the last admin' };
    }
  }

  // Find and delete user profile
  const adminClient = getCmsAdminClient();
  let profile: { id: string; avatar_url: string | null } | null = null;

  // Check if this is a dummy user (email format: dummy-{uuid}@dummy.local)
  const isDummyUser =
    user.email?.startsWith('dummy-') && user.email?.endsWith('@dummy.local');

  // Try to find profile by email (works for both dummy and regular users)
  if (user.email) {
    const { data, error } = await adminClient
      .from('user_profiles')
      .select('id, avatar_url')
      .eq('email', user.email.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    profile = data;
  }

  // Try immutable GitHub ID before the legacy display handle.
  if (!profile && user.github_user_id) {
    const { data, error } = await adminClient
      .from('user_profiles')
      .select('id, avatar_url')
      .eq('github_user_id', user.github_user_id)
      .maybeSingle();
    if (error) throw error;
    profile = data;
  }

  // Legacy display handle last (dual-allowed transition only).
  if (!profile && !user.github_user_id && user.github_username) {
    const { data, error } = await adminClient
      .from('user_profiles')
      .select('id, avatar_url')
      .eq('github_username', user.github_username)
      .maybeSingle();
    if (error) throw error;
    profile = data;
  }

  // Delete from cms_allowed_users
  const { data: deletedAllowedUser, error } = await adminClient
    .from('cms_allowed_users')
    .delete()
    .eq('id', id)
    .select('id')
    .single();

  if (error) throw error;
  if (!deletedAllowedUser) throw new Error('User removal returned no row');

  // Delete from user_profiles if found (using admin client to bypass RLS)
  if (profile) {
    const { data: deletedProfile, error: deleteProfileError } =
      await adminClient
        .from('user_profiles')
        .delete()
        .eq('id', profile.id)
        .select('id, avatar_url')
        .single();

    if (deleteProfileError || !deletedProfile) {
      throw new Error('Access revoked, but failed to remove the user profile');
    }

    // Exact configured-bucket cleanup only after returned-row DB evidence.
    await removePublicFileIfPresent(
      adminClient,
      deletedProfile.avatar_url,
      bucket
    );

    // Auth is shared across schemas; staging must never cascade public rows.
    if (isDummyUser && supabaseSchema === 'public') {
      const { error: deleteAuthError } =
        await adminClient.auth.admin.deleteUser(profile.id);
      if (deleteAuthError) {
        throw new Error(
          'Profile removed, but failed to remove dummy auth user'
        );
      }
    }
  }

  let revalidation: RevalidationStatus | undefined;
  if (profile) {
    revalidation = await invalidatePublicContent({
      entity: 'author',
      operation: 'update',
      id: profile.id,
    });
  }

  // Revalidate CMS paths to ensure fresh data
  refresh();

  return { success: true, revalidation };
}

async function updateUserProfile(
  _supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  profileId: string,
  displayName?: string
): Promise<UsersResult> {
  const updates: { display_name?: string } = {};

  if (displayName && displayName.trim().length > 0) {
    if (displayName.trim().length > 100) {
      return {
        success: false,
        error: 'Display name must be 100 characters or less',
      };
    }
    updates.display_name = displayName.trim();
  }

  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No changes to save' };
  }

  // Require returned-row evidence so a missing profile never reports success.
  const { error } = await getCmsAdminClient()
    .from('user_profiles')
    .update(updates)
    .eq('id', profileId)
    .select('id')
    .single();

  if (error) throw error;

  const revalidation = await invalidatePublicContent({
    entity: 'author',
    operation: 'update',
    id: profileId,
  });
  return { success: true, revalidation };
}

/**
 * Upload avatar for a specific user (admin only)
 */
export async function uploadUserAvatar(
  formData: FormData
): Promise<ProfileUpdateResult> {
  try {
    await requireAuth();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();

  // Check if admin
  const admin = await isAdmin(supabase);
  if (!admin) {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  const profileId = formData.get('profileId') as string;
  const avatarFile = formData.get('avatar') as File | null;

  if (!profileId) {
    return { success: false, error: 'Profile ID is required' };
  }

  if (!avatarFile || avatarFile.size === 0) {
    return { success: false, error: 'Please select an image' };
  }

  // Validate the image
  const validation = validateImageFile(avatarFile);
  if (!validation.isValid) {
    return { success: false, error: validation.error };
  }

  const adminClient = getCmsAdminClient();
  const bucket = getCmsStorageBucket();

  // Format-aware processing: extension and MIME follow the ACTUAL processed
  // format (WebP passthrough or Sharp fallback, which may produce PNG).
  const prepared = await prepareImageUpload(avatarFile, undefined, {
    maxWidth: 256,
    maxHeight: 256,
    quality: 85,
  });
  if (!prepared.success) {
    return { success: false, error: prepared.error };
  }

  // Get current avatar URL to remove the old file AFTER the DB commit. A
  // missing profile row fails fast: without returned-row evidence a success
  // must never be reported and no orphan upload left behind.
  const { data: currentProfile, error: profileError } = await adminClient
    .from('user_profiles')
    .select('avatar_url')
    .eq('id', profileId)
    .single();
  if (profileError || !currentProfile) {
    return { success: false, error: 'Profile not found' };
  }

  // Unique immutable path: the new avatar never overwrites the previous one,
  // so a failed DB update can never leave the row pointing at a deleted
  // object. The previous DB-referenced avatar is removed after the commit.
  let upload: { publicUrl: string; path: string };
  try {
    upload = await uploadImmutablePreparedImage(
      adminClient,
      bucket,
      'Website Assets/avatars',
      profileId,
      prepared.image
    );
  } catch (uploadError) {
    console.error('Avatar upload error:', uploadError);
    return { success: false, error: 'Failed to upload avatar' };
  }

  // Add cache-busting param
  const avatarUrl = `${upload.publicUrl}?t=${Date.now()}`;
  const { data: updatedProfile, error: updateError } = await adminClient
    .from('user_profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', profileId)
    .select('id')
    .single();

  if (updateError || !updatedProfile) {
    await removeStorageObjectBestEffort(adminClient, bucket, upload.path);
    console.error('Profile update error:', updateError);
    return { success: false, error: 'Failed to update profile' };
  }

  // DB committed: clean up the old avatar file (best-effort).
  await removePublicFileIfDifferent(
    adminClient,
    currentProfile?.avatar_url,
    bucket,
    upload.path
  );

  // Revalidate CMS paths to ensure fresh data
  refresh();
  const revalidation = await invalidatePublicContent({
    entity: 'author',
    operation: 'update',
    id: profileId,
  });

  return { success: true, avatarUrl, revalidation };
}

/**
 * Update a user's display name (admin only)
 */
export async function updateUserDisplayName(
  profileId: string,
  displayName: string
): Promise<ProfileUpdateResult> {
  try {
    await requireAuth();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();

  // Check if admin
  const admin = await isAdmin(supabase);
  if (!admin) {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  if (!profileId) {
    return { success: false, error: 'Profile ID is required' };
  }

  if (!displayName || displayName.trim().length === 0) {
    return { success: false, error: 'Display name is required' };
  }
  if (displayName.trim().length > 100) {
    return {
      success: false,
      error: 'Display name must be 100 characters or less',
    };
  }

  // Use admin client to bypass RLS when updating other users' profiles
  const adminClient = getCmsAdminClient();

  // Update user_profiles table using admin client; require returned-row
  // evidence so a missing profile never reports success.
  const { error: updateError } = await adminClient
    .from('user_profiles')
    .update({ display_name: displayName.trim() })
    .eq('id', profileId)
    .select('id')
    .single();

  if (updateError) {
    console.error('Profile update error:', updateError);
    return { success: false, error: 'Failed to update display name' };
  }

  // Revalidate CMS paths to ensure fresh data
  refresh();
  const revalidation = await invalidatePublicContent({
    entity: 'author',
    operation: 'update',
    id: profileId,
  });

  return { success: true, revalidation };
}

/**
 * Update current user's profile (display name and/or avatar)
 */
type ProfileUpdateResult = MutationResult & {
  avatarUrl?: string;
};

export async function updateMyProfile(
  formData: FormData
): Promise<ProfileUpdateResult> {
  try {
    await requireAuth();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  const admin = getCmsAdminClient();
  const bucket = getCmsStorageBucket();
  const displayName = formData.get('displayName') as string | null;
  const avatarFile = formData.get('avatar') as File | null;

  const updates: { display_name?: string; avatar_url?: string } = {};
  // Captured BEFORE the upload so the old avatar file can be removed after
  // the DB commit (best-effort). Never delete it before the row points away.
  let pendingAvatarCleanup: {
    client: SupabaseClient;
    oldUrl: string | null;
    newPath: string;
  } | null = null;

  // Update display name if provided (same ≤100-char bound as dummy creation).
  if (displayName && displayName.trim().length > 0) {
    if (displayName.trim().length > 100) {
      return {
        success: false,
        error: 'Display name must be 100 characters or less',
      };
    }
    updates.display_name = displayName.trim();
  }

  // Handle avatar upload if provided
  if (avatarFile && avatarFile.size > 0) {
    // Validate the image
    const validation = validateImageFile(avatarFile);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    // Format-aware processing: extension and MIME follow the ACTUAL processed
    // format (WebP passthrough or Sharp fallback, which may produce PNG).
    const prepared = await prepareImageUpload(avatarFile, undefined, {
      maxWidth: 256,
      maxHeight: 256,
      quality: 85,
    });
    if (!prepared.success) {
      return { success: false, error: prepared.error };
    }

    // Get current avatar URL to remove the old file AFTER the DB commit
    const { data: currentProfile } = await admin
      .from('user_profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .single();

    // Unique immutable path: the new avatar never overwrites the previous one,
    // so a failed DB update can never leave the row pointing at a deleted
    // object. The previous DB-referenced avatar is removed after the commit.
    let upload: { publicUrl: string; path: string };
    try {
      upload = await uploadImmutablePreparedImage(
        admin,
        bucket,
        'Website Assets/avatars',
        user.id,
        prepared.image
      );
    } catch (uploadError) {
      console.error('Avatar upload error:', uploadError);
      return { success: false, error: 'Failed to upload avatar' };
    }

    // Add cache-busting param to force refresh
    updates.avatar_url = `${upload.publicUrl}?t=${Date.now()}`;
    pendingAvatarCleanup = {
      client: admin,
      oldUrl: currentProfile?.avatar_url ?? null,
      newPath: upload.path,
    };
  }

  // If nothing to update
  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No changes to save' };
  }

  // Update user_profiles table; require returned-row evidence so a missing
  // profile never reports success with zero rows committed.
  const { data: updatedRow, error: updateError } = await admin
    .from('user_profiles')
    .update(updates)
    .eq('id', user.id)
    .select('id')
    .single();

  if (updateError || !updatedRow) {
    // A failed commit must not orphan a staged avatar upload.
    if (pendingAvatarCleanup) {
      await removeStorageObjectBestEffort(
        pendingAvatarCleanup.client,
        bucket,
        pendingAvatarCleanup.newPath
      );
    }
    console.error('Profile update error:', updateError);
    return { success: false, error: 'Failed to update profile' };
  }

  // DB committed: clean up the old avatar file (best-effort).
  if (pendingAvatarCleanup) {
    await removePublicFileIfDifferent(
      pendingAvatarCleanup.client,
      pendingAvatarCleanup.oldUrl,
      bucket,
      pendingAvatarCleanup.newPath
    );
  }

  // Revalidate CMS paths to ensure fresh data
  refresh();
  const revalidation = await invalidatePublicContent({
    entity: 'author',
    operation: 'update',
    id: user.id,
  });

  return { success: true, avatarUrl: updates.avatar_url, revalidation };
}

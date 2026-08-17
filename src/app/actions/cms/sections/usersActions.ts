'use server';

import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { cmsConfig } from '@/config/cms';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import type {
  MutationResult,
  RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { refresh } from 'next/cache';
import {
  prepareImageUpload,
  requireAuth,
  uploadPreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import {
  findAllowedCmsUser,
  getUserGithubUsername,
} from '@/app/actions/cms/utils/auth';
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

  const allowedUser = await findAllowedCmsUser(
    supabase,
    user.email,
    getUserGithubUsername(user)
  );
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
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function getAllowedUsers(
  supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never
): Promise<UsersResult> {
  const { data, error } = await supabase
    .from('cms_allowed_users')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Get current authenticated user to check their auth metadata for GitHub username
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const authGithubUsername = authUser?.user_metadata?.user_name || null;

  // Fetch all user profiles to match with allowed users (no cache to ensure fresh data)
  const { data: profiles, error: profilesError } = await supabase
    .from('user_profiles')
    .select('id, email, display_name, avatar_url, github_username');

  if (profilesError) {
    console.error('Error fetching profiles:', profilesError);
  }

  // If current user's profile is missing GitHub username but auth metadata has it, update the profile
  if (authUser && authGithubUsername && profiles) {
    const currentUserProfileIndex = profiles.findIndex(
      (p) => p.id === authUser.id
    );
    if (
      currentUserProfileIndex !== -1 &&
      !profiles[currentUserProfileIndex].github_username
    ) {
      try {
        await supabase
          .from('user_profiles')
          .update({ github_username: authGithubUsername })
          .eq('id', authUser.id);
        // Update the profiles array in memory for immediate use
        profiles[currentUserProfileIndex].github_username = authGithubUsername;
      } catch (updateError) {
        console.error(
          'Failed to sync GitHub username to profile:',
          updateError
        );
      }
    }
  }

  // Match profiles with allowed users and sync GitHub usernames
  const usersWithProfiles = await Promise.all(
    (data as AllowedUser[]).map(async (allowedUser) => {
      // Find profile by email, GitHub username, or current user's ID
      const profile = profiles?.find(
        (p) =>
          (allowedUser.email &&
            p.email?.toLowerCase() === allowedUser.email.toLowerCase()) ||
          (allowedUser.github_username &&
            p.github_username === allowedUser.github_username) ||
          (authUser?.id &&
            p.id === authUser.id &&
            allowedUser.email &&
            p.email?.toLowerCase() === allowedUser.email.toLowerCase())
      );

      // For current user, also check auth metadata for GitHub username
      let githubUsername =
        profile?.github_username || allowedUser.github_username;
      if (authUser && profile?.id === authUser.id && authGithubUsername) {
        githubUsername = authGithubUsername;
      }

      // If profile has GitHub username but cms_allowed_users doesn't, update it
      if (githubUsername && !allowedUser.github_username && allowedUser.email) {
        try {
          await supabase
            .from('cms_allowed_users')
            .update({ github_username: githubUsername })
            .eq('id', allowedUser.id);
        } catch (updateError) {
          // Silently fail - this is just a sync operation
          console.error(
            'Failed to sync GitHub username to cms_allowed_users:',
            updateError
          );
        }
      }

      return {
        ...allowedUser,
        github_username: githubUsername, // Update github_username with profile/auth value if available
        profile: profile
          ? {
              id: profile.id,
              display_name: profile.display_name,
              avatar_url: profile.avatar_url,
            }
          : null,
      };
    })
  );

  return { success: true, data: usersWithProfiles };
}

async function addEmailUser(
  supabase: ReturnType<typeof createClient> extends Promise<infer T>
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
  const { data: existing } = await supabase
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
  const { data: newUser, error: insertError } = await supabase
    .from('cms_allowed_users')
    .insert({ email: normalizedEmail, role })
    .select()
    .single();

  if (insertError) throw insertError;

  // Create user and send password reset email using admin client
  try {
    const adminClient = getCmsAdminClient();

    // Create the user with a random password (they'll reset it)
    const tempPassword = crypto.randomUUID();
    const { error: createError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password: tempPassword,
      email_confirm: true, // Auto-confirm the email
    });

    if (createError) {
      console.error('Failed to create user:', createError.message, createError);
      return {
        success: true,
        data: newUser as AllowedUser,
        error: `User added to allowlist but account creation failed: ${createError.message}`,
      };
    }

    // Send password reset email so they can set their own password.
    // Canonical CMS origin; locale-aware recovery destination.
    const siteUrl =
      cmsConfig.cmsPublicUrl || 'http://localhost:3000';
    const { error: emailError } = await adminClient.auth.resetPasswordForEmail(
      normalizedEmail,
      {
        redirectTo: `${siteUrl}/`,
      }
    );

    if (emailError) {
      console.error('Failed to send reset email:', emailError.message);
    } else {
      console.log('User created and reset email sent to:', normalizedEmail);
      // Update invited_at timestamp
      await supabase
        .from('cms_allowed_users')
        .update({ invited_at: new Date().toISOString() })
        .eq('id', newUser.id);
    }
  } catch (inviteErr) {
    console.error('Invite error:', inviteErr);
    return {
      success: true,
      data: newUser as AllowedUser,
      error: `User added to allowlist but invite failed.`,
    };
  }

  return { success: true, data: newUser as AllowedUser };
}

async function addGitHubUser(
  supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  github_username: string,
  role: 'admin' | 'editor' = 'editor'
): Promise<UsersResult> {
  // Validate GitHub username
  const cleanUsername = github_username.trim().replace(/^@/, '');

  if (!cleanUsername || !GITHUB_USERNAME_REGEX.test(cleanUsername)) {
    return { success: false, error: 'Please enter a valid GitHub username' };
  }

  // Check if already exists
  const { data: existing } = await supabase
    .from('cms_allowed_users')
    .select('id')
    .eq('github_username', cleanUsername)
    .single();

  if (existing) {
    return {
      success: false,
      error: 'This GitHub username is already in the allowed list',
    };
  }

  // Add to allowlist (no invite needed - they'll use GitHub OAuth)
  const { data: newUser, error: insertError } = await supabase
    .from('cms_allowed_users')
    .insert({ github_username: cleanUsername, role })
    .select()
    .single();

  if (insertError) throw insertError;

  return { success: true, data: newUser as AllowedUser };
}

async function addDummyUser(
  supabase: ReturnType<typeof createClient> extends Promise<infer T>
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
  const { data: existingAllowed } = await supabase
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
  const { data: newUser, error: insertError } = await supabase
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
  supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  id: number,
  role: 'admin' | 'editor'
): Promise<UsersResult> {
  // Prevent removing the last admin
  if (role === 'editor') {
    const { data: admins } = await supabase
      .from('cms_allowed_users')
      .select('id')
      .eq('role', 'admin');

    if (admins && admins.length === 1 && admins[0].id === id) {
      return { success: false, error: 'Cannot demote the last admin' };
    }
  }

  const { data, error } = await supabase
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
  supabase: ReturnType<typeof createClient> extends Promise<infer T>
    ? T
    : never,
  id: number
): Promise<UsersResult> {
  // Prevent removing the last admin
  const { data: user } = await supabase
    .from('cms_allowed_users')
    .select('role, email, github_username')
    .eq('id', id)
    .single();

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  if (user.role === 'admin') {
    const { data: admins } = await supabase
      .from('cms_allowed_users')
      .select('id')
      .eq('role', 'admin');

    if (admins && admins.length === 1) {
      return { success: false, error: 'Cannot remove the last admin' };
    }
  }

  // Find and delete user profile
  const adminClient = getCmsAdminClient();
  let profileId: string | null = null;

  // Check if this is a dummy user (email format: dummy-{uuid}@dummy.local)
  const isDummyUser =
    user.email?.startsWith('dummy-') && user.email?.endsWith('@dummy.local');

  // Try to find profile by email (works for both dummy and regular users)
  if (user.email) {
    const { data: profileByEmail } = await adminClient
      .from('user_profiles')
      .select('id')
      .eq('email', user.email.toLowerCase())
      .single();
    if (profileByEmail) profileId = profileByEmail.id;
  }

  // Try to find profile by GitHub username if not found by email
  if (!profileId && user.github_username) {
    const { data: profileByGithub } = await adminClient
      .from('user_profiles')
      .select('id')
      .eq('github_username', user.github_username)
      .single();
    if (profileByGithub) profileId = profileByGithub.id;
  }

  // Delete from cms_allowed_users
  const { error } = await supabase
    .from('cms_allowed_users')
    .delete()
    .eq('id', id);

  if (error) throw error;

  // Delete from user_profiles if found (using admin client to bypass RLS)
  if (profileId) {
    const { error: deleteProfileError } = await adminClient
      .from('user_profiles')
      .delete()
      .eq('id', profileId);

    if (deleteProfileError) {
      console.error('Error deleting user profile:', deleteProfileError);
      // Don't throw - profile deletion is not critical if it fails
    }

    // For dummy users, also delete the auth user
    if (isDummyUser) {
      try {
        await adminClient.auth.admin.deleteUser(profileId);
      } catch (deleteAuthError) {
        console.error('Error deleting dummy auth user:', deleteAuthError);
        // Don't throw - auth user deletion is not critical if it fails
      }
    }
  }

  let revalidation: RevalidationStatus | undefined;
  if (profileId) {
    revalidation = await invalidatePublicContent({
      entity: 'author',
      operation: 'update',
      id: profileId,
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
    updates.display_name = displayName.trim();
  }

  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No changes to save' };
  }

  const { error } = await getCmsAdminClient()
    .from('user_profiles')
    .update(updates)
    .eq('id', profileId);

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

  // Get current avatar URL to delete old file
  const { data: currentProfile } = await adminClient
    .from('user_profiles')
    .select('avatar_url')
    .eq('id', profileId)
    .single();

  // Delete old avatar file if it exists
  if (currentProfile?.avatar_url) {
    try {
      // Extract file path from URL (remove query params and get path after bucket name)
      const url = new URL(currentProfile.avatar_url.split('?')[0]); // Remove query params
      const pathParts = url.pathname.split('/');
      const bucketIndex = pathParts.indexOf('website');
      if (bucketIndex !== -1) {
        const filePath = pathParts.slice(bucketIndex + 1).join('/');
        if (filePath) {
          await adminClient.storage.from('website').remove([filePath]);
        }
      }
    } catch (deleteError) {
      // Log but don't fail - old file might not exist or URL format might be different
      console.warn('Failed to delete old avatar file:', deleteError);
    }
  }

  // Upload via the shared prepared-image pipeline
  let upload: { publicUrl: string; path: string };
  try {
    upload = await uploadPreparedImage(
      adminClient,
      'website',
      `Website Assets/avatars/${profileId}-avatar`,
      prepared.image
    );
  } catch (uploadError) {
    console.error('Avatar upload error:', uploadError);
    return { success: false, error: 'Failed to upload avatar' };
  }

  // Add cache-busting param
  const avatarUrl = `${upload.publicUrl}?t=${Date.now()}`;
  const { error: updateError } = await adminClient
    .from('user_profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', profileId);

  if (updateError) {
    console.error('Profile update error:', updateError);
    return { success: false, error: 'Failed to update profile' };
  }

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

  // Use admin client to bypass RLS when updating other users' profiles
  const adminClient = getCmsAdminClient();

  // Update user_profiles table using admin client
  const { error: updateError } = await adminClient
    .from('user_profiles')
    .update({ display_name: displayName.trim() })
    .eq('id', profileId);

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

  const displayName = formData.get('displayName') as string | null;
  const avatarFile = formData.get('avatar') as File | null;

  const updates: { display_name?: string; avatar_url?: string } = {};

  // Update display name if provided
  if (displayName && displayName.trim().length > 0) {
    updates.display_name = displayName.trim();
  }

  // Handle avatar upload if provided
  if (avatarFile && avatarFile.size > 0) {
    // Validate the image
    const validation = validateImageFile(avatarFile);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const adminClient = getCmsAdminClient();

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

    // Get current avatar URL to delete old file
    const { data: currentProfile } = await supabase
      .from('user_profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .single();

    // Delete old avatar file if it exists
    if (currentProfile?.avatar_url) {
      try {
        // Extract file path from URL (remove query params and get path after bucket name)
        const url = new URL(currentProfile.avatar_url.split('?')[0]); // Remove query params
        const pathParts = url.pathname.split('/');
        const bucketIndex = pathParts.indexOf('website');
        if (bucketIndex !== -1) {
          const filePath = pathParts.slice(bucketIndex + 1).join('/');
          if (filePath) {
            await adminClient.storage.from('website').remove([filePath]);
          }
        }
      } catch (deleteError) {
        // Log but don't fail - old file might not exist or URL format might be different
        console.warn('Failed to delete old avatar file:', deleteError);
      }
    }

    // Upload via the shared prepared-image pipeline
    let upload: { publicUrl: string; path: string };
    try {
      upload = await uploadPreparedImage(
        adminClient,
        'website',
        `Website Assets/avatars/${user.id}-avatar`,
        prepared.image
      );
    } catch (uploadError) {
      console.error('Avatar upload error:', uploadError);
      return { success: false, error: 'Failed to upload avatar' };
    }

    // Add cache-busting param to force refresh
    updates.avatar_url = `${upload.publicUrl}?t=${Date.now()}`;
  }

  // If nothing to update
  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No changes to save' };
  }

  // Update user_profiles table
  const { error: updateError } = await supabase
    .from('user_profiles')
    .update(updates)
    .eq('id', user.id);

  if (updateError) {
    console.error('Profile update error:', updateError);
    return { success: false, error: 'Failed to update profile' };
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

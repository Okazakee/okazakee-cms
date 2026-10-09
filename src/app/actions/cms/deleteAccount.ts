'use server';

import { redirect } from 'next/navigation';
import {
  getUserGithubId,
  getUserGithubUsername,
  getVerifiedUserEmail,
} from './utils/auth';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { createClient } from '@/utils/supabase/server';

/**
 * Deletes the current user's CMS account (allowlist row + profile), clears
 * the session and performs a framework-owned redirect to canonical
 * /{locale}/login. The client never navigates on the success path — the same
 * single-owner navigation architecture as the GitHub OAuth callback.
 *
 * The redirect() call is OUTSIDE the try/catch: it throws NEXT_REDIRECT and
 * must escape as control flow, never be converted into a typed error.
 * Failure paths return typed { success: false, error } results.
 */
export async function deleteMyAccount() {
  const supabase = await createClient();

  // Get current authenticated user
  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !authUser) {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  // Get admin client for operations that might bypass RLS
  const adminClient = getCmsAdminClient();

  try {
    // Immutable identity first, then verified-email, then legacy display
    // handle. No user_metadata trust: the username is identity-derived.
    const githubUserId = getUserGithubId(authUser);
    const verifiedEmail = getVerifiedUserEmail(authUser);
    const githubUsernameLegacy = getUserGithubUsername(authUser);

    let allowedUser: { id: number; role: string } | null = null;

    // Allowlist queries go through the admin client (service_role):
    // anon/authenticated have no access to cms_allowed_users.
    const allowlistClient = adminClient;

    // Immutable GitHub ID first
    if (!allowedUser && githubUserId) {
      const { data: idMatch } = await allowlistClient
        .from('cms_allowed_users')
        .select('id, role')
        .eq('github_user_id', githubUserId)
        .single();
      if (idMatch) allowedUser = idMatch;
    }

    // Verified email second (returns immediately under current behavior)
    if (!allowedUser && verifiedEmail) {
      const { data: emailMatch } = await allowlistClient
        .from('cms_allowed_users')
        .select('id, role')
        .eq('email', verifiedEmail.toLowerCase())
        .single();
      if (emailMatch) allowedUser = emailMatch;
    }

    // Legacy display handle last (dual-allowed transition only)
    if (!allowedUser && githubUsernameLegacy) {
      const { data: githubMatch } = await allowlistClient
        .from('cms_allowed_users')
        .select('id, role')
        .eq('github_username', githubUsernameLegacy)
        .single();
      if (githubMatch) allowedUser = githubMatch;
    }

    if (!allowedUser) {
      return { success: false, error: 'User not found in allowed users' };
    }

    // Prevent deleting the last admin
    if (allowedUser.role === 'admin') {
      const { data: admins } = await allowlistClient
        .from('cms_allowed_users')
        .select('id')
        .eq('role', 'admin');

      if (admins && admins.length === 1 && admins[0].id === allowedUser.id) {
        return {
          success: false,
          error: 'Cannot delete the last admin account',
        };
      }
    }

    // Delete from cms_allowed_users
    const { error: deleteAllowedError } = await allowlistClient
      .from('cms_allowed_users')
      .delete()
      .eq('id', allowedUser.id);

    if (deleteAllowedError) {
      console.error(
        'Error deleting from cms_allowed_users:',
        deleteAllowedError
      );
      throw deleteAllowedError;
    }

    // Delete from user_profiles (using admin client to bypass RLS if needed)
    const { error: deleteProfileError } = await adminClient
      .from('user_profiles')
      .delete()
      .eq('id', authUser.id);

    if (deleteProfileError) {
      console.error('Error deleting from user_profiles:', deleteProfileError);
      // Don't throw - profile deletion is not critical if it fails
    }

    // Public-site revalidation (author tag) for the deleted author identity.
    await invalidatePublicContent({
      entity: 'author',
      operation: 'update',
      id: authUser.id,
    });

    // Sign out the user
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      console.error('Error signing out:', signOutError);
      // Continue even if sign out fails
    }
  } catch (error) {
    console.error('Error deleting account:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to delete account',
    };
  }

  // Success: framework-owned navigation. OUTSIDE the try/catch — redirect()
  // throws NEXT_REDIRECT and must escape as control flow, never be swallowed
  // by the error handler above.
  redirect('/login');
}

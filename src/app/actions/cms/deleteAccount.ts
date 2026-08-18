'use server';

import { redirect } from 'next/navigation';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { defaultLocale, isValidLocale } from '@/i18n/routing';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { createClient } from '@/utils/supabase/server';

/**
 * Deletes the current user's CMS account (allowlist row + profile), clears
 * the session and performs a framework-owned redirect to canonical
 * /{locale}/login. The client never navigates on the success path — the same
 * single-owner navigation architecture as password login.
 *
 * The redirect() call is OUTSIDE the try/catch: it throws NEXT_REDIRECT and
 * must escape as control flow, never be converted into a typed error.
 * Failure paths return typed { success: false, error } results.
 */
export async function deleteMyAccount(locale: string) {
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
    // Find the user in cms_allowed_users by email or GitHub username
    const email = authUser.email?.toLowerCase();
    const githubUsername = authUser.user_metadata?.user_name;

    let allowedUser: { id: number; role: string } | null = null;

    // Try by email first
    if (email) {
      const { data: emailMatch } = await supabase
        .from('cms_allowed_users')
        .select('id, role')
        .eq('email', email)
        .single();
      if (emailMatch) allowedUser = emailMatch;
    }

    // Try by GitHub username if no email match
    if (!allowedUser && githubUsername) {
      const { data: githubMatch } = await supabase
        .from('cms_allowed_users')
        .select('id, role')
        .eq('github_username', githubUsername)
        .single();
      if (githubMatch) allowedUser = githubMatch;
    }

    if (!allowedUser) {
      return { success: false, error: 'User not found in allowed users' };
    }

    // Prevent deleting the last admin
    if (allowedUser.role === 'admin') {
      const { data: admins } = await supabase
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
    const { error: deleteAllowedError } = await supabase
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
  const safeLocale = isValidLocale(locale) ? locale : defaultLocale;
  redirect(`/${safeLocale}/login`);
}

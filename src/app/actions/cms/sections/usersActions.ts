'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { refresh } from 'next/cache';
import {
  getCmsActionContext,
  prepareImageUpload,
  removePrefixBestEffort,
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
import {
  type CmsInvitationStatus,
  sendCmsInvitation,
} from '@/libs/cms/onboarding/invite';
import { getCmsStorageBucket } from '@/libs/cms/storage/bucket';
import { avatarPrefixForProfile } from '@/libs/cms/storage/paths';
import { getCmsAdminClient } from '@/libs/cms/supabase/admin';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import {
  canAssignCmsRole,
  canManageCmsRole,
  type CmsRole,
  isCmsRole,
} from '@/utils/cms/roles';
import { createClient } from '@/utils/supabase/server';

/**
 * User-management operations. `role`/`id` are `unknown` on purpose: a server
 * action receives whatever the caller sent, so every value is validated at
 * runtime (a TypeScript literal type is not a security boundary).
 */
type UserOperation =
  | { type: 'GET' }
  | { type: 'ADD_EMAIL'; email: string; role?: unknown }
  | { type: 'ADD_GITHUB'; github_username: string; role?: unknown }
  | { type: 'ADD_DUMMY'; display_name: string; role?: unknown }
  | { type: 'UPDATE_ROLE'; id: unknown; role: unknown }
  | { type: 'REMOVE'; id: unknown }
  | { type: 'UPDATE_PROFILE'; profileId: string; displayName?: string }
  | { type: 'RESEND_INVITE'; id: unknown };

/** Roles a caller may assign. Superadmin is SQL-bootstrap only. */
type AssignableRole = 'admin' | 'editor';

type AllowedUser = {
  id: number;
  email: string | null;
  github_user_id: string | null;
  github_username: string | null;
  role: CmsRole;
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
  /** Outcome of the invitation email, when this operation attempted one. */
  invitation?: CmsInvitationStatus;
  /** Fixed, user-safe reason when invitation is not 'sent'. */
  invitationError?: string;
};

/**
 * Explicit allowlist columns: never `select('*')` (a future column must not
 * leak to the user directory).
 */
const ALLOWLIST_COLUMNS =
  'id, email, github_user_id, github_username, role, invited_at, created_at';

const PROFILE_COLUMNS =
  'id, email, github_user_id, github_username, avatar_url';

type ProfileRecord = {
  id: string;
  email: string | null;
  github_user_id: string | null;
  github_username: string | null;
  avatar_url: string | null;
};

/** Display row from user_profiles joined into the allowlist directory. */
type DirectoryProfile = ProfileRecord & {
  display_name: string | null;
};

/** Identity of the acting session, derived once per action. */
type CmsActor = {
  role: CmsRole;
  userId: string;
  email: string | null;
  githubUserId: string | null;
  githubUsername: string | null;
};

type ManagedTarget = { target: AllowedUser };

// Email validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GitHub username validation (alphanumeric and hyphens, 1-39 chars)
const GITHUB_USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * Narrow an untyped allowlist row into the directory shape. An unknown or
 * malformed role returns null: such a row can never be listed or managed.
 */
function toAllowedUser(row: unknown): AllowedUser | null {
  if (!row || typeof row !== 'object') return null;
  // Supabase rows are untyped JSON; narrow once, then read checked fields.
  const record = row as Record<string, unknown>;
  const { id, role, invited_at, created_at } = record;
  if (typeof id !== 'number' || !isCmsRole(role)) return null;
  return {
    id,
    email: typeof record.email === 'string' ? record.email : null,
    github_user_id:
      typeof record.github_user_id === 'string' ? record.github_user_id : null,
    github_username:
      typeof record.github_username === 'string'
        ? record.github_username
        : null,
    role,
    invited_at: typeof invited_at === 'string' ? invited_at : null,
    created_at: typeof created_at === 'string' ? created_at : '',
  };
}

function toProfileRecord(row: unknown): ProfileRecord | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  return {
    id: record.id,
    email: typeof record.email === 'string' ? record.email : null,
    github_user_id:
      typeof record.github_user_id === 'string' ? record.github_user_id : null,
    github_username:
      typeof record.github_username === 'string'
        ? record.github_username
        : null,
    avatar_url:
      typeof record.avatar_url === 'string' ? record.avatar_url : null,
  };
}

function parseAllowlistId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isDummyEmail(email: string | null): boolean {
  return (
    !!email && email.startsWith('dummy-') && email.endsWith('@dummy.local')
  );
}

/**
 * Is `target` the only usable privileged row (admin or superadmin)? A
 * superadmin holds admin-level access and can always restore the directory,
 * so it is usable coverage: counting only `admin` would make a sole
 * (potentially compromised) admin irrevocable while an owner exists. A dummy
 * identity cannot sign in and is editor-only by policy, so it never counts
 * (the directory excludes the same rows from its admin count); counting a
 * pre-existing dummy admin would mask the real operator.
 */
async function isLastUsableAdmin(target: AllowedUser): Promise<boolean> {
  // Demoting/removing an unusable dummy admin never reduces real coverage.
  if (isDummyEmail(target.email)) return false;

  const { data, error } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select('id, email')
    .in('role', ['admin', 'superadmin']);
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const usablePrivileged = rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const record = row as Record<string, unknown>;
    return !isDummyEmail(
      typeof record.email === 'string' ? record.email : null
    );
  });

  return usablePrivileged.length <= 1;
}

/**
 * Runtime role validation for writes: only editor/admin are assignable, an
 * admin may assign only editor, and superadmin is never assignable. An
 * unexpected value fails closed instead of reaching the database.
 */
function resolveAssignableRole(
  actorRole: CmsRole,
  requested: unknown
): { role: AssignableRole } | { error: string } {
  if (requested === undefined || requested === null) {
    return { error: 'Please choose a role' };
  }
  if (!isCmsRole(requested)) {
    return { error: 'Invalid role' };
  }
  if (requested === 'superadmin') {
    return { error: 'The superadmin role cannot be assigned from the CMS' };
  }
  if (!canAssignCmsRole(actorRole, requested)) {
    return { error: 'Only a superadmin can assign the admin role' };
  }
  return { role: requested };
}

/**
 * The one actor context for user management: authentication + allowlist +
 * admin-level role, resolved by the canonical gate (no second isAdmin copy).
 */
async function getManagementActor(): Promise<CmsActor> {
  const context = await getCmsActionContext('admin');
  const role = context.role;
  if (!isCmsRole(role)) {
    throw new Error('Unauthorized: Admin access required');
  }
  return {
    role,
    userId: context.user.id,
    email: context.user.email || null,
    githubUserId: context.user.githubUserId,
    githubUsername: context.user.githubUsername,
  };
}

async function loadAllowlistTarget(id: number): Promise<AllowedUser | null> {
  const { data, error } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select(ALLOWLIST_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return toAllowedUser(data);
}

/**
 * Resolve the allowlist target and enforce the management hierarchy:
 * superadmin manages admin/editor, admin manages editor, nobody manages a
 * superadmin.
 */
async function loadManagedTarget(
  actor: CmsActor,
  rawId: unknown
): Promise<ManagedTarget | { error: string }> {
  const id = parseAllowlistId(rawId);
  if (id === null) return { error: 'Invalid user id' };

  const target = await loadAllowlistTarget(id);
  if (!target) return { error: 'User not found' };

  if (!canManageCmsRole(actor.role, target.role)) {
    return {
      error:
        target.role === 'superadmin'
          ? 'The superadmin account can only be changed by a direct database bootstrap'
          : 'Only a superadmin can manage this admin account',
    };
  }

  return { target };
}

/**
 * Bind a profile to its allowlist row by immutable identity (GitHub ID),
 * then verified-email, then the legacy handle only when neither side carries
 * an immutable ID. A profile without an allowlist binding is never mutable
 * through the user-management routes.
 */
async function loadAllowlistTargetForProfile(
  profile: ProfileRecord
): Promise<AllowedUser | null> {
  const adminClient = getCmsAdminClient();

  if (profile.github_user_id) {
    const { data, error } = await adminClient
      .from('cms_allowed_users')
      .select(ALLOWLIST_COLUMNS)
      .eq('github_user_id', profile.github_user_id)
      .maybeSingle();
    if (error) throw error;
    const target = toAllowedUser(data);
    if (target) return target;
  }

  if (profile.email) {
    const { data, error } = await adminClient
      .from('cms_allowed_users')
      .select(ALLOWLIST_COLUMNS)
      .eq('email', profile.email.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    const target = toAllowedUser(data);
    // Same email but a conflicting immutable subject is not this profile.
    if (
      target &&
      (!target.github_user_id ||
        !profile.github_user_id ||
        target.github_user_id === profile.github_user_id)
    ) {
      return target;
    }
  }

  if (!profile.github_user_id && profile.github_username) {
    const { data, error } = await adminClient
      .from('cms_allowed_users')
      .select(ALLOWLIST_COLUMNS)
      .eq('github_username', profile.github_username)
      .maybeSingle();
    if (error) throw error;
    const target = toAllowedUser(data);
    if (target && !target.github_user_id) return target;
  }

  return null;
}

/**
 * The protected profile routes never edit the caller: self-service name and
 * avatar changes go through updateMyProfile only.
 */
async function loadManagedProfile(
  actor: CmsActor,
  rawProfileId: unknown
): Promise<
  { target: AllowedUser; profile: ProfileRecord } | { error: string }
> {
  if (typeof rawProfileId !== 'string' || rawProfileId.length === 0) {
    return { error: 'Profile ID is required' };
  }

  const { data, error } = await getCmsAdminClient()
    .from('user_profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', rawProfileId)
    .maybeSingle();
  if (error) throw error;

  const profile = toProfileRecord(data);
  if (!profile) return { error: 'Profile not found' };

  if (profile.id === actor.userId) {
    return { error: 'Update your own profile from your account settings' };
  }

  const target = await loadAllowlistTargetForProfile(profile);
  if (!target) {
    return { error: 'This profile is not linked to the CMS allowlist' };
  }

  if (!canManageCmsRole(actor.role, target.role)) {
    return {
      error:
        target.role === 'superadmin'
          ? 'The superadmin profile cannot be changed from the CMS'
          : 'Only a superadmin can manage this admin profile',
    };
  }

  return { target, profile };
}

/** Is this allowlist row the caller's own row? */
function isSelfTarget(actor: CmsActor, target: AllowedUser): boolean {
  if (
    target.github_user_id &&
    actor.githubUserId &&
    target.github_user_id === actor.githubUserId
  ) {
    return true;
  }
  if (
    target.email &&
    actor.email &&
    target.email.toLowerCase() === actor.email.toLowerCase()
  ) {
    return true;
  }
  return !!(
    target.github_username &&
    actor.githubUsername &&
    target.github_username.toLowerCase() === actor.githubUsername.toLowerCase()
  );
}

export async function usersActions(
  operation: UserOperation
): Promise<UsersResult> {
  // One canonical actor context for every operation (authentication +
  // allowlist + admin-level role). No local isAdmin duplicate.
  let actor: CmsActor;
  try {
    actor = await getManagementActor();
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, 'Unauthorized: Admin access required'),
    };
  }

  try {
    switch (operation.type) {
      case 'GET':
        return await getAllowedUsers(actor);

      case 'ADD_EMAIL':
        return await addEmailUser(actor, operation.email, operation.role);

      case 'ADD_GITHUB':
        return await addGitHubUser(
          actor,
          operation.github_username,
          operation.role
        );

      case 'ADD_DUMMY':
        return await addDummyUser(
          actor,
          operation.display_name,
          operation.role
        );

      case 'UPDATE_ROLE':
        return await updateUserRole(actor, operation.id, operation.role);

      case 'REMOVE':
        return await removeUser(actor, operation.id);

      case 'UPDATE_PROFILE':
        return await updateUserProfile(
          actor,
          operation.profileId,
          operation.displayName
        );

      case 'RESEND_INVITE':
        return await resendInvite(actor, operation.id);

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

async function getAllowedUsers(actor: CmsActor): Promise<UsersResult> {
  // Allowlist is internal: read via admin client (service_role), explicit
  // columns only.
  const { data, error } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .select(ALLOWLIST_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const allowedUsers = rows.map((row) => {
    const allowed = toAllowedUser(row);
    if (!allowed) throw new Error('Unexpected CMS role in the allowlist');
    return allowed;
  });

  // Display-only handle from the verified identity; never user_metadata.
  // Profiles match by email or immutable ID — the allowlist row is never
  // mutated here (no editable-username back-write).
  const adminClient = getCmsAdminClient();
  const { data: profileData, error: profilesError } = await adminClient
    .from('user_profiles')
    .select(
      'id, email, display_name, avatar_url, github_username, github_user_id'
    );

  if (profilesError) {
    console.error('Error fetching profiles:', profilesError);
  }

  const profiles = (Array.isArray(profileData) ? profileData : [])
    .map((row): DirectoryProfile | null => {
      if (!row || typeof row !== 'object') return null;
      const record = row as Record<string, unknown>;
      if (typeof record.id !== 'string' || record.id.length === 0) return null;
      return {
        id: record.id,
        email: typeof record.email === 'string' ? record.email : null,
        display_name:
          typeof record.display_name === 'string' ? record.display_name : null,
        avatar_url:
          typeof record.avatar_url === 'string' ? record.avatar_url : null,
        github_username:
          typeof record.github_username === 'string'
            ? record.github_username
            : null,
        github_user_id:
          typeof record.github_user_id === 'string'
            ? record.github_user_id
            : null,
      };
    })
    .filter((profile): profile is DirectoryProfile => profile !== null);

  // Match profiles with allowed users. Display handle prefers the verified
  // identity for the current session, then the stored profile, then the
  // allowlist row. No writes: backfill flows own identity persistence.
  const usersWithProfiles = allowedUsers.map((allowedUser) => {
    const profile = profiles.find(
      (p) =>
        (allowedUser.email &&
          p.email?.toLowerCase() === allowedUser.email.toLowerCase()) ||
        (allowedUser.github_user_id &&
          p.github_user_id === allowedUser.github_user_id) ||
        (allowedUser.github_username &&
          p.github_username === allowedUser.github_username)
    );

    let githubUsername =
      profile?.github_username || allowedUser.github_username;
    if (
      profile?.id === actor.userId &&
      actor.githubUsername &&
      (!actor.githubUserId ||
        !allowedUser.github_user_id ||
        profile?.github_user_id === allowedUser.github_user_id)
    ) {
      githubUsername = actor.githubUsername;
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
  actor: CmsActor,
  email: string,
  role: unknown = 'editor'
): Promise<UsersResult> {
  const assigned = resolveAssignableRole(actor.role, role);
  if ('error' in assigned) {
    return { success: false, error: assigned.error };
  }

  // Validate email
  if (!email || !EMAIL_REGEX.test(email) || email.trim().length > 254) {
    return { success: false, error: 'Please enter a valid email address' };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Dummy identities (reserved local domain) cannot sign in and stay
  // editor-only, exactly as ADD_DUMMY enforces. The marker is derived from
  // the submitted address, never trusted from the client.
  if (assigned.role !== 'editor' && isDummyEmail(normalizedEmail)) {
    return {
      success: false,
      error: 'Dummy users can only have the editor role',
    };
  }

  const adminClient = getCmsAdminClient();

  // Check if already exists
  const { data: existing, error: existingError } = await adminClient
    .from('cms_allowed_users')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing) {
    return {
      success: false,
      error: 'This email is already in the allowed list',
    };
  }

  // Add to allowlist
  const { data: newUser, error: insertError } = await adminClient
    .from('cms_allowed_users')
    .insert({ email: normalizedEmail, role: assigned.role })
    .select(ALLOWLIST_COLUMNS)
    .single();

  if (insertError) throw insertError;

  const committed = toAllowedUser(newUser);
  if (!committed) throw new Error('Allowlist insert returned no row');

  // The allowlist row is committed: that is the success condition. The
  // invitation is attempted only afterwards and its outcome is reported
  // truthfully — a failed/known-account mail never turns the commit into a
  // fake success, and `invited_at` is written only when mail was sent.
  const invitation = await sendCmsInvitation(normalizedEmail);
  let data = committed;

  if (invitation.status === 'sent') {
    const invitedAt = invitation.invitedAt ?? new Date().toISOString();
    const { data: stampedRow, error: stampError } = await adminClient
      .from('cms_allowed_users')
      .update({ invited_at: invitedAt })
      .eq('id', committed.id)
      .eq('email', normalizedEmail)
      .select(ALLOWLIST_COLUMNS)
      .maybeSingle();

    if (stampError) {
      // Nonfatal: the row and the email are already committed.
      console.error('Failed to persist invited_at:', stampError);
    } else {
      const stamped = toAllowedUser(stampedRow);
      if (stamped) data = stamped;
    }
  }

  refresh();

  return {
    success: true,
    data,
    invitation: invitation.status,
    invitationError: invitation.error,
  };
}

async function resendInvite(
  actor: CmsActor,
  rawId: unknown
): Promise<UsersResult> {
  const guarded = await loadManagedTarget(actor, rawId);
  if ('error' in guarded) {
    return { success: false, error: guarded.error };
  }

  const { target } = guarded;
  if (!target.email || isDummyEmail(target.email)) {
    return {
      success: false,
      error: 'This user has no email address to invite',
    };
  }

  const invitation = await sendCmsInvitation(target.email);
  let data = target;

  if (invitation.status === 'sent') {
    const invitedAt = invitation.invitedAt ?? new Date().toISOString();
    const { data: stampedRow, error: stampError } = await getCmsAdminClient()
      .from('cms_allowed_users')
      .update({ invited_at: invitedAt })
      .eq('id', target.id)
      .eq('email', target.email)
      .select(ALLOWLIST_COLUMNS)
      .maybeSingle();

    if (stampError) {
      console.error('Failed to persist invited_at:', stampError);
    } else {
      const stamped = toAllowedUser(stampedRow);
      if (stamped) data = stamped;
    }
  }

  refresh();

  return {
    success: true,
    data,
    invitation: invitation.status,
    invitationError: invitation.error,
  };
}

async function addGitHubUser(
  actor: CmsActor,
  github_username: string,
  role: unknown = 'editor'
): Promise<UsersResult> {
  const assigned = resolveAssignableRole(actor.role, role);
  if ('error' in assigned) {
    return { success: false, error: assigned.error };
  }

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

  const adminClient = getCmsAdminClient();

  // Dedupe on the immutable ID (handles can be renamed/transferred).
  const { data: existing, error: existingError } = await adminClient
    .from('cms_allowed_users')
    .select('id')
    .eq('github_user_id', githubUserId)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing) {
    return {
      success: false,
      error: 'This GitHub user is already in the allowed list',
    };
  }

  // Add to allowlist (no invite needed - they'll use GitHub OAuth).
  // Both columns persist: ID authorizes, handle only renders.
  const { data: newUser, error: insertError } = await adminClient
    .from('cms_allowed_users')
    .insert({
      github_user_id: githubUserId,
      github_username: cleanUsername,
      role: assigned.role,
    })
    .select(ALLOWLIST_COLUMNS)
    .single();

  if (insertError) throw insertError;

  const committed = toAllowedUser(newUser);
  if (!committed) throw new Error('Allowlist insert returned no row');

  refresh();

  return { success: true, data: committed };
}

async function addDummyUser(
  actor: CmsActor,
  displayName: string,
  role: unknown = 'editor'
): Promise<UsersResult> {
  const assigned = resolveAssignableRole(actor.role, role);
  if ('error' in assigned) {
    return { success: false, error: assigned.error };
  }

  // A dummy identity can never sign in, so it must never carry privileges
  // the real operators cannot see in use: editor only.
  if (assigned.role !== 'editor') {
    return {
      success: false,
      error: 'Dummy users can only have the editor role',
    };
  }

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
  const { data: existingAllowed, error: existingAllowedError } =
    await adminClient
      .from('cms_allowed_users')
      .select('id')
      .eq('email', dummyEmail)
      .maybeSingle();

  if (existingAllowedError) throw existingAllowedError;

  if (existingAllowed) {
    return {
      success: false,
      error: 'A dummy user already exists. Please try again.',
    };
  }

  // Check if profile with this email already exists (from a previous failed attempt)
  // If profile exists, we can reuse the auth user ID
  let authUserId: string | null = null;
  const { data: existingProfileByEmail, error: existingProfileError } =
    await adminClient
      .from('user_profiles')
      .select('id')
      .eq('email', dummyEmail)
      .maybeSingle();

  if (existingProfileError) throw existingProfileError;

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
    .insert({ email: dummyEmail, role: assigned.role })
    .select(ALLOWLIST_COLUMNS)
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

  const committed = toAllowedUser(newUser);
  if (!committed) throw new Error('Allowlist insert returned no row');

  // Revalidate CMS paths to ensure fresh data
  refresh();

  return { success: true, data: committed };
}

async function updateUserRole(
  actor: CmsActor,
  rawId: unknown,
  rawRole: unknown
): Promise<UsersResult> {
  const assigned = resolveAssignableRole(actor.role, rawRole);
  if ('error' in assigned) {
    return { success: false, error: assigned.error };
  }

  const guarded = await loadManagedTarget(actor, rawId);
  if ('error' in guarded) {
    return { success: false, error: guarded.error };
  }

  const { target } = guarded;

  // A dummy identity is editor-only (the same rule ADD_DUMMY enforces): it
  // can never be promoted to admin. The marker comes from the stored
  // allowlist row, never from the client payload.
  if (assigned.role !== 'editor' && isDummyEmail(target.email)) {
    return {
      success: false,
      error: 'Dummy users can only have the editor role',
    };
  }

  if (target.role === assigned.role) {
    return { success: true, data: target };
  }

  // Soft UX guard preserved (recoverable via superadmin): never demote the
  // last usable admin. Dummy admins never count, so a pre-existing one cannot
  // inflate the guard. The write below is still conditional on the role read.
  if (
    assigned.role === 'editor' &&
    target.role === 'admin' &&
    (await isLastUsableAdmin(target))
  ) {
    return { success: false, error: 'Cannot demote the last admin' };
  }

  // Condition the write on the role we evaluated: a concurrent promotion to
  // superadmin (or peer change) must not be overwritten by a stale decision.
  const { data: updated, error } = await getCmsAdminClient()
    .from('cms_allowed_users')
    .update({ role: assigned.role })
    .eq('id', target.id)
    .eq('role', target.role)
    .select(ALLOWLIST_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  const committed = toAllowedUser(updated);
  if (!committed) {
    return {
      success: false,
      error: 'The user role changed concurrently. Refresh and try again.',
    };
  }

  // Revalidate CMS paths to ensure fresh data
  refresh();

  return { success: true, data: committed };
}

async function removeUser(
  actor: CmsActor,
  rawId: unknown
): Promise<UsersResult> {
  const guarded = await loadManagedTarget(actor, rawId);
  if ('error' in guarded) {
    return { success: false, error: guarded.error };
  }

  const { target } = guarded;

  if (isSelfTarget(actor, target)) {
    return { success: false, error: 'You cannot remove your own account' };
  }

  const adminClient = getCmsAdminClient();
  const bucket = getCmsStorageBucket();

  // Prevent removing the last usable admin. Dummy admins never count, so a
  // pre-existing one cannot inflate the guard; a dummy admin itself is always
  // removable because it never provided real coverage.
  if (target.role === 'admin' && (await isLastUsableAdmin(target))) {
    return { success: false, error: 'Cannot remove the last admin' };
  }

  // Revoke access FIRST: the conditional delete is the authoritative write,
  // and no profile/avatar/storage mutation may happen before it succeeds.
  const { data: deletedAllowedUser, error } = await adminClient
    .from('cms_allowed_users')
    .delete()
    .eq('id', target.id)
    .eq('role', target.role)
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (!deletedAllowedUser) {
    return {
      success: false,
      error: 'The user changed concurrently. Refresh and try again.',
    };
  }

  // Find and delete user profile
  let profile: { id: string; avatar_url: string | null } | null = null;

  // Check if this is a dummy user (email format: dummy-{uuid}@dummy.local)
  const isDummyUser = isDummyEmail(target.email);

  // Try to find profile by email (works for both dummy and regular users)
  if (target.email) {
    const { data, error: profileLookupError } = await adminClient
      .from('user_profiles')
      .select('id, avatar_url')
      .eq('email', target.email.toLowerCase())
      .maybeSingle();
    if (profileLookupError) throw profileLookupError;
    profile = data;
  }

  // Try immutable GitHub ID before the legacy display handle.
  if (!profile && target.github_user_id) {
    const { data, error: profileLookupError } = await adminClient
      .from('user_profiles')
      .select('id, avatar_url')
      .eq('github_user_id', target.github_user_id)
      .maybeSingle();
    if (profileLookupError) throw profileLookupError;
    profile = data;
  }

  // Legacy display handle last (dual-allowed transition only).
  if (!profile && !target.github_user_id && target.github_username) {
    const { data, error: profileLookupError } = await adminClient
      .from('user_profiles')
      .select('id, avatar_url')
      .eq('github_username', target.github_username)
      .maybeSingle();
    if (profileLookupError) throw profileLookupError;
    profile = data;
  }

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
    // Per-profile folder: wipes any older avatar the update path left behind.
    // Legacy rows may hold a pre-reorg URL, handled by the removal above.
    await removePrefixBestEffort(
      adminClient,
      bucket,
      avatarPrefixForProfile(profile.id)
    );

    // Auth is shared across schemas; staging must never cascade public rows.
    // Deletion stays dummy-only: an invited shared Auth identity is never
    // deleted here (the allowlist row is the authority).
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
  actor: CmsActor,
  profileId: unknown,
  displayName?: string
): Promise<UsersResult> {
  const managed = await loadManagedProfile(actor, profileId);
  if ('error' in managed) {
    return { success: false, error: managed.error };
  }

  if (!displayName || displayName.trim().length === 0) {
    return { success: false, error: 'No changes to save' };
  }

  if (displayName.trim().length > 100) {
    return {
      success: false,
      error: 'Display name must be 100 characters or less',
    };
  }

  // Explicit column: this route can never touch identity or role columns.
  // Require returned-row evidence so a missing profile never reports success.
  const { error } = await getCmsAdminClient()
    .from('user_profiles')
    .update({ display_name: displayName.trim() })
    .eq('id', managed.profile.id)
    .select('id')
    .single();

  if (error) throw error;

  const revalidation = await invalidatePublicContent({
    entity: 'author',
    operation: 'update',
    id: managed.profile.id,
  });
  return { success: true, revalidation };
}

/**
 * Upload avatar for a specific user (admin-level, allowlist-bound target).
 */
export async function uploadUserAvatar(
  formData: FormData
): Promise<ProfileUpdateResult> {
  let actor: CmsActor;
  try {
    actor = await getManagementActor();
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, 'Unauthorized: Admin access required'),
    };
  }

  const profileId = formData.get('profileId');
  const avatarValue = formData.get('avatar');
  const avatarFile = avatarValue instanceof File ? avatarValue : null;

  if (!avatarFile || avatarFile.size === 0) {
    return { success: false, error: 'Please select an image' };
  }

  // Validate the image
  const validation = validateImageFile(avatarFile);
  if (!validation.isValid) {
    return { success: false, error: validation.error };
  }

  try {
    // Resolve the target through the allowlist before touching bytes or rows:
    // an arbitrary/self/protected profile id is rejected here.
    const managed = await loadManagedProfile(actor, profileId);
    if ('error' in managed) {
      return { success: false, error: managed.error };
    }
    const { profile } = managed;

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

    // Unique immutable path: the new avatar never overwrites the previous one,
    // so a failed DB update can never leave the row pointing at a deleted
    // object. The previous DB-referenced avatar is removed after the commit.
    let upload: { publicUrl: string; path: string };
    try {
      upload = await uploadImmutablePreparedImage(
        adminClient,
        bucket,
        avatarPrefixForProfile(profile.id),
        profile.id,
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
      .eq('id', profile.id)
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
      profile.avatar_url,
      bucket,
      upload.path
    );

    // Revalidate CMS paths to ensure fresh data
    refresh();
    const revalidation = await invalidatePublicContent({
      entity: 'author',
      operation: 'update',
      id: profile.id,
    });

    return { success: true, avatarUrl, revalidation };
  } catch (error) {
    console.error('Avatar upload error:', error);
    return {
      success: false,
      error: errorMessage(error, 'Failed to upload avatar'),
    };
  }
}

/**
 * Update a user's display name (admin-level, allowlist-bound target).
 */
export async function updateUserDisplayName(
  profileId: string,
  displayName: string
): Promise<ProfileUpdateResult> {
  let actor: CmsActor;
  try {
    actor = await getManagementActor();
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, 'Unauthorized: Admin access required'),
    };
  }

  try {
    const managed = await loadManagedProfile(actor, profileId);
    if ('error' in managed) {
      return { success: false, error: managed.error };
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

    // Update user_profiles table using admin client; explicit column and
    // returned-row evidence so a missing profile never reports success.
    const { error: updateError } = await getCmsAdminClient()
      .from('user_profiles')
      .update({ display_name: displayName.trim() })
      .eq('id', managed.profile.id)
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
      id: managed.profile.id,
    });

    return { success: true, revalidation };
  } catch (error) {
    console.error('Profile update error:', error);
    return {
      success: false,
      error: errorMessage(error, 'Failed to update display name'),
    };
  }
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
  const avatarValue = formData.get('avatar');
  const avatarFile = avatarValue instanceof File ? avatarValue : null;

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
        avatarPrefixForProfile(user.id),
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

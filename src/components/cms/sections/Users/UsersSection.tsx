'use client';

import {
  Camera,
  Check,
  Mail,
  Pencil,
  Plus,
  Shield,
  Trash2,
  User,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  updateUserDisplayName,
  uploadUserAvatar,
  usersActions,
} from '@/app/actions/cms/sections/usersActions';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { RoleSelect } from '@/components/cms/shared/RoleChip';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { GithubIcon } from '@/components/common/BrandIcons';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import { processImageToWebP } from '@/utils/imageProcessor';

type AllowedUser = {
  id: number;
  email: string | null;
  github_username: string | null;
  role: 'admin' | 'editor';
  invited_at: string | null;
  created_at: string;
  profile?: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
};

export default function UsersSection() {
  const t = useTranslations('cms');
  const { user } = useCmsStore();
  const [users, setUsers] = useState<AllowedUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addType, setAddType] = useState<'email' | 'github' | 'dummy'>('email');
  const [newUserInput, setNewUserInput] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'editor'>('editor');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadingAvatarFor, setUploadingAvatarFor] = useState<string | null>(
    null
  );
  const [editingNameFor, setEditingNameFor] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');
  const [savingNameFor, setSavingNameFor] = useState<string | null>(null);
  const [updatingRoleFor, setUpdatingRoleFor] = useState<number | null>(null);
  const fileInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const [removeTarget, setRemoveTarget] = useState<AllowedUser | null>(null);
  const [removing, setRemoving] = useState(false);
  const removalLock = useRef(false);

  const isAdmin = user?.role === 'admin';

  const beginLoad = useLatestRequest();
  const fetchUsers = useCallback(async () => {
    const current = beginLoad();
    setIsLoading(true);
    setError(null);
    try {
      const r = await usersActions({ type: 'GET' });
      if (!current()) return;
      if (!r.success) throw new Error(r.error || 'Failed');
      setUsers(r.data as AllowedUser[]);
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [beginLoad]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleAddUser = async () => {
    if (!newUserInput.trim() && addType !== 'dummy') {
      setError(t('users.errorEnterEmailOrGithub'));
      return;
    }
    if (addType === 'dummy' && !newUserInput.trim()) {
      setError(t('users.errorEnterDisplayName'));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      let result: Awaited<ReturnType<typeof usersActions>>;
      if (addType === 'email')
        result = await usersActions({
          type: 'ADD_EMAIL',
          email: newUserInput,
          role: newUserRole,
        });
      else if (addType === 'github')
        result = await usersActions({
          type: 'ADD_GITHUB',
          github_username: newUserInput,
          role: newUserRole,
        });
      else
        result = await usersActions({
          type: 'ADD_DUMMY',
          display_name: newUserInput,
          role: newUserRole,
        });
      if (!result.success) throw new Error(result.error || 'Failed');
      setNewUserInput('');
      setIsAdding(false);
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateRole = async (id: number, newRole: 'admin' | 'editor') => {
    setError(null);
    setUpdatingRoleFor(id);
    try {
      const r = await usersActions({ type: 'UPDATE_ROLE', id, role: newRole });
      if (!r.success) throw new Error(r.error);
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('users.errorUpdateRole'));
    } finally {
      setUpdatingRoleFor(null);
    }
  };

  const handleRemoveUser = async () => {
    if (!removeTarget || removalLock.current || !isAdmin) return;
    removalLock.current = true;
    setRemoving(true);
    setError(null);
    try {
      const r = await usersActions({ type: 'REMOVE', id: removeTarget.id });
      if (!r.success) throw new Error(r.error);
      setRemoveTarget(null);
      await fetchUsers();
      const warning = revalidationWarning(r);
      if (warning) setError(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('users.errorRemoveUser'));
      setRemoveTarget(null);
    } finally {
      removalLock.current = false;
      setRemoving(false);
    }
  };

  const handleAvatarChange = async (profileId: string, file: File) => {
    setUploadingAvatarFor(profileId);
    setError(null);
    try {
      const processed = await processImageToWebP(file, {
        maxWidth: 256,
        maxHeight: 256,
        quality: 0.85,
      });
      if (!processed.success || !processed.file)
        throw new Error(processed.error || 'Failed');
      const fd = new FormData();
      fd.append('profileId', profileId);
      fd.append('avatar', processed.file);
      const r = await uploadUserAvatar(fd);
      if (!r.success) throw new Error(r.error);
      const warning = revalidationWarning(r);
      if (warning) setError(warning);
      await fetchUsers();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('users.errorUploadAvatar')
      );
    } finally {
      setUploadingAvatarFor(null);
    }
  };

  const handleSaveName = async (profileId: string) => {
    if (!editedName.trim()) return;
    setSavingNameFor(profileId);
    setError(null);
    try {
      const r = await updateUserDisplayName(profileId, editedName.trim());
      if (!r.success) throw new Error(r.error);
      const warning = revalidationWarning(r);
      if (warning) setError(warning);
      setEditingNameFor(null);
      setEditedName('');
      await new Promise((res) => setTimeout(res, 100));
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('users.errorUpdateName'));
      await fetchUsers();
    } finally {
      setSavingNameFor(null);
    }
  };

  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none';

  const roleLabels = {
    admin: t('users.roleAdmin'),
    editor: t('users.roleEditor'),
  };
  const adminCount = users.filter((u) => u.role === 'admin').length;

  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('users.title')}
        description={t('users.subtitle')}
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {!isAdmin && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <Shield className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {t('users.adminRequired')}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-text-dim" />
          <span className="text-sm font-medium text-text-main">
            {t('users.allowedUsersTitle')}
          </span>
          <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs tabular-nums text-text-dim">
            {users.length}
          </span>
        </div>
        {isAdmin && !isAdding && (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1.5 rounded-lg bg-accent-violet-deep px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent-violet"
          >
            <Plus className="h-4 w-4" />
            {t('users.addUser')}
          </button>
        )}
      </div>

      {isAdmin && isAdding && (
        <div className="rounded-xl border border-border-subtle bg-surface-card p-4">
          <div className="inline-flex rounded-lg bg-surface-base p-1">
            {(['email', 'github', 'dummy'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setAddType(type)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  addType === type
                    ? 'bg-surface-raised text-text-main'
                    : 'text-text-dim hover:text-text-main'
                }`}
              >
                {type === 'email' && (
                  <>
                    <Mail className="h-3.5 w-3.5" />
                    {t('users.emailInvite')}
                  </>
                )}
                {type === 'github' && (
                  <>
                    <GithubIcon className="h-3.5 w-3.5" />
                    {t('users.githubUsername')}
                  </>
                )}
                {type === 'dummy' && (
                  <>
                    <User className="h-3.5 w-3.5" />
                    {t('users.dummyUser')}
                  </>
                )}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type={addType === 'email' ? 'email' : 'text'}
              value={newUserInput}
              onChange={(e) => setNewUserInput(e.target.value)}
              className={inputClass}
              placeholder={
                addType === 'email'
                  ? t('users.emailPlaceholder')
                  : addType === 'github'
                    ? t('users.githubPlaceholder')
                    : t('users.displayNamePlaceholder')
              }
            />
            <RoleSelect
              cmsRole={newUserRole}
              labels={roleLabels}
              label={t('users.roleLabel')}
              onChange={(r) => {
                setNewUserRole(r);
                setError(null);
              }}
            />
          </div>

          <p className="mt-2 text-xs text-text-dim">
            {addType === 'email'
              ? t('users.emailInviteInfo')
              : addType === 'github'
                ? t('users.githubInviteInfo')
                : t('users.dummyUserInfo')}
          </p>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={handleAddUser}
              disabled={isSubmitting}
              className="flex items-center gap-1.5 rounded-lg bg-accent-violet-deep px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent-violet disabled:opacity-50"
            >
              <UserCheck className="h-3.5 w-3.5" />
              {isSubmitting ? t('users.adding') : t('users.addUser')}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsAdding(false);
                setNewUserInput('');
                setError(null);
              }}
              className="rounded-lg bg-surface-base px-3 py-1.5 text-sm text-text-main transition-colors hover:bg-surface-raised"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {users.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle py-12 text-center text-sm text-text-muted">
          {t('users.noUsersYet')}
        </div>
      ) : (
        users.map((au) => {
          const hasProfile = !!au.profile;
          const isCurrentUser =
            user &&
            ((user.email &&
              au.email?.toLowerCase() === user.email.toLowerCase()) ||
              (user.githubUsername &&
                au.github_username === user.githubUsername) ||
              (user.id && au.profile?.id === user.id));
          const isLastAdmin = au.role === 'admin' && adminCount === 1;
          const isDummy = !!au.email?.startsWith('dummy-');
          const isEditing = editingNameFor === au.profile?.id;
          const isUploading = uploadingAvatarFor === au.profile?.id;
          const displayName =
            au.profile?.display_name ||
            (!isDummy && au.email) ||
            (au.github_username ? `@${au.github_username}` : 'Unknown');

          // The name falls back to an identifier when there is no profile, so
          // only surface the handles the heading is not already showing.
          const showEmail = !!au.email && displayName !== au.email;
          const showGithub =
            !!au.github_username && displayName !== `@${au.github_username}`;

          const avatar = au.profile?.avatar_url ? (
            <Image
              src={au.profile.avatar_url}
              alt=""
              fill
              sizes="40px"
              className="object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-accent-violet font-heading text-sm font-semibold text-white">
              {(au.profile?.display_name || 'U').charAt(0).toUpperCase()}
            </span>
          );

          return (
            <div
              key={au.id}
              className="flex flex-col gap-4 border-t border-border-subtle py-4 sm:flex-row sm:items-center sm:gap-6"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {hasProfile && isAdmin && !isCurrentUser ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const inp = fileInputRefs.current.get(au.profile!.id);
                        inp?.click();
                      }}
                      disabled={isUploading}
                      className="group/avatar relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-full bg-surface-raised"
                    >
                      {avatar}
                      <span
                        className={`absolute inset-0 flex items-center justify-center bg-black/60 transition-opacity ${
                          isUploading
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/avatar:opacity-100'
                        }`}
                      >
                        {isUploading ? (
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        ) : (
                          <Camera className="h-4 w-4 text-white" />
                        )}
                      </span>
                    </button>
                    <input
                      ref={(el) => {
                        if (el && au.profile?.id)
                          fileInputRefs.current.set(au.profile.id, el);
                      }}
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f && au.profile?.id)
                          handleAvatarChange(au.profile.id, f);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </>
                ) : hasProfile ? (
                  <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full bg-surface-raised">
                    {avatar}
                  </span>
                ) : (
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      au.github_username
                        ? 'bg-surface-raised'
                        : 'bg-blue-600/20'
                    }`}
                  >
                    {au.github_username ? (
                      <GithubIcon className="h-5 w-5 text-white" />
                    ) : (
                      <Mail className="h-5 w-5 text-blue-400" />
                    )}
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={editedName}
                          onChange={(e) => setEditedName(e.target.value)}
                          className="w-28 rounded border border-accent-violet bg-surface-card px-1 py-0.5 text-sm text-text-main focus:outline-none"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              handleSaveName(au.profile!.id);
                            if (e.key === 'Escape') {
                              setEditingNameFor(null);
                              setEditedName('');
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveName(au.profile!.id)}
                          disabled={savingNameFor === au.profile?.id}
                          className="p-0.5 text-green-400"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingNameFor(null);
                            setEditedName('');
                          }}
                          className="p-0.5 text-red-400"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="truncate font-medium text-text-main">
                          {displayName}
                        </span>
                        {hasProfile && isAdmin && !isCurrentUser && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingNameFor(au.profile!.id);
                              setEditedName(au.profile?.display_name || '');
                            }}
                            className="shrink-0 rounded p-0.5 text-text-dim transition-colors hover:text-accent-violet"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </>
                    )}
                    {isCurrentUser && (
                      <span className="rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                        {t('users.you')}
                      </span>
                    )}
                    {isDummy && (
                      <span className="rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-400">
                        Dummy
                      </span>
                    )}
                  </div>

                  {(showEmail ||
                    showGithub ||
                    (!hasProfile && !isDummy) ||
                    (isLastAdmin && !isCurrentUser)) && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-dim">
                      {showEmail && (
                        <span className="truncate">{au.email}</span>
                      )}
                      {showGithub && (
                        <span className="inline-flex items-center gap-1">
                          <GithubIcon className="h-3 w-3" />@
                          {au.github_username}
                        </span>
                      )}
                      {!hasProfile && !isDummy && (
                        <span className="text-amber-500">
                          {t('users.notLoggedInYet')}
                        </span>
                      )}
                      {isLastAdmin && !isCurrentUser && (
                        <span className="text-amber-500">
                          {t('users.lastAdminWarning')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {isAdmin && !isCurrentUser && (
                <div className="flex shrink-0 items-center gap-1">
                  <RoleSelect
                    cmsRole={au.role}
                    labels={roleLabels}
                    label={t('users.roleLabel')}
                    editorDisabled={isLastAdmin}
                    disabled={updatingRoleFor === au.id || removing}
                    onChange={(nr) => {
                      if (isLastAdmin && nr === 'editor') {
                        setError(t('users.cannotDemoteLastAdmin'));
                        return;
                      }
                      handleUpdateRole(au.id, nr);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(au)}
                    disabled={
                      removing ||
                      updatingRoleFor !== null ||
                      uploadingAvatarFor !== null ||
                      savingNameFor !== null ||
                      isSubmitting
                    }
                    aria-label={t('users.removeUser')}
                    className="rounded-md p-2 text-text-dim transition-colors hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
      <ConfirmDialog
        isOpen={removeTarget !== null}
        title={t('users.removeConfirmTitle')}
        message={t('users.removeConfirmMessage', {
          identity:
            removeTarget?.profile?.display_name ||
            removeTarget?.email ||
            removeTarget?.github_username ||
            String(removeTarget?.id ?? ''),
        })}
        busy={removing}
        onConfirm={() => void handleRemoveUser()}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

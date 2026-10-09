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
import {
  EditorGroup,
  EditorToolbar,
  editorInputClass,
  editorLabelClass,
  editorPrimaryButtonClass,
  editorRowClass,
  editorSecondaryButtonClass,
} from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { RoleSelect } from '@/components/cms/shared/RoleChip';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { GithubIcon } from '@/components/common/BrandIcons';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { demoUsers } from '@/libs/demo/fixtures';
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
    // Offline showcase: fixture roster, no server round-trip.
    if (useCmsStore.getState().demoMode) {
      if (!current()) return;
      setUsers(JSON.parse(JSON.stringify(demoUsers)));
      setIsLoading(false);
      return;
    }
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
    // Offline showcase: append a fake row locally.
    if (useCmsStore.getState().demoMode) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const input = newUserInput.trim();
        setUsers((prev) => {
          const nextId = Math.max(0, ...prev.map((u) => u.id)) + 1;
          const row: AllowedUser =
            addType === 'github'
              ? {
                  id: nextId,
                  email: null,
                  github_username: input,
                  role: newUserRole,
                  invited_at: null,
                  created_at: new Date().toISOString(),
                  profile: null,
                }
              : addType === 'dummy'
                ? {
                    id: nextId,
                    email: null,
                    github_username: null,
                    role: newUserRole,
                    invited_at: null,
                    created_at: new Date().toISOString(),
                    profile: {
                      id: `demo-dummy-${nextId}`,
                      display_name: input,
                      avatar_url: null,
                    },
                  }
                : {
                    id: nextId,
                    email: input,
                    github_username: null,
                    role: newUserRole,
                    invited_at: new Date().toISOString(),
                    created_at: new Date().toISOString(),
                    profile: null,
                  };
          return [...prev, row];
        });
        setNewUserInput('');
        setIsAdding(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
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
    // Offline showcase: flip the row locally.
    if (useCmsStore.getState().demoMode) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        setUsers((prev) =>
          prev.map((u) => (u.id === id ? { ...u, role: newRole } : u))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : t('users.errorUpdateRole'));
      } finally {
        setUpdatingRoleFor(null);
      }
      return;
    }
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
    // Offline showcase: drop the row locally.
    if (useCmsStore.getState().demoMode) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const targetId = removeTarget.id;
        setUsers((prev) => prev.filter((u) => u.id !== targetId));
        setRemoveTarget(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('users.errorRemoveUser'));
        setRemoveTarget(null);
      } finally {
        removalLock.current = false;
        setRemoving(false);
      }
      return;
    }
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
    // Offline showcase: point the row at an object URL locally.
    if (useCmsStore.getState().demoMode) {
      try {
        const processed = await processImageToWebP(file, {
          maxWidth: 256,
          maxHeight: 256,
          quality: 0.85,
        });
        if (!processed.success || !processed.file)
          throw new Error(processed.error || 'Failed');
        const url = URL.createObjectURL(processed.file);
        setUsers((prev) =>
          prev.map((u) =>
            u.profile?.id === profileId
              ? { ...u, profile: { ...u.profile, avatar_url: url } }
              : u
          )
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('users.errorUploadAvatar')
        );
      } finally {
        setUploadingAvatarFor(null);
      }
      return;
    }
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
    // Offline showcase: rename the row locally.
    if (useCmsStore.getState().demoMode) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const name = editedName.trim();
        setUsers((prev) =>
          prev.map((u) =>
            u.profile?.id === profileId
              ? { ...u, profile: { ...u.profile, display_name: name } }
              : u
          )
        );
        setEditingNameFor(null);
        setEditedName('');
      } catch (err) {
        setError(err instanceof Error ? err.message : t('users.errorUpdateName'));
      } finally {
        setSavingNameFor(null);
      }
      return;
    }
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

      <EditorToolbar
        title={
          <span className="inline-flex items-center gap-2">
            <Users className="h-4 w-4 text-text-dim" />
            {t('users.allowedUsersTitle')}
          </span>
        }
        count={users.length}
        description={t('editor.immediateHint')}
        actions={
          isAdmin && !isAdding ? (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className={editorPrimaryButtonClass}
            >
              <Plus className="h-4 w-4" />
              {t('users.addUser')}
            </button>
          ) : undefined
        }
      />

      {isAdmin && isAdding && (
        <EditorGroup
          title={t('users.addNewUserTitle')}
          description={t('editor.immediateHint')}
        >
          <div className="inline-flex max-w-full flex-wrap rounded-lg bg-surface-base p-1">
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

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="users-new-identity" className={editorLabelClass}>
                {addType === 'email'
                  ? t('users.emailAddressLabel')
                  : addType === 'github'
                    ? t('users.githubUsernameLabel')
                    : t('users.displayNameLabel')}
              </label>
              <input
                id="users-new-identity"
                type={addType === 'email' ? 'email' : 'text'}
                value={newUserInput}
                onChange={(e) => setNewUserInput(e.target.value)}
                className={editorInputClass}
                placeholder={
                  addType === 'email'
                    ? t('users.emailPlaceholder')
                    : addType === 'github'
                      ? t('users.githubPlaceholder')
                      : t('users.displayNamePlaceholder')
                }
              />
              <p className="mt-1 text-xs text-text-dim">
                {addType === 'email'
                  ? t('users.emailInviteInfo')
                  : addType === 'github'
                    ? t('users.githubInviteInfo')
                    : t('users.dummyUserInfo')}
              </p>
            </div>
            <div>
              <span className={editorLabelClass}>{t('users.roleLabel')}</span>
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
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleAddUser}
              disabled={isSubmitting}
              className={editorPrimaryButtonClass}
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
              className={editorSecondaryButtonClass}
            >
              {t('common.cancel')}
            </button>
          </div>
        </EditorGroup>
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
            <article
              key={au.id}
              aria-label={displayName}
              className={`${editorRowClass} flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {hasProfile && isAdmin && !isCurrentUser ? (
                  <>
                    <button
                      type="button"
                      aria-label={`${t('account.clickToUpload')} — ${displayName}`}
                      onClick={() => {
                        const inp = fileInputRefs.current.get(au.profile!.id);
                        inp?.click();
                      }}
                      disabled={isUploading}
                      className="group/avatar relative h-11 w-11 shrink-0 cursor-pointer overflow-hidden rounded-full bg-surface-raised"
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
                  <div className="flex flex-wrap items-center gap-2">
                    {isEditing ? (
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <input
                          type="text"
                          aria-label={t('users.displayNameLabel')}
                          value={editedName}
                          onChange={(e) => setEditedName(e.target.value)}
                          className={editorInputClass}
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
                          aria-label={t('common.save')}
                          onClick={() => handleSaveName(au.profile!.id)}
                          disabled={savingNameFor === au.profile?.id}
                          className={editorPrimaryButtonClass}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('common.cancel')}
                          onClick={() => {
                            setEditingNameFor(null);
                            setEditedName('');
                          }}
                          className={editorSecondaryButtonClass}
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
                            aria-label={`${t('common.edit')} — ${displayName}`}
                            onClick={() => {
                              setEditingNameFor(au.profile!.id);
                              setEditedName(au.profile?.display_name || '');
                            }}
                            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-text-dim transition-colors hover:bg-surface-raised hover:text-accent-violet"
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
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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
                    className="flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-text-dim transition-colors hover:bg-surface-raised hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </article>
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

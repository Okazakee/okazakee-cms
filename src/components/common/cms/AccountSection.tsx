'use client';

import type { PasskeyListItem } from '@supabase/auth-js';
import {
  Camera,
  Check,
  Fingerprint,
  Mail,
  Pencil,
  Plus,
  Trash2,
  User,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { deleteMyAccount } from '@/app/actions/cms/deleteAccount';
import { getUser } from '@/app/actions/cms/getUser';
import { updateMyProfile } from '@/app/actions/cms/sections/usersActions';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { RoleChip } from '@/components/cms/shared/RoleChip';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { GithubIcon } from '@/components/common/BrandIcons';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import { processImageToWebP } from '@/utils/imageProcessor';
import { createClient } from '@/utils/supabase/client';

export default function AccountSection() {
  const t = useTranslations('cms');
  const { user, setUser } = useCmsStore();
  const demoMode = useCmsStore((state) => state.demoMode);
  const [error, setError] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyListItem[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(true);
  const [isRegisteringPasskey, setIsRegisteringPasskey] = useState(false);
  const [passkeyToDelete, setPasskeyToDelete] =
    useState<PasskeyListItem | null>(null);
  const [isDeletingPasskey, setIsDeletingPasskey] = useState(false);
  const [passkeysError, setPasskeysError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) {
      setEditedName(user.displayName);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    // No Supabase session exists in the showcase: skip the list entirely.
    if (useCmsStore.getState().demoMode) {
      setPasskeysLoading(false);
      return;
    }
    let cancelled = false;
    createClient()
      .auth.passkey.list()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setPasskeysError(t('account.passkeysLoadError'));
          return;
        }
        setPasskeys(data ?? []);
      })
      .catch(() => {
        if (!cancelled) setPasskeysError(t('account.passkeysLoadError'));
      })
      .finally(() => {
        if (!cancelled) setPasskeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, t]);

  const refreshPasskeys = async () => {
    const { data, error } = await createClient().auth.passkey.list();
    if (error) {
      setPasskeysError(t('account.passkeysLoadError'));
      return;
    }
    setPasskeys(data ?? []);
  };

  const handleDeletePasskey = async () => {
    if (!passkeyToDelete) return;
    setIsDeletingPasskey(true);
    setPasskeysError(null);
    try {
      const { error } = await createClient().auth.passkey.delete({
        passkeyId: passkeyToDelete.id,
      });
      if (error) {
        setPasskeysError(t('account.passkeysDeleteError'));
        return;
      }
      setPasskeys((prev) => prev.filter((p) => p.id !== passkeyToDelete.id));
      setPasskeyToDelete(null);
    } catch {
      setPasskeysError(t('account.passkeysDeleteError'));
    } finally {
      setIsDeletingPasskey(false);
    }
  };

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarChange = async (file: File) => {
    setIsUploadingAvatar(true);
    setError(null);

    // Offline showcase: point the demo profile at an object URL.
    if (useCmsStore.getState().demoMode) {
      try {
        const processed = await processImageToWebP(file, {
          maxWidth: 256,
          maxHeight: 256,
          quality: 0.85,
        });
        if (!processed.success || !processed.file) {
          throw new Error(processed.error || 'Failed to process image');
        }
        const store = useCmsStore.getState();
        if (store.user) {
          store.setUser({
            ...store.user,
            avatarUrl: URL.createObjectURL(processed.file),
          });
        }
      } catch (err) {
        console.error('Error uploading avatar:', err);
        setError(
          err instanceof Error ? err.message : t('account.errorUploadAvatar')
        );
      } finally {
        setIsUploadingAvatar(false);
      }
      return;
    }

    try {
      // Process image to WebP before upload
      const processed = await processImageToWebP(file, {
        maxWidth: 256,
        maxHeight: 256,
        quality: 0.85,
      });

      if (!processed.success || !processed.file) {
        throw new Error(processed.error || 'Failed to process image');
      }

      const formData = new FormData();
      formData.append('avatar', processed.file);

      const result = await updateMyProfile(formData);
      if (!result.success) {
        throw new Error(result.error || 'Failed to upload avatar');
      }
      const warning = revalidationWarning(result);
      if (warning) setError(warning);

      const updated = await getUser();
      if (updated) {
        setUser(updated);
      }
    } catch (err) {
      console.error('Error uploading avatar:', err);
      setError(
        err instanceof Error ? err.message : t('account.errorUploadAvatar')
      );
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleRegisterPasskey = async () => {
    setIsRegisteringPasskey(true);
    setPasskeysError(null);
    try {
      const { error } = await createClient().auth.registerPasskey();
      if (error) {
        console.error('Passkey registration failed:', error);
        setPasskeysError(t('account.passkeysRegisterError'));
        return;
      }
      await refreshPasskeys();
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      // NotAllowedError: the user dismissed the authenticator prompt.
      if (name !== 'NotAllowedError') {
        console.error('Passkey registration failed:', err);
        setPasskeysError(
          name === 'InvalidStateError'
            ? t('account.passkeyAlreadyRegistered')
            : t('account.passkeysRegisterError')
        );
      }
    } finally {
      setIsRegisteringPasskey(false);
    }
  };

  const handleEditNameClick = () => {
    setEditingName(true);
    setEditedName(user?.displayName || '');
  };

  const handleSaveName = async () => {
    if (!editedName.trim() || !user) return;

    setSavingName(true);
    setError(null);

    // Offline showcase: rename the demo profile locally.
    if (useCmsStore.getState().demoMode) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const store = useCmsStore.getState();
        if (store.user) {
          store.setUser({ ...store.user, displayName: editedName.trim() });
        }
        setEditingName(false);
      } catch (err) {
        console.error('Error updating display name:', err);
        setError(
          err instanceof Error ? err.message : t('account.errorUpdateName')
        );
      } finally {
        setSavingName(false);
      }
      return;
    }

    const formData = new FormData();
    formData.append('displayName', editedName.trim());

    try {
      const result = await updateMyProfile(formData);
      if (!result.success) {
        throw new Error(result.error || 'Failed to update display name');
      }
      const warning = revalidationWarning(result);
      if (warning) setError(warning);
      setEditingName(false);
      // Refresh user data
      const refreshedUser = await getUser();
      if (refreshedUser) {
        setUser(refreshedUser);
      }
    } catch (err) {
      console.error('Error updating display name:', err);
      setError(
        err instanceof Error ? err.message : t('account.errorUpdateName')
      );
    } finally {
      setSavingName(false);
    }
  };

  const handleCancelEditName = () => {
    setEditingName(false);
    setEditedName(user?.displayName || '');
  };

  const handleDeleteAccount = async () => {
    try {
      localStorage.removeItem('cms_last_user');
    } catch {
      // Ignore storage failures: deletion must proceed regardless.
    }
    try {
      setIsDeleting(true);
      setError(null);
      const result = await deleteMyAccount();
      // On success the action calls redirect() — the framework owns the
      // navigation and the awaited promise rejects with NEXT_REDIRECT, so a
      // RESOLVED result here is always a typed failure. Never navigate from
      // the client on the success path.
      if (result && !result.success) {
        throw new Error(result.error || 'Failed to delete account');
      }
    } catch (err) {
      // The framework's redirect control flow surfaces as a NEXT_REDIRECT
      // rejection after the action threw; navigation is already in flight —
      // do not turn it into an error.
      const isRedirect =
        (err instanceof Error && err.message.startsWith('NEXT_REDIRECT')) ||
        String((err as { digest?: unknown })?.digest ?? '').startsWith(
          'NEXT_REDIRECT'
        );
      if (isRedirect) return;
      console.error('Error deleting account:', err);
      setError(
        err instanceof Error ? err.message : t('account.errorDeleteAccount')
      );
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  if (!user) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-accent-violet border-t-transparent" />
      </div>
    );
  }

  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-sm text-text-main focus:border-accent-violet focus:outline-none';

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('account.title')}
        description={t('account.subtitle')}
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
        <h2 className="mb-5 flex items-center gap-2 text-lg font-bold text-text-white">
          <User className="h-5 w-5 text-text-dim" />
          {t('account.profileInfoTitle')}
        </h2>

        <div className="space-y-6">
          <div className="flex items-center gap-6">
            <div className="relative">
              <button
                type="button"
                onClick={handleAvatarClick}
                disabled={isUploadingAvatar}
                className="group relative h-24 w-24 shrink-0 cursor-pointer overflow-hidden rounded-full bg-surface-raised"
              >
                {user.avatarUrl ? (
                  <Image
                    src={user.avatarUrl}
                    alt={user.displayName || 'User'}
                    fill
                    sizes="96px"
                    className="object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-accent-violet font-heading text-2xl font-semibold text-white">
                    {(user.displayName || 'U').charAt(0).toUpperCase()}
                  </span>
                )}
                <span
                  className={`absolute inset-0 flex items-center justify-center bg-black/60 transition-opacity ${
                    isUploadingAvatar
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  {isUploadingAvatar ? (
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <Camera className="h-6 w-6 text-white" />
                  )}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleAvatarChange(file);
                  }
                  e.target.value = '';
                }}
                className="hidden"
              />
            </div>
            <div className="min-w-0">
              <p className="mb-1 block text-sm font-medium text-text-main">
                {t('account.profilePictureLabel')}
              </p>
              <p className="text-xs text-text-dim">
                {t('account.clickToUpload')}
              </p>
            </div>
          </div>

          <div>
            <label
              htmlFor="display-name-input"
              className="mb-1 block text-sm font-medium text-text-main"
            >
              {t('account.displayNameLabel')}
            </label>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  id="display-name-input"
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  className={`${inputClass} flex-1`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') handleCancelEditName();
                  }}
                />
                <button
                  type="button"
                  onClick={handleSaveName}
                  disabled={savingName}
                  className="rounded p-2 text-green-400 transition-colors hover:bg-green-500/10 disabled:opacity-50"
                >
                  <Check className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelEditName}
                  className="rounded p-2 text-red-400 transition-colors hover:bg-red-500/10"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className={`${inputClass} flex items-center`}>
                  {user.displayName}
                </span>
                <button
                  type="button"
                  onClick={handleEditNameClick}
                  className="rounded p-2 text-text-dim transition-colors hover:bg-surface-raised hover:text-accent-violet"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {user.email && (
            <div>
              <p className="mb-1 block text-sm font-medium text-text-main">
                {t('account.emailLabel')}
              </p>
              <p className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-muted">
                <Mail className="h-4 w-4" />
                <span className="truncate">{user.email}</span>
              </p>
              <p className="mt-1 text-xs text-text-dim">
                {t('account.emailReadOnly')}
              </p>
            </div>
          )}

          {user.githubUsername && (
            <div>
              <p className="mb-1 block text-sm font-medium text-text-main">
                {t('account.githubUsernameLabel')}
              </p>
              <p className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-muted">
                <GithubIcon className="h-4 w-4" />
                <span className="truncate">@{user.githubUsername}</span>
              </p>
              <p className="mt-1 text-xs text-text-dim">
                {t('account.githubReadOnly')}
              </p>
            </div>
          )}

          <div>
            <p className="mb-1 block text-sm font-medium text-text-main">
              {t('account.roleLabel')}
            </p>
            <div className="rounded-lg border border-border-subtle bg-surface-base px-3 py-2">
              {user.role === 'admin' ? (
                <RoleChip cmsRole="admin" />
              ) : user.role === 'editor' ? (
                <RoleChip cmsRole="editor" />
              ) : (
                <span className="px-2 py-0.5 text-xs text-text-dim">
                  {user.role || 'user'}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-text-dim">
              {t('account.roleReadOnly')}
            </p>
          </div>
        </div>
      </section>

      {/* Passkeys need a real Supabase session: hidden in the showcase. */}
      {!demoMode && (
        <section className="rounded-2xl border border-border-subtle bg-surface-card p-6">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-bold text-text-white">
            <Fingerprint className="h-5 w-5 text-text-dim" />
            {t('account.passkeysTitle')}
          </h2>
        <p className="mb-4 text-sm text-text-muted">
          {t('account.passkeysDesc')}
        </p>

        <ErrorBanner message={passkeysError} />

        {passkeysLoading ? (
          <div className="flex justify-center py-4">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent-violet border-t-transparent" />
          </div>
        ) : passkeys.length === 0 ? (
          <p className="mb-4 text-sm text-text-muted">
            {t('account.passkeysEmpty')}
          </p>
        ) : (
          <ul className="mb-4 space-y-2">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-base px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">
                    {passkey.friendly_name || t('account.passkeyUnnamed')}
                  </p>
                  <p className="text-xs text-text-dim">
                    {passkey.last_used_at
                      ? t('account.passkeyLastUsed', {
                          lastUsed: new Date(
                            passkey.last_used_at
                          ).toLocaleDateString(),
                        })
                      : t('account.passkeyNeverUsed')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPasskeyToDelete(passkey)}
                  disabled={isDeletingPasskey}
                  className="shrink-0 rounded-lg p-2 text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                  aria-label={t('account.passkeyDeleteButton')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {passkeyToDelete ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <p className="min-w-0 text-sm text-red-400">
              {t('account.passkeyDeleteConfirm', {
                name:
                  passkeyToDelete.friendly_name || t('account.passkeyUnnamed'),
              })}
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setPasskeyToDelete(null)}
                disabled={isDeletingPasskey}
                className="rounded-lg bg-surface-base px-3 py-1.5 text-sm text-text-main transition-colors hover:bg-surface-raised"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleDeletePasskey}
                disabled={isDeletingPasskey}
                className="flex items-center gap-2 rounded-lg bg-red-500 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {isDeletingPasskey && (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                )}
                {t('account.passkeyDeleteButton')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleRegisterPasskey}
            disabled={isRegisteringPasskey}
            className="flex items-center gap-1.5 rounded-lg bg-accent-violet-deep px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent-violet disabled:opacity-50"
          >
            {isRegisteringPasskey ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {isRegisteringPasskey
              ? t('account.addingPasskey')
              : t('account.addPasskey')}
          </button>
        )}
      </section>
      )}

      {/* Account deletion is meaningless without a real identity. */}
      {!demoMode && (
        <section className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
        <h2 className="mb-2 flex items-center gap-2 text-lg font-bold text-red-400">
          <Trash2 className="h-5 w-5" />
          {t('account.dangerZoneTitle')}
        </h2>
        <p className="mb-4 text-sm text-text-muted">
          {t('account.dangerZoneDesc')}
        </p>

        {showDeleteConfirm ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-red-500/40 bg-surface-card p-4">
              <p className="mb-2 font-semibold text-red-400">
                {t('account.confirmDeleteTitle')}
              </p>
              <p className="text-sm text-text-muted">
                {t('account.confirmDeleteDesc')}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={isDeleting}
                className="flex items-center gap-2 rounded-lg bg-red-500 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    {t('account.deleting')}
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    {t('account.confirmDeleteButton')}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setError(null);
                }}
                disabled={isDeleting}
                className="rounded-lg bg-surface-base px-3 py-1.5 text-sm text-text-main transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
            {t('account.deleteAccount')}
          </button>
        )}
      </section>
      )}
    </div>
  );
}

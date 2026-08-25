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
import { GithubIcon } from '@/components/common/BrandIcons';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import { processImageToWebP } from '@/utils/imageProcessor';
import { createClient } from '@/utils/supabase/client';
import { registerDiscoverablePasskey } from '@/utils/supabase/passkeys';

export default function AccountSection() {
  const t = useTranslations('cms');
  const { user, setUser } = useCmsStore();
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
      const { error } = await registerDiscoverablePasskey(createClient().auth);
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" />
      </div>
    );
  }

  return (
    <div className="space-y-8 mb-8 md:mb-0 lg:mt-0">
      <div className="text-center mb-8">
        <h1 className="hidden lg:block text-4xl font-bold text-main mb-4">
          {t('account.title')}
        </h1>
        <p className="text-gray-500 dark:text-lighttext2 text-lg">
          {t('account.subtitle')}
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4">
          <p className="text-red-500">{error}</p>
        </div>
      )}

      {/* Profile Card */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-6">
        <h2 className="text-xl font-bold text-main mb-6 flex items-center gap-2">
          <User className="w-5 h-5" />
          {t('account.profileInfoTitle')}
        </h2>

        <div className="space-y-6">
          {/* Avatar Section */}
          <div className="flex items-center gap-6">
            <div className="relative">
              <button
                type="button"
                onClick={handleAvatarClick}
                disabled={isUploadingAvatar}
                className="relative w-24 h-24 rounded-full overflow-hidden bg-gray-200 dark:bg-darkgray flex-shrink-0 group cursor-pointer"
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
                  <div className="w-full h-full flex items-center justify-center bg-main text-white text-2xl font-bold">
                    {(user.displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                {/* Upload overlay */}
                <div
                  className={`absolute inset-0 bg-black/60 flex items-center justify-center transition-opacity ${isUploadingAvatar ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                >
                  {isUploadingAvatar ? (
                    <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Camera className="w-6 h-6 text-white" />
                  )}
                </div>
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
            <div>
              <p className="text-sm text-gray-500 dark:text-lighttext2 mb-1">
                {t('account.profilePictureLabel')}
              </p>
              <p className="text-xs text-gray-500 dark:text-lighttext2">
                {t('account.clickToUpload')}
              </p>
            </div>
          </div>

          {/* Display Name Section */}
          <div>
            <label
              htmlFor="display-name-input"
              className="block text-sm font-medium text-darktext dark:text-lighttext mb-2"
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
                  className="flex-1 px-3 py-2 bg-white dark:bg-darkestgray border border-main rounded-lg text-darktext dark:text-lighttext focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') handleCancelEditName();
                  }}
                />
                <button
                  type="button"
                  onClick={handleSaveName}
                  disabled={savingName}
                  className="p-2 text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded transition-colors disabled:opacity-50"
                >
                  <Check className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelEditName}
                  className="p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="px-3 py-2 bg-white dark:bg-darkestgray rounded-lg text-darktext dark:text-lighttext flex-1">
                  {user.displayName}
                </span>
                <button
                  type="button"
                  onClick={handleEditNameClick}
                  className="p-2 text-gray-500 dark:text-lighttext2 hover:text-main hover:bg-gray-200 dark:hover:bg-darkgray rounded transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Email Section (Read-only) */}
          {user.email && (
            <div>
              <div className="block text-sm font-medium text-darktext dark:text-lighttext mb-2">
                {t('account.emailLabel')}
              </div>
              <div className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-darkestgray rounded-lg text-gray-500 dark:text-lighttext2">
                <Mail className="w-4 h-4" />
                <span>{user.email}</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-lighttext2 mt-1">
                {t('account.emailReadOnly')}
              </p>
            </div>
          )}

          {/* GitHub Username Section (Read-only) */}
          {user.githubUsername && (
            <div>
              <div className="block text-sm font-medium text-darktext dark:text-lighttext mb-2">
                {t('account.githubUsernameLabel')}
              </div>
              <div className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-darkestgray rounded-lg text-gray-500 dark:text-lighttext2">
                <GithubIcon className="w-4 h-4" />
                <span>@{user.githubUsername}</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-lighttext2 mt-1">
                {t('account.githubReadOnly')}
              </p>
            </div>
          )}

          {/* Role Section (Read-only) */}
          <div>
            <div className="block text-sm font-medium text-darktext dark:text-lighttext mb-2">
              {t('account.roleLabel')}
            </div>
            <div className="px-3 py-2 bg-white dark:bg-darkestgray rounded-lg">
              <span
                className={`px-2 py-1 rounded text-xs ${
                  user.role === 'admin'
                    ? 'bg-yellow-500/20 text-yellow-500'
                    : 'bg-blue-500/20 text-blue-400'
                }`}
              >
                {user.role || 'user'}
              </span>
            </div>
            <p className="text-xs text-gray-500 dark:text-lighttext2 mt-1">
              {t('account.roleReadOnly')}
            </p>
          </div>
        </div>
      </div>

      {/* Passkeys */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-6">
        <h2 className="text-xl font-bold text-darktext dark:text-lighttext mb-4 flex items-center gap-2">
          <Fingerprint className="w-5 h-5" />
          {t('account.passkeysTitle')}
        </h2>
        <p className="text-gray-500 dark:text-lighttext2 mb-4">
          {t('account.passkeysDesc')}
        </p>

        {passkeysError && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3 mb-4">
            <p className="text-red-500 text-sm">{passkeysError}</p>
          </div>
        )}

        {passkeysLoading ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-main" />
          </div>
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-lighttext2 mb-4">
            {t('account.passkeysEmpty')}
          </p>
        ) : (
          <ul className="space-y-2 mb-4">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-white dark:bg-darkestgray rounded-lg"
              >
                <div className="min-w-0">
                  <p className="text-sm text-darktext dark:text-lighttext truncate">
                    {passkey.friendly_name || t('account.passkeyUnnamed')}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-lighttext2">
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
                  className="p-2 rounded-lg text-red-400 hover:bg-red-500/10 disabled:opacity-50 flex-shrink-0"
                  aria-label={t('account.passkeyDeleteButton')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {passkeyToDelete ? (
          <div className="flex items-center justify-between gap-3 bg-red-500/10 border border-red-500/50 rounded-lg p-3">
            <p className="text-sm text-red-400">
              {t('account.passkeyDeleteConfirm', {
                name:
                  passkeyToDelete.friendly_name || t('account.passkeyUnnamed'),
              })}
            </p>
            <div className="flex gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setPasskeyToDelete(null)}
                disabled={isDeletingPasskey}
                className="px-3 py-1.5 text-sm rounded-lg text-gray-500 dark:text-lighttext2 hover:bg-gray-200 dark:hover:bg-darkgray"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleDeletePasskey}
                disabled={isDeletingPasskey}
                className="px-3 py-1.5 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 flex items-center gap-2"
              >
                {isDeletingPasskey && (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-main text-white hover:opacity-90 disabled:opacity-50 text-sm"
          >
            {isRegisteringPasskey ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {isRegisteringPasskey
              ? t('account.addingPasskey')
              : t('account.addPasskey')}
          </button>
        )}
      </div>

      {/* Danger Zone */}
      <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-6">
        <h2 className="text-xl font-bold text-red-400 mb-4 flex items-center gap-2">
          <Trash2 className="w-5 h-5" />
          {t('account.dangerZoneTitle')}
        </h2>
        <p className="text-gray-500 dark:text-lighttext2 mb-4">
          {t('account.dangerZoneDesc')}
        </p>

        {showDeleteConfirm ? (
          <div className="space-y-4">
            <div className="bg-gray-100 dark:bg-darkestgray rounded-lg p-4 border border-red-500/50">
              <p className="text-red-400 font-semibold mb-2">
                {t('account.confirmDeleteTitle')}
              </p>
              <p className="text-gray-500 dark:text-lighttext2 text-sm">
                {t('account.confirmDeleteDesc')}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={isDeleting}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {t('account.deleting')}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
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
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-darkgray dark:hover:bg-darkergray text-darktext dark:text-lighttext font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 hover:text-red-300 font-medium rounded-lg transition-colors border border-red-500/50"
          >
            <Trash2 className="w-4 h-4" />
            {t('account.deleteAccount')}
          </button>
        )}
      </div>
    </div>
  );
}

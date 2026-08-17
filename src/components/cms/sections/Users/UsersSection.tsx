'use client';

import {
  Camera,
  Check,
  Crown,
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
import { GithubIcon } from '@/components/common/BrandIcons';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import {
  updateUserDisplayName,
  uploadUserAvatar,
  usersActions,
} from '@/app/actions/cms/sections/usersActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
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
  const [uploadingAvatarFor, setUploadingAvatarFor] = useState<string | null>(null);
  const [editingNameFor, setEditingNameFor] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');
  const [savingNameFor, setSavingNameFor] = useState<string | null>(null);
  const [updatingRoleFor, setUpdatingRoleFor] = useState<number | null>(null);
  const fileInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const isAdmin = user?.role === 'admin';

  useEffect(() => { fetchUsers(); }, []);

  const fetchUsers = async () => {
    setIsLoading(true); setError(null);
    try {
      const r = await usersActions({ type: 'GET' });
      if (!r.success) throw new Error(r.error || 'Failed');
      setUsers(r.data as AllowedUser[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally { setIsLoading(false); }
  };

  const handleAddUser = async () => {
    if (!newUserInput.trim() && addType !== 'dummy') { setError(t('users.errorEnterEmailOrGithub')); return; }
    if (addType === 'dummy' && !newUserInput.trim()) { setError(t('users.errorEnterDisplayName')); return; }
    setIsSubmitting(true); setError(null);
    try {
      let result: Awaited<ReturnType<typeof usersActions>>;
      if (addType === 'email') result = await usersActions({ type: 'ADD_EMAIL', email: newUserInput, role: newUserRole });
      else if (addType === 'github') result = await usersActions({ type: 'ADD_GITHUB', github_username: newUserInput, role: newUserRole });
      else result = await usersActions({ type: 'ADD_DUMMY', display_name: newUserInput, role: newUserRole });
      if (!result.success) throw new Error(result.error || 'Failed');
      setNewUserInput(''); setIsAdding(false); await fetchUsers();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setIsSubmitting(false); }
  };

  const handleUpdateRole = async (id: number, newRole: 'admin' | 'editor') => {
    setError(null); setUpdatingRoleFor(id);
    try {
      const r = await usersActions({ type: 'UPDATE_ROLE', id, role: newRole });
      if (!r.success) throw new Error(r.error);
      await fetchUsers();
    } catch (err) { setError(err instanceof Error ? err.message : t('users.errorUpdateRole')); }
    finally { setUpdatingRoleFor(null); }
  };

  const handleRemoveUser = async (id: number) => {
    try {
      const r = await usersActions({ type: 'REMOVE', id });
      if (!r.success) throw new Error(r.error);
      await fetchUsers();
    } catch (err) { setError(err instanceof Error ? err.message : t('users.errorRemoveUser')); }
  };

  const handleAvatarChange = async (profileId: string, file: File) => {
    setUploadingAvatarFor(profileId); setError(null);
    try {
      const processed = await processImageToWebP(file, { maxWidth: 256, maxHeight: 256, quality: 0.85 });
      if (!processed.success || !processed.file) throw new Error(processed.error || 'Failed');
      const fd = new FormData(); fd.append('profileId', profileId); fd.append('avatar', processed.file);
      const r = await uploadUserAvatar(fd);
      if (!r.success) throw new Error(r.error);
      await fetchUsers();
    } catch (err) { setError(err instanceof Error ? err.message : t('users.errorUploadAvatar')); }
    finally { setUploadingAvatarFor(null); }
  };

  const handleSaveName = async (profileId: string) => {
    if (!editedName.trim()) return;
    setSavingNameFor(profileId); setError(null);
    try {
      const r = await updateUserDisplayName(profileId, editedName.trim());
      if (!r.success) throw new Error(r.error);
      setEditingNameFor(null); setEditedName('');
      await new Promise((res) => setTimeout(res, 100));
      await fetchUsers();
    } catch (err) { setError(err instanceof Error ? err.message : t('users.errorUpdateName')); await fetchUsers(); }
    finally { setSavingNameFor(null); }
  };

  const inputClass = 'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none';

  if (isLoading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" /></div>;

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader title={t('users.title')} description={t('users.subtitle')} />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {!isAdmin && (
        <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4 text-center">
          <Shield className="w-6 h-6 mx-auto mb-2 text-yellow-500" />
          <p className="text-yellow-500">{t('users.adminRequired')}</p>
        </div>
      )}

      {isAdmin && (
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg md:text-xl font-bold text-main flex items-center gap-2"><Plus className="w-5 h-5" />{t('users.addNewUserTitle')}</h2>
            {!isAdding && <button type="button" onClick={() => setIsAdding(true)} className="flex items-center gap-2 px-4 py-2 bg-main hover:bg-secondary text-white rounded-lg"><Plus className="w-4 h-4" />{t('users.addUser')}</button>}
          </div>

          {isAdding && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {(['email', 'github', 'dummy'] as const).map((type) => (
                  <button key={type} type="button" onClick={() => setAddType(type)} className={`px-4 py-2 rounded-lg transition-colors ${addType === type ? 'bg-main text-white' : 'bg-white dark:bg-darkestgray text-gray-500 dark:text-lighttext2 hover:bg-gray-100'}`}>
                    {type === 'email' && <><Mail className="w-4 h-4 inline mr-1" />{t('users.emailInvite')}</>}
                    {type === 'github' && <><GithubIcon className="w-4 h-4 inline mr-1" />{t('users.githubUsername')}</>}
                    {type === 'dummy' && <><User className="w-4 h-4 inline mr-1" />{t('users.dummyUser')}</>}
                  </button>
                ))}
              </div>
              <div className="grid md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <input type={addType === 'email' ? 'email' : 'text'} value={newUserInput} onChange={(e) => setNewUserInput(e.target.value)} className={inputClass}
                    placeholder={addType === 'email' ? t('users.emailPlaceholder') : addType === 'github' ? t('users.githubPlaceholder') : t('users.displayNamePlaceholder')} />
                </div>
                <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as 'admin' | 'editor')} className={inputClass}>
                  <option value="editor">{t('users.roleEditor')}</option>
                  <option value="admin">{t('users.roleAdmin')}</option>
                </select>
              </div>
              <p className="text-xs text-gray-500 dark:text-lighttext2">
                {addType === 'email' ? t('users.emailInviteInfo') : addType === 'github' ? t('users.githubInviteInfo') : t('users.dummyUserInfo')}
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={handleAddUser} disabled={isSubmitting} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50"><UserCheck className="w-4 h-4 inline mr-1" />{isSubmitting ? t('users.adding') : t('users.addUser')}</button>
                <button type="button" onClick={() => { setIsAdding(false); setNewUserInput(''); setError(null); }} className="px-4 py-2 bg-white dark:bg-darkestgray text-darktext dark:text-lighttext rounded-lg"><X className="w-4 h-4 inline mr-1" />{t('common.cancel')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <h2 className="text-lg md:text-xl font-bold text-main mb-4 flex items-center gap-2"><Users className="w-5 h-5" />{t('users.allowedUsersTitle')} ({users.length})</h2>
        {users.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-lighttext2">{t('users.noUsersYet')}</div>
        ) : (
          <div className="space-y-3">
            {users.map((au) => {
              const hasProfile = !!au.profile;
              const isCurrentUser = user && ((user.email && au.email?.toLowerCase() === user.email.toLowerCase()) || (user.githubUsername && au.github_username === user.githubUsername) || (user.id && au.profile?.id === user.id));
              const adminCount = users.filter((u) => u.role === 'admin').length;
              const isLastAdmin = au.role === 'admin' && adminCount === 1;
              const isDummy = au.email?.startsWith('dummy-');
              const isEditing = editingNameFor === au.profile?.id;
              const isUploading = uploadingAvatarFor === au.profile?.id;

              return (
                <div key={au.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white dark:bg-darkestgray rounded-lg p-4">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {hasProfile && isAdmin && !isCurrentUser ? (
                      <>
                        <button type="button" onClick={() => { const inp = fileInputRefs.current.get(au.profile!.id); inp?.click(); }} disabled={isUploading} className="relative w-10 h-10 rounded-full overflow-hidden bg-gray-200 dark:bg-darkgray flex-shrink-0 group cursor-pointer">
                          {au.profile?.avatar_url ? <Image src={au.profile.avatar_url} alt="" fill sizes="40px" className="object-cover" />
                          : <div className="w-full h-full flex items-center justify-center bg-main text-white font-bold">{(au.profile?.display_name || 'U').charAt(0).toUpperCase()}</div>}
                          <div className={`absolute inset-0 bg-black/60 flex items-center justify-center transition-opacity ${isUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                            {isUploading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Camera className="w-4 h-4 text-white" />}
                          </div>
                        </button>
                        <input ref={(el) => { if (el && au.profile?.id) fileInputRefs.current.set(au.profile.id, el); }} type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f && au.profile?.id) handleAvatarChange(au.profile.id, f); e.target.value = ''; }} className="hidden" />
                      </>
                    ) : hasProfile ? (
                      <div className="relative w-10 h-10 rounded-full overflow-hidden bg-gray-200 dark:bg-darkgray flex-shrink-0">
                        {au.profile?.avatar_url ? <Image src={au.profile.avatar_url} alt="" fill sizes="40px" className="object-cover" />
                        : <div className="w-full h-full flex items-center justify-center bg-main text-white font-bold">{(au.profile?.display_name || 'U').charAt(0).toUpperCase()}</div>}
                      </div>
                    ) : (
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${au.github_username ? 'bg-gray-700' : 'bg-blue-600/20'}`}>
                        {au.github_username ? <GithubIcon className="w-5 h-5 text-white" /> : <Mail className="w-5 h-5 text-blue-400" />}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input type="text" value={editedName} onChange={(e) => setEditedName(e.target.value)} className="w-28 px-1 py-0.5 text-sm bg-gray-100 dark:bg-darkgray border border-main rounded text-darktext dark:text-lighttext focus:outline-none" onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(au.profile!.id); if (e.key === 'Escape') { setEditingNameFor(null); setEditedName(''); } }} />
                            <button type="button" onClick={() => handleSaveName(au.profile!.id)} disabled={savingNameFor === au.profile?.id} className="p-0.5 text-green-400"><Check className="w-4 h-4" /></button>
                            <button type="button" onClick={() => { setEditingNameFor(null); setEditedName(''); }} className="p-0.5 text-red-400"><X className="w-4 h-4" /></button>
                          </div>
                        ) : (
                          <>
                            <span className="font-medium text-darktext dark:text-lighttext truncate">{au.profile?.display_name || (!isDummy && au.email) || (au.github_username ? `@${au.github_username}` : 'Unknown')}</span>
                            {hasProfile && isAdmin && !isCurrentUser && <button type="button" onClick={() => { setEditingNameFor(au.profile!.id); setEditedName(au.profile?.display_name || ''); }} className="p-0.5 text-gray-500 hover:text-main"><Pencil className="w-3 h-3" /></button>}
                          </>
                        )}
                        {au.role === 'admin' && !isEditing && <Crown className="w-4 h-4 text-yellow-500" />}
                        {isCurrentUser && <span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400">{t('users.you')}</span>}
                        {isDummy && <span className="px-2 py-0.5 rounded text-xs bg-purple-500/20 text-purple-400">Dummy</span>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-lighttext2">
                        <span className={`px-2 py-0.5 rounded ${au.role === 'admin' ? 'bg-yellow-500/20 text-yellow-500' : 'bg-blue-500/20 text-blue-400'}`}>{au.role}</span>
                        {isLastAdmin && !isCurrentUser && <span className="text-yellow-500">{t('users.lastAdminWarning')}</span>}
                        {!hasProfile && !isDummy && <span className="text-yellow-500">{t('users.notLoggedInYet')}</span>}
                        {au.github_username && <span><GithubIcon className="w-3 h-3 inline mr-1" />@{au.github_username}</span>}
                      </div>
                    </div>
                  </div>
                  {isAdmin && !isCurrentUser && (
                    <div className="flex items-center gap-2">
                      <select value={au.role} onChange={(e) => { const nr = e.target.value as 'admin' | 'editor'; if (isLastAdmin && nr === 'editor') { setError(t('users.cannotDemoteLastAdmin')); return; } handleUpdateRole(au.id, nr); }} disabled={updatingRoleFor === au.id} className={`${inputClass} w-auto`}>
                        <option value="editor" disabled={isLastAdmin}>{t('users.roleEditor')}</option>
                        <option value="admin">{t('users.roleAdmin')}</option>
                      </select>
                      <button type="button" onClick={() => handleRemoveUser(au.id)} className="p-2 text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

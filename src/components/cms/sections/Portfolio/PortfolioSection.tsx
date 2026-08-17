'use client';

import { Calendar, Eye, FileText, Plus, Trash2, X, Edit3, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { portfolioActions, type Author } from '@/app/actions/cms/sections/portfolioActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useCmsStore } from '@/store/cmsStore';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { PortfolioPreview } from '@/components/common/cms/previews/PortfolioPreview';
import { PostPreview } from '@/components/common/cms/previews/PostPreview';
import { ListPostImage } from '@/components/common/cms/ListPostImage';
import type { PortfolioPost } from '@/types/fetchedData.types';

type FormMode = 'list' | 'create' | 'edit';
type EditablePost = PortfolioPost & { image_file?: File | null };

interface PortfolioFormData {
  title_en: string; title_it: string; image: string; blurhashURL: string;
  description_en: string; description_it: string; body_en: string; body_it: string;
  source_link: string; demo_link: string; store_link: string;
  fdroid_link: string; website: string; ios_store_link: string;
  post_tags: string; created_at: string; author_id: string; hidden: boolean;
}

const emptyForm: PortfolioFormData = {
  title_en: '', title_it: '', image: '', blurhashURL: '', description_en: '', description_it: '',
  body_en: '', body_it: '', source_link: '', demo_link: '', store_link: '',
  fdroid_link: '', website: '', ios_store_link: '',
  post_tags: '', created_at: new Date().toISOString().split('T')[0], author_id: '', hidden: false,
};

export default function PortfolioSection() {
  const t = useTranslations('cms');
  const { user } = useCmsStore();
  const [posts, setPosts] = useState<EditablePost[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_isUpdating, setIsUpdating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPostPreviewOpen, setIsPostPreviewOpen] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [mode, setMode] = useState<FormMode>('list');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<PortfolioFormData>(emptyForm);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');
  const [formLocale, setFormLocale] = useState<'en' | 'it'>('en');
  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newPosts, setNewPosts] = useState<Array<{ post: EditablePost; imageFile: File | null }>>([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  const imgUpload = useFileUpload({ accept: 'image/*', maxSizeMB: 10, imageProcessing: { maxWidth: 1920, maxHeight: 1080, quality: 0.85 }, generateBlurhash: true });

  const { isDirty: transDirty, isLoading: transLoading, getField, setField, saveTranslations, revertTranslations } = useSectionTranslations('posts-section');

  const isDirty = modifiedIds.size > 0 || newPosts.length > 0 || deletedIds.size > 0 || transDirty;
  useSectionDirty('portfolio', isDirty);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try { const r = await portfolioActions({ type: 'GET' }); if (r.success) setPosts((r.data as PortfolioPost[]).map((p) => ({ ...p, image_file: null }))); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setIsLoading(false); }
    try { const ar = await portfolioActions({ type: 'GET_AUTHORS' }); if (ar.success) setAuthors(ar.data as Author[]); } catch {}
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openCreate = () => {
    setFormData({ ...emptyForm, author_id: user?.id ?? '' });
    imgUpload.clearFile();
    setEditingId(null);
    setFormLocale(activeLocale);
    setMode('create');
  };
  const openEdit = (post: EditablePost) => {
    setFormData({ title_en: post.title_en ?? '', title_it: post.title_it ?? '', image: post.image ?? '', blurhashURL: post.blurhashURL ?? '', description_en: post.description_en ?? '', description_it: post.description_it ?? '', body_en: post.body_en ?? '', body_it: post.body_it ?? '', source_link: post.source_link ?? '', demo_link: post.demo_link ?? '', store_link: post.store_link ?? '', fdroid_link: post.fdroid_link ?? '', website: post.website ?? '', ios_store_link: post.ios_store_link ?? '', post_tags: post.post_tags ?? '', created_at: post.created_at?.split('T')[0] ?? '', author_id: post.author_id ?? user?.id ?? '', hidden: post.hidden ?? false });
    imgUpload.clearFile(); setEditingId(post.id); setFormLocale(activeLocale); setMode('edit');
  };
  const closeForm = () => { setMode('list'); imgUpload.clearFile(); setEditingId(null); };

  const handleCreate = () => {
    if (!formData.title_en || !imgUpload.file) { setError('Title and image are required'); return; }
    const tempId = -Date.now();
    const post: EditablePost = { id: tempId, ...formData, blurhashURL: imgUpload.blurhash || formData.blurhashURL, views: 0, image_file: imgUpload.file };
    setPosts((prev) => [...prev, post]);
    setNewPosts((prev) => [...prev, { post, imageFile: imgUpload.file }]);
    closeForm();
  };

  const handleUpdate = () => {
    if (!editingId) return;
    setPosts((prev) => prev.map((p) => p.id === editingId ? { ...p, ...formData, blurhashURL: imgUpload.blurhash || formData.blurhashURL, image_file: imgUpload.file || p.image_file } : p));
    setModifiedIds((prev) => new Set(prev).add(editingId));
    closeForm();
  };

  const handleDelete = (id: number) => {
    const isNew = newPosts.some((n) => n.post.id === id);
    if (isNew) setNewPosts((prev) => prev.filter((n) => n.post.id !== id));
    else setDeletedIds((prev) => new Set(prev).add(id));
    setPosts((prev) => prev.filter((p) => p.id !== id));
  };

  const handlePublish = useCallback(async () => {
    const errors: string[] = []; setIsUpdating(true); setError(null);

    const batch = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: newPosts
        .filter((item): item is { post: EditablePost; imageFile: File } => item.imageFile !== null)
        .map(({ post, imageFile }) => ({
          file: imageFile,
          blurhashURL: post.blurhashURL,
          data: {
            title_en: post.title_en,
            title_it: post.title_it,
            image: '',
            source_link: post.source_link,
            demo_link: post.demo_link,
            description_en: post.description_en,
            description_it: post.description_it,
            body_en: post.body_en,
            body_it: post.body_it,
            blurhashURL: post.blurhashURL || '',
            post_tags: post.post_tags,
            store_link: post.store_link,
            fdroid_link: post.fdroid_link,
            website: post.website,
            ios_store_link: post.ios_store_link,
            created_at: post.created_at,
            author_id: post.author_id || user?.id || '',
            hidden: post.hidden ?? false,
          },
        })),
      updates: Array.from(modifiedIds).flatMap((id) => {
        const post = posts.find((p) => p.id === id);
        if (!post) return [];
        return [{
          id,
          file: post.image_file || null,
          currentImageUrl: post.image,
          blurhashURL: post.blurhashURL,
          data: {
            title_en: post.title_en,
            title_it: post.title_it,
            description_en: post.description_en,
            description_it: post.description_it,
            body_en: post.body_en,
            body_it: post.body_it,
            source_link: post.source_link,
            demo_link: post.demo_link,
            store_link: post.store_link,
            fdroid_link: post.fdroid_link,
            website: post.website,
            ios_store_link: post.ios_store_link,
            post_tags: post.post_tags,
            created_at: post.created_at,
            author_id: post.author_id,
            hidden: post.hidden ?? false,
          },
        }];
      }),
      deletes: Array.from(deletedIds),
    });
    if (!batch.success && batch.error) errors.push(batch.error);

    if (transDirty) { const te = await saveTranslations(); errors.push(...te); }
    await fetchData();
    setModifiedIds(new Set()); setNewPosts([]); setDeletedIds(new Set()); setIsUpdating(false);
    if (errors.length > 0) setError(errors.join('\n'));
  }, [
    posts,
    newPosts,
    deletedIds,
    modifiedIds,
    transDirty,
    saveTranslations,
    fetchData,
    user,
  ]);

  const handleRevert = () => { setShowConfirmRevert(false); fetchData(); setModifiedIds(new Set()); setNewPosts([]); setDeletedIds(new Set()); revertTranslations(); setError(null); };

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const inputClass = 'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none';

  if (isLoading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" /></div>;

  if (mode === 'create' || mode === 'edit') {
    const isEditing = mode === 'edit';
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-darktext dark:text-lighttext">{isEditing ? t('portfolio.editPost') : t('portfolio.createNewPost')}</h2>
          <div className="flex items-center gap-3">
            <LocaleToggle activeLocale={formLocale} onChange={setFormLocale} />
            <button type="button" onClick={closeForm} className="flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-darkergray rounded-lg text-darktext dark:text-lighttext hover:bg-gray-300"><X className="w-4 h-4" />{t('common.cancel')}</button>
          </div>
        </div>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        {/* Content */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('common.content')}</h3>
          <TranslationField label={t('portfolio.titleEnLabel')} enValue={formData.title_en} itValue={formData.title_it} onChangeEn={(v) => setFormData((p) => ({ ...p, title_en: v }))} onChangeIt={(v) => setFormData((p) => ({ ...p, title_it: v }))} required activeLocale={formLocale} />
          <TranslationField label={t('portfolio.descriptionEnLabel')} enValue={formData.description_en} itValue={formData.description_it} onChangeEn={(v) => setFormData((p) => ({ ...p, description_en: v }))} onChangeIt={(v) => setFormData((p) => ({ ...p, description_it: v }))} type="textarea" rows={3} activeLocale={formLocale} />
          <TranslationField label={t('portfolio.bodyEnLabel')} enValue={formData.body_en} itValue={formData.body_it} onChangeEn={(v) => setFormData((p) => ({ ...p, body_en: v }))} onChangeIt={(v) => setFormData((p) => ({ ...p, body_it: v }))} type="textarea" rows={8} activeLocale={formLocale} />
          <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-lighttext2 bg-white dark:bg-darkestgray rounded-lg p-3 border border-gray-200 dark:border-darkgray/50">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p><code className="text-main bg-main/10 px-1 rounded">****text****</code> {t('portfolio.syntaxHighlight')}</p>
              <p><code className="text-main bg-main/10 px-1 rounded">![alt-blurhash](url)</code> {t('portfolio.syntaxImage')}</p>
            </div>
          </div>
        </div>

        {/* Links */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('portfolio.sourceLinkLabel')}</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('portfolio.sourceLinkLabel')}</label>
              <input type="url" value={formData.source_link} onChange={(e) => setFormData((p) => ({ ...p, source_link: e.target.value }))} className={inputClass} placeholder={t('portfolio.sourceLinkPlaceholder')} />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('portfolio.demoLinkLabel')}</label>
              <input type="url" value={formData.demo_link} onChange={(e) => setFormData((p) => ({ ...p, demo_link: e.target.value }))} className={inputClass} placeholder={t('portfolio.demoLinkPlaceholder')} />
            </div>
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('portfolio.storeLinkLabel')}</label>
              <input type="url" value={formData.store_link} onChange={(e) => setFormData((p) => ({ ...p, store_link: e.target.value }))} className={inputClass} placeholder={t('portfolio.storeLinkPlaceholder')} />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">F-Droid</label>
              <input type="url" value={formData.fdroid_link} onChange={(e) => setFormData((p) => ({ ...p, fdroid_link: e.target.value }))} className={inputClass} placeholder="https://f-droid.org/..." />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">iOS App Store</label>
              <input type="url" value={formData.ios_store_link} onChange={(e) => setFormData((p) => ({ ...p, ios_store_link: e.target.value }))} className={inputClass} placeholder="https://apps.apple.com/..." />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">Website</label>
            <input type="url" value={formData.website} onChange={(e) => setFormData((p) => ({ ...p, website: e.target.value }))} className={inputClass} placeholder="https://..." />
          </div>
        </div>

        {/* Metadata */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('common.configuration')}</h3>
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">Tags</label>
              <input type="text" value={formData.post_tags} onChange={(e) => setFormData((p) => ({ ...p, post_tags: e.target.value }))} className={inputClass} placeholder={t('portfolio.tagsPlaceholder')} />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">Date</label>
              <input type="date" value={formData.created_at} onChange={(e) => setFormData((p) => ({ ...p, created_at: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">Author</label>
              <select value={formData.author_id} onChange={(e) => setFormData((p) => ({ ...p, author_id: e.target.value }))} className={inputClass}>
                <option value="">Select</option>
                {authors.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-darktext dark:text-lighttext cursor-pointer">
            <input
              type="checkbox"
              checked={formData.hidden}
              onChange={(e) => setFormData((p) => ({ ...p, hidden: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 dark:border-lighttext2/30 text-main focus:ring-main"
            />
            Hidden
          </label>
        </div>

        {/* Media */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('portfolio.selectImage')}</h3>
          <FileDropzone
            label="Image"
            previewUrl={imgUpload.previewUrl}
            blurhash={imgUpload.blurhash}
            isDragging={imgUpload.isDragging}
            isProcessing={imgUpload.isProcessing}
            error={imgUpload.error}
            currentUrl={isEditing ? formData.image : undefined}
            dropzoneProps={{ onDragOver: imgUpload.dropzoneProps.onDragOver, onDragLeave: imgUpload.dropzoneProps.onDragLeave, onDrop: imgUpload.dropzoneProps.onDrop }}
            fileInputProps={imgUpload.fileInputProps}
            fileInputRef={imgUpload.fileInputRef}
            onClear={imgUpload.clearFile}
            onBrowse={imgUpload.openFileDialog}
          />
        </div>

        <div className="flex gap-3 pt-4">
          <button type="button" onClick={closeForm} className="px-4 py-2 bg-gray-600 text-white rounded-lg">{t('common.cancel')}</button>
          <button type="button" onClick={() => setIsPostPreviewOpen(true)} className="px-4 py-2 bg-secondary text-white rounded-lg"><Eye className="w-4 h-4 inline mr-1" />{t('portfolio.previewPost')}</button>
          <button type="button" onClick={isEditing ? handleUpdate : handleCreate} className="px-4 py-2 bg-main text-white rounded-lg">{t('common.done')}</button>
        </div>

        <PreviewModal isOpen={isPostPreviewOpen} onClose={() => setIsPostPreviewOpen(false)} title={t('portfolio.postPreviewTitle')}>
          <PostPreview formData={formData} postType="portfolio" locale="en" imageFile={imgUpload.file} author={authors.find((a) => a.id === formData.author_id) || null} views={isEditing ? posts.find((p) => p.id === editingId)?.views || 0 : 0} />
        </PreviewModal>
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader title={t('portfolio.title')} description={t('portfolio.subtitle')} />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-main">{t('common.translations')}</h2>
          <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
        </div>
        {transLoading ? <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-main" /></div> : (
          <div className="space-y-4">
            <TranslationField label={t('portfolio.translationTitleLabel')} enValue={getField('en', 'title2')} itValue={getField('it', 'title2')} onChangeEn={(v) => setField('en', 'title2', v)} onChangeIt={(v) => setField('it', 'title2', v)} activeLocale={activeLocale} />
            <TranslationField label={t('portfolio.translationSubtitleLabel')} enValue={getField('en', 'subtitle2')} itValue={getField('it', 'subtitle2')} onChangeEn={(v) => setField('en', 'subtitle2', v)} onChangeIt={(v) => setField('it', 'subtitle2', v)} type="textarea" rows={3} activeLocale={activeLocale} />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-darktext dark:text-lighttext">{t('portfolio.postsTitle')}</h2>
        <button type="button" onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-main hover:bg-secondary text-white rounded-lg"><Plus className="w-4 h-4" />{t('portfolio.addPortfolioPost')}</button>
      </div>

      {posts.length === 0 ? (
        <EmptyState icon={FileText} message={t('portfolio.noPortfolioPosts')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {posts.map((post) => (
            <div key={post.id} className="bg-gray-100 dark:bg-darkergray rounded-xl overflow-hidden border-2 border-main/20">
              <ListPostImage imageFile={post.image_file} imageUrl={post.image} blurhashURL={post.blurhashURL} alt={post.title_en} />
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-darktext dark:text-lighttext truncate">{post.title_en}</h3>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => openEdit(post)} className="p-1 text-main hover:text-secondary"><Edit3 className="w-4 h-4" /></button>
                    <button type="button" onClick={() => handleDelete(post.id)} className="p-1 text-red-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
                <p className="text-sm text-darktext dark:text-lighttext2 mb-2 line-clamp-2">{post.description_en}</p>
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-lighttext2">
                  <Calendar className="w-3 h-3" /><span>{new Date(post.created_at).toLocaleDateString()}</span>
                  <FileText className="w-3 h-3" /><span>{post.views} views</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog isOpen={showConfirmRevert} title={t('common.revertAll')} message={t('common.confirmRevertAll')} confirmLabel={t('common.revert')} confirmVariant="primary" onConfirm={handleRevert} onCancel={() => setShowConfirmRevert(false)} />
      <PreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} title={t('portfolio.previewTitle')}><PortfolioPreview posts={posts} deletedPostIds={deletedIds} /></PreviewModal>
    </div>
  );
}

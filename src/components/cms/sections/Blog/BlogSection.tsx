'use client';

import {
  Calendar,
  Edit3,
  Eye,
  FileText,
  Info,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import {
  type Author,
  blogActions,
} from '@/app/actions/cms/sections/blogActions';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { ListPostImage } from '@/components/common/cms/ListPostImage';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { BlogPreview } from '@/components/common/cms/previews/BlogPreview';
import { PostPreview } from '@/components/common/cms/previews/PostPreview';
import {
  mergeServerWithDrafts,
  readBatchEvidence,
  reconcileDrafts,
} from '@/hooks/cms/batchDrafts';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import type { BlogPost } from '@/types/fetchedData.types';

type FormMode = 'list' | 'create' | 'edit';
type EditablePost = BlogPost & { image_file?: File | null };

interface BlogFormData {
  title_en: string;
  title_it: string;
  image: string;
  blurhashURL: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  post_tags: string;
  created_at: string;
  author_id: string;
  hidden: boolean;
}

const emptyForm: BlogFormData = {
  title_en: '',
  title_it: '',
  image: '',
  blurhashURL: '',
  description_en: '',
  description_it: '',
  body_en: '',
  body_it: '',
  post_tags: '',
  created_at: new Date().toISOString().split('T')[0],
  author_id: '',
  hidden: false,
};

export default function BlogSection() {
  const t = useTranslations('cms');
  const { user } = useCmsStore();
  const [posts, setPosts] = useState<EditablePost[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPostPreviewOpen, setIsPostPreviewOpen] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [mode, setMode] = useState<FormMode>('list');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<BlogFormData>(emptyForm);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');
  const [formLocale, setFormLocale] = useState<'en' | 'it'>('en');
  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newPosts, setNewPosts] = useState<
    Array<{ post: EditablePost; imageFile: File | null }>
  >([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  const imgUpload = useFileUpload({
    accept: 'image/*',
    maxSizeMB: 10,
    imageProcessing: { maxWidth: 1920, maxHeight: 1080, quality: 0.85 },
    generateBlurhash: true,
  });

  const {
    translations,
    isDirty: transDirty,
    isLoading: transLoading,
    error: transError,
    canEditTranslations,
    getField,
    setField,
    saveTranslations,
    revertTranslations,
  } = useSectionTranslations('posts-section');

  const isDirty =
    modifiedIds.size > 0 ||
    newPosts.length > 0 ||
    deletedIds.size > 0 ||
    transDirty;
  useSectionDirty('blog', isDirty);

  const beginLoad = useLatestRequest();
  const fetchData = useCallback(
    async (drafts?: {
      creates: EditablePost[];
      modified: ReadonlyMap<number, EditablePost>;
      deletedIds: ReadonlySet<number>;
    }) => {
      const current = beginLoad();
      setIsLoading(true);
      try {
        const r = await blogActions({ type: 'GET' });
        if (!current()) return;
        if (r.success) {
          const server = (r.data as BlogPost[]).map((p) => ({
            ...p,
            image_file: null,
          }));
          setPosts(drafts ? mergeServerWithDrafts(server, drafts) : server);
        }
      } catch (err) {
        if (current()) setError(err instanceof Error ? err.message : 'Failed');
      } finally {
        if (current()) setIsLoading(false);
      }
      try {
        const ar = await blogActions({ type: 'GET_AUTHORS' });
        if (current() && ar.success) setAuthors(ar.data as Author[]);
      } catch {}
    },
    [beginLoad]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreate = () => {
    setFormData({ ...emptyForm, author_id: user?.id ?? '' });
    imgUpload.clearFile();
    setEditingId(null);
    setFormLocale(activeLocale);
    setMode('create');
  };
  const openEdit = (post: EditablePost) => {
    setFormData({
      title_en: post.title_en ?? '',
      title_it: post.title_it ?? '',
      image: post.image ?? '',
      blurhashURL: post.blurhashURL ?? '',
      description_en: post.description_en ?? '',
      description_it: post.description_it ?? '',
      body_en: post.body_en ?? '',
      body_it: post.body_it ?? '',
      post_tags: post.post_tags ?? '',
      created_at: post.created_at?.split('T')[0] ?? '',
      author_id: post.author_id ?? user?.id ?? '',
      hidden: post.hidden ?? false,
    });
    imgUpload.clearFile();
    setEditingId(post.id);
    setFormLocale(activeLocale);
    setMode('edit');
  };
  const closeForm = () => {
    setMode('list');
    imgUpload.clearFile();
    setEditingId(null);
  };

  const handleCreate = () => {
    if (!formData.title_en || !imgUpload.file) {
      setError('Title and image are required');
      return;
    }
    const tempId = -Date.now();
    const post: EditablePost = {
      id: tempId,
      title: formData.title_en,
      ...formData,
      blurhashURL: imgUpload.blurhash || formData.blurhashURL,
      views: 0,
      image_file: imgUpload.file,
    };
    setPosts((prev) => [...prev, post]);
    setNewPosts((prev) => [...prev, { post, imageFile: imgUpload.file }]);
    closeForm();
  };

  const handleUpdate = () => {
    if (!editingId) return;
    setPosts((prev) =>
      prev.map((p) =>
        p.id === editingId
          ? {
              ...p,
              ...formData,
              blurhashURL: imgUpload.blurhash || formData.blurhashURL,
              image_file: imgUpload.file || p.image_file,
            }
          : p
      )
    );
    setModifiedIds((prev) => new Set(prev).add(editingId));
    closeForm();
  };

  const handleDelete = (id: number) => {
    const isNew = newPosts.some((n) => n.post.id === id);
    if (isNew) {
      setNewPosts((prev) => prev.filter((n) => n.post.id !== id));
    } else {
      setDeletedIds((prev) => new Set(prev).add(id));
    }
    // A deleted row must not survive as a pending modification.
    setModifiedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPosts((prev) => prev.filter((p) => p.id !== id));
  };

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    setIsUpdating(true);
    setError(null);

    // Pending creates may have been edited after creation: always derive the
    // payload from the latest `posts` entry, never the stale newPosts snapshot.
    const createTempIds = newPosts.map((item) => String(item.post.id));
    const creates = newPosts.flatMap((item) => {
      const post = posts.find((p) => p.id === item.post.id) ?? item.post;
      const file = post.image_file ?? item.imageFile;
      if (!file) return [];
      return [
        {
          tempId: String(item.post.id),
          file,
          blurhashURL: post.blurhashURL,
          data: {
            title_en: post.title_en,
            title_it: post.title_it,
            image: '',
            description_en: post.description_en,
            description_it: post.description_it,
            body_en: post.body_en,
            body_it: post.body_it,
            blurhashURL: post.blurhashURL || '',
            post_tags: post.post_tags,
            created_at: post.created_at,
            author_id: post.author_id || user?.id || '',
            hidden: post.hidden ?? false,
          },
        },
      ];
    });
    // Negative ids are pending creates, not updates.
    const updateIds = Array.from(modifiedIds).filter((id) => id > 0);
    const updates = updateIds.flatMap((id) => {
      const post = posts.find((p) => p.id === id);
      if (!post) return [];
      return [
        {
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
            post_tags: post.post_tags,
            created_at: post.created_at,
            author_id: post.author_id,
            hidden: post.hidden ?? false,
          },
        },
      ];
    });
    const deleteIds = Array.from(deletedIds);

    try {
      let retainedCreates = createTempIds;
      let retainedUpdates = updateIds;
      let retainedDeletes = deleteIds;

      const batch = await blogActions({
        type: 'BATCH_PUBLISH',
        creates,
        updates,
        deletes: deleteIds,
      });

      const evidence = readBatchEvidence(batch.data);
      if (!batch.success) {
        errors.push(batch.error || 'Failed to publish');
      }
      if (!evidence) {
        errors.push('Publish response was incomplete; drafts were kept');
      } else {
        const reconcile = reconcileDrafts({
          evidence,
          createTempIds,
          updateIds,
          deleteIds,
        });
        retainedCreates = reconcile.retainedCreates;
        retainedUpdates = reconcile.retainedUpdates as number[];
        retainedDeletes = reconcile.retainedDeletes as number[];
        errors.push(...reconcile.failureMessages);

        // Refetch the server rows and re-apply only the unresolved drafts so
        // committed writes are never overwritten by stale local state.
        const retainedCreateSet = new Set(retainedCreates);
        const retainedModifiedSet = new Set(retainedUpdates);
        const draftCreates = posts.filter((p) =>
          retainedCreateSet.has(String(p.id))
        );
        const draftModified = new Map(
          posts
            .filter((p) => retainedModifiedSet.has(p.id))
            .map((p) => [p.id, p])
        );
        await fetchData({
          creates: draftCreates,
          modified: draftModified,
          deletedIds: new Set(retainedDeletes),
        });

        setNewPosts((prev) =>
          prev.filter((item) => retainedCreateSet.has(String(item.post.id)))
        );
        setModifiedIds(new Set(retainedUpdates));
        setDeletedIds(new Set(retainedDeletes));
      }

      if (transDirty) {
        const te = await saveTranslations();
        errors.push(...te);
      }

      const revalidationMessage = revalidationWarning(batch);
      if (revalidationMessage)
        useCmsStore.getState().setWarning(revalidationMessage);

      const remaining =
        retainedCreates.length +
        retainedUpdates.length +
        retainedDeletes.length +
        (transDirty && !batch.success ? 1 : 0);
      if (!batch.success || remaining > 0 || errors.length > 0) {
        const message = errors.join('\n') || 'Publish did not fully succeed';
        setError(message);
        useCmsStore.getState().setError(message);
      } else {
        useCmsStore.getState().setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to publish';
      setError(message);
      useCmsStore.getState().setError(message);
    } finally {
      setIsUpdating(false);
    }
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

  const handleRevert = () => {
    setShowConfirmRevert(false);
    fetchData();
    setModifiedIds(new Set());
    setNewPosts([]);
    setDeletedIds(new Set());
    revertTranslations();
    setError(null);
  };

  useSectionCallbacks('blog', handlePublish, handleRevert);

  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none';

  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );

  if (mode === 'create' || mode === 'edit') {
    const isEditing = mode === 'edit';
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-text-main ">
            {isEditing ? t('blog.editPost') : t('blog.createNewPost')}
          </h2>
          <div className="flex items-center gap-3">
            <LocaleToggle activeLocale={formLocale} onChange={setFormLocale} />
            <button
              type="button"
              onClick={closeForm}
              className="flex items-center gap-2 px-4 py-2 bg-surface-raised rounded-lg text-text-main hover:bg-surface-raised"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        {/* Content */}
        <div className="bg-surface-card rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-accent-violet">
            {t('common.content')}
          </h3>
          <TranslationField
            label={t('blog.titleEnLabel')}
            enValue={formData.title_en}
            itValue={formData.title_it}
            onChangeEn={(v) => setFormData((p) => ({ ...p, title_en: v }))}
            onChangeIt={(v) => setFormData((p) => ({ ...p, title_it: v }))}
            required
            activeLocale={formLocale}
          />
          <TranslationField
            label={t('blog.descriptionEnLabel')}
            enValue={formData.description_en}
            itValue={formData.description_it}
            onChangeEn={(v) =>
              setFormData((p) => ({ ...p, description_en: v }))
            }
            onChangeIt={(v) =>
              setFormData((p) => ({ ...p, description_it: v }))
            }
            type="textarea"
            rows={3}
            activeLocale={formLocale}
          />
          <TranslationField
            label={t('blog.bodyEnLabel')}
            enValue={formData.body_en}
            itValue={formData.body_it}
            onChangeEn={(v) => setFormData((p) => ({ ...p, body_en: v }))}
            onChangeIt={(v) => setFormData((p) => ({ ...p, body_it: v }))}
            type="textarea"
            rows={8}
            activeLocale={formLocale}
          />
          <div className="flex items-start gap-2 text-xs text-text-muted bg-surface-base rounded-lg p-3 border border-border-subtle ">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                <code className="text-accent-violet bg-accent-violet/10 px-1 rounded">
                  ****text****
                </code>{' '}
                {t('blog.syntaxHighlight')}
              </p>
              <p>
                <code className="text-accent-violet bg-accent-violet/10 px-1 rounded">
                  ![alt-blurhash](url)
                </code>{' '}
                {t('blog.syntaxImage')}
              </p>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div className="bg-surface-card rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-accent-violet">
            {t('common.configuration')}
          </h3>
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">
                Tags
              </label>
              <input
                type="text"
                value={formData.post_tags}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, post_tags: e.target.value }))
                }
                className={inputClass}
                placeholder={t('blog.tagsPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">
                Date
              </label>
              <input
                type="date"
                value={formData.created_at}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, created_at: e.target.value }))
                }
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">
                Author
              </label>
              <select
                value={formData.author_id}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, author_id: e.target.value }))
                }
                className={inputClass}
              >
                <option value="">Select</option>
                {authors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-main cursor-pointer">
            <input
              type="checkbox"
              checked={formData.hidden}
              onChange={(e) =>
                setFormData((p) => ({ ...p, hidden: e.target.checked }))
              }
              className="w-4 h-4 rounded border-border-subtle text-accent-violet focus:ring-accent-violet"
            />
            Hidden
          </label>
        </div>

        {/* Media */}
        <div className="bg-surface-card rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-accent-violet">
            {t('blog.selectImage')}
          </h3>
          <FileDropzone
            label="Image"
            previewUrl={imgUpload.previewUrl}
            blurhash={imgUpload.blurhash}
            isDragging={imgUpload.isDragging}
            isProcessing={imgUpload.isProcessing}
            error={imgUpload.error}
            currentUrl={isEditing ? formData.image : undefined}
            dropzoneProps={{
              onDragOver: imgUpload.dropzoneProps.onDragOver,
              onDragLeave: imgUpload.dropzoneProps.onDragLeave,
              onDrop: imgUpload.dropzoneProps.onDrop,
            }}
            fileInputProps={imgUpload.fileInputProps}
            fileInputRef={imgUpload.fileInputRef}
            onClear={imgUpload.clearFile}
            onBrowse={imgUpload.openFileDialog}
          />
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="button"
            onClick={closeForm}
            className="px-4 py-2 bg-surface-raised text-white rounded-lg"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => setIsPostPreviewOpen(true)}
            className="px-4 py-2 bg-accent-violet-deep text-white rounded-lg"
          >
            <Eye className="w-4 h-4 inline mr-1" />
            {t('blog.previewPost')}
          </button>
          <button
            type="button"
            onClick={isEditing ? handleUpdate : handleCreate}
            className="px-4 py-2 bg-accent-violet text-white rounded-lg"
          >
            {t('common.done')}
          </button>
        </div>

        <PreviewModal
          isOpen={isPostPreviewOpen}
          onClose={() => setIsPostPreviewOpen(false)}
          title={t('blog.postPreviewTitle')}
          copy={{
            locale: formLocale,
            namespace: 'posts-section',
            drafts: translations,
          }}
        >
          <PostPreview
            formData={formData}
            postType="blog"
            locale={formLocale}
            imageFile={imgUpload.file}
            author={authors.find((a) => a.id === formData.author_id) || null}
            views={
              isEditing ? posts.find((p) => p.id === editingId)?.views || 0 : 0
            }
          />
        </PreviewModal>
      </div>
    );
  }

  return (
    <fieldset
      disabled={isUpdating}
      className="space-y-6 md:space-y-8 border-0 p-0 m-0 min-w-0"
    >
      <SectionHeader
        title={t('blog.title')}
        description={t('blog.subtitle')}
        actions={
          <SectionActions
            isDirty={isDirty}
            busy={isUpdating}
            onPublish={handlePublish}
            onRevert={() => setShowConfirmRevert(true)}
            onPreview={() => setIsPreviewOpen(true)}
          />
        }
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {transError && <ErrorBanner message={transError} onDismiss={() => {}} />}

      {canEditTranslations && (
        <div className="bg-surface-card rounded-xl p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg md:text-xl font-bold text-accent-violet">
              {t('common.translations')}
            </h2>
            <LocaleToggle
              activeLocale={activeLocale}
              onChange={setActiveLocale}
            />
          </div>
          {transLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-violet" />
            </div>
          ) : (
            <div className="space-y-4">
              <TranslationField
                label={t('blog.translationTitleLabel')}
                enValue={getField('en', 'title2')}
                itValue={getField('it', 'title2')}
                onChangeEn={(v) => setField('en', 'title2', v)}
                onChangeIt={(v) => setField('it', 'title2', v)}
                activeLocale={activeLocale}
              />
              <TranslationField
                label={t('blog.translationSubtitleLabel')}
                enValue={getField('en', 'subtitle2')}
                itValue={getField('it', 'subtitle2')}
                onChangeEn={(v) => setField('en', 'subtitle2', v)}
                onChangeIt={(v) => setField('it', 'subtitle2', v)}
                type="textarea"
                rows={3}
                activeLocale={activeLocale}
              />
              <TranslationField
                label={t('blog.searchbarPlaceholderLabel')}
                enValue={getField('en', 'searchbar')}
                itValue={getField('it', 'searchbar')}
                onChangeEn={(v) => setField('en', 'searchbar', v)}
                onChangeIt={(v) => setField('it', 'searchbar', v)}
                activeLocale={activeLocale}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-main ">
          {t('blog.postsTitle')}
        </h2>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-accent-violet-deep hover:bg-accent-violet text-white rounded-lg"
        >
          <Plus className="w-4 h-4" />
          {t('blog.addBlogPost')}
        </button>
      </div>

      {posts.length === 0 ? (
        <EmptyState icon={FileText} message={t('blog.noBlogPosts')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {posts.map((post) => (
            <div
              key={post.id}
              className="bg-surface-card rounded-xl overflow-hidden border-2 border-accent-violet/20"
            >
              <ListPostImage
                imageFile={post.image_file}
                imageUrl={post.image}
                blurhashURL={post.blurhashURL}
                alt={post.title_en}
              />
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-text-main truncate">
                    {post.title_en}
                  </h3>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(post)}
                      className="p-1 text-accent-violet hover:text-accent-violet-deep"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(post.id)}
                      className="p-1 text-red-500 hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <p className="text-sm text-text-main mb-2 line-clamp-2">
                  {post.description_en}
                </p>
                <div className="flex items-center gap-2 text-xs text-text-muted ">
                  <Calendar className="w-3 h-3" />
                  <span>{new Date(post.created_at).toLocaleDateString()}</span>
                  <FileText className="w-3 h-3" />
                  <span>{post.views} views</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={showConfirmRevert}
        title={t('common.revertAll')}
        message={t('common.confirmRevertAll')}
        confirmLabel={t('common.revert')}
        confirmVariant="primary"
        onConfirm={handleRevert}
        onCancel={() => setShowConfirmRevert(false)}
      />
      <PreviewModal
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        title={t('blog.previewTitle')}
        copy={{
          locale: activeLocale,
          namespace: 'posts-section',
          drafts: translations,
        }}
      >
        <BlogPreview posts={posts} deletedPostIds={deletedIds} />
      </PreviewModal>
    </fieldset>
  );
}

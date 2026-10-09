'use client';

import { Calendar, EyeOff, FileText, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import {
  type Author,
  blogActions,
} from '@/app/actions/cms/sections/blogActions';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { Dropdown } from '@/components/cms/shared/Dropdown';
import {
  EditorGroup,
  EditorToolbar,
  editorInputClass,
  editorLabelClass,
  editorPrimaryButtonClass,
  editorRowClass,
  editorSecondaryButtonClass,
} from '@/components/cms/shared/EditorBody';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { PostBodyField } from '@/components/cms/shared/PostBodyField';
import { PostPreviewModal } from '@/components/cms/shared/PostPreviewModal';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { ListPostImage } from '@/components/common/cms/ListPostImage';
import {
  mergeServerWithDrafts,
  readBatchEvidence,
  reconcileDrafts,
} from '@/hooks/cms/batchDrafts';
import { useBodyImages } from '@/hooks/cms/useBodyImages';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
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

/**
 * Framework cap is 10 MB per server-action request: covers plus body
 * snapshots must fit together or nothing is sent.
 */
const MAX_PUBLISH_BYTES = 9 * 1024 * 1024;

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
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [mode, setMode] = useState<FormMode>('list');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<BlogFormData>(emptyForm);
  const activeLocale = useLocale() === 'it' ? 'it' : 'en';
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
  const bodyImages = useBodyImages();
  const [previewOpen, setPreviewOpen] = useState(false);

  const isDirty =
    modifiedIds.size > 0 || newPosts.length > 0 || deletedIds.size > 0;
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
          bodyFiles: bodyImages.referencedPayload([
            post.body_en,
            post.body_it,
          ]),
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
          bodyFiles: bodyImages.referencedPayload([
            post.body_en,
            post.body_it,
          ]),
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

    // Framework cap is 10 MB per server-action request: covers plus body
    // snapshots must fit together, or nothing is sent.
    const payloadBytes = [...creates, ...updates].reduce(
      (total, item) =>
        total +
        (item.file?.size ?? 0) +
        item.bodyFiles.reduce((sum, f) => sum + f.file.size, 0),
      0
    );
    if (payloadBytes > MAX_PUBLISH_BYTES) {
      setError(
        'Total upload size is over ~9 MB (covers plus body images); publish fewer posts at a time'
      );
      setIsUpdating(false);
      return;
    }

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
        // Drop staged body images no retained draft references anymore;
        // a full success clears everything.
        const retainedPosts = posts.filter(
          (p) =>
            retainedCreateSet.has(String(p.id)) || retainedModifiedSet.has(p.id)
        );
        bodyImages.reconcile(
          retainedPosts.flatMap((p) => [p.body_en, p.body_it])
        );
      }

      const revalidationMessage = revalidationWarning(batch);
      if (revalidationMessage)
        useCmsStore.getState().setWarning(revalidationMessage);

      const remaining =
        retainedCreates.length +
        retainedUpdates.length +
        retainedDeletes.length;
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
  }, [posts, newPosts, deletedIds, modifiedIds, fetchData, user, bodyImages]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    fetchData();
    setModifiedIds(new Set());
    setNewPosts([]);
    setDeletedIds(new Set());
    setError(null);
    // Drafts are gone: every staged blob is residue.
    bodyImages.revokeAll();
  };

  useSectionCallbacks('blog', handlePublish, handleRevert);

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
        <EditorToolbar
          title={isEditing ? t('blog.editPost') : t('blog.createNewPost')}
          description={t('editor.draftHint')}
          actions={
            <LocaleToggle activeLocale={formLocale} onChange={setFormLocale} />
          }
        />
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <EditorGroup title={t('editor.groups.summary')}>
          <TranslationField
            label={t('editor.fields.title')}
            enValue={formData.title_en}
            itValue={formData.title_it}
            onChangeEn={(v) => setFormData((p) => ({ ...p, title_en: v }))}
            onChangeIt={(v) => setFormData((p) => ({ ...p, title_it: v }))}
            enPlaceholder={t('blog.titleEnPlaceholder')}
            itPlaceholder={t('blog.titleItPlaceholder')}
            required
            activeLocale={formLocale}
          />
          <TranslationField
            label={t('editor.fields.summary')}
            enValue={formData.description_en}
            itValue={formData.description_it}
            onChangeEn={(v) =>
              setFormData((p) => ({ ...p, description_en: v }))
            }
            onChangeIt={(v) =>
              setFormData((p) => ({ ...p, description_it: v }))
            }
            enPlaceholder={t('blog.descriptionEnPlaceholder')}
            itPlaceholder={t('blog.descriptionItPlaceholder')}
            type="textarea"
            rows={3}
            activeLocale={formLocale}
          />
        </EditorGroup>

        <EditorGroup title={t('editor.groups.content')}>
          <PostBodyField
            id="blog-body"
            label={t('editor.fields.content')}
            value={formLocale === 'en' ? formData.body_en : formData.body_it}
            onChange={(v) =>
              setFormData((p) =>
                formLocale === 'en' ? { ...p, body_en: v } : { ...p, body_it: v }
              )
            }
            rows={8}
            placeholder={
              formLocale === 'en'
                ? t('blog.bodyEnPlaceholder')
                : t('blog.bodyItPlaceholder')
            }
            stageImages={bodyImages.stageFiles}
            stagingErrors={bodyImages.stagingErrors}
            onPreview={() => setPreviewOpen(true)}
          />
          {previewOpen && (
            <PostPreviewModal
              title={t('editor.fields.content')}
              markdown={
                formLocale === 'en' ? formData.body_en : formData.body_it
              }
              closeLabel={t('common.close')}
              onClose={() => setPreviewOpen(false)}
            />
          )}
          <details className="rounded-lg border border-border-subtle bg-surface-base p-3 text-xs text-text-muted">
            <summary className="cursor-pointer font-medium text-text-main">
              {t('editor.formattingHelp')}
            </summary>
            <div className="mt-2 space-y-1">
              <p>
                <code className="rounded bg-accent-violet/10 px-1 text-accent-violet">
                  ****text****
                </code>{' '}
                {t('editor.syntaxBold')}
              </p>
              <p>
                <code className="rounded bg-accent-violet/10 px-1 text-accent-violet">
                  *text*
                </code>{' '}
                {t('editor.syntaxViolet')}
              </p>
              <p>
                <code className="rounded bg-accent-violet/10 px-1 text-accent-violet">
                  ![alt-blurhash](url)
                </code>{' '}
                {t('blog.syntaxImage')}
              </p>
            </div>
          </details>
        </EditorGroup>

        <EditorGroup title={t('editor.groups.media')}>
          <FileDropzone
            label={t('blog.selectImage')}
            previewUrl={imgUpload.previewUrl}
            blurhash={imgUpload.blurhash}
            isDragging={imgUpload.isDragging}
            isProcessing={imgUpload.isProcessing}
            hasPendingFile={Boolean(imgUpload.file)}
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
        </EditorGroup>

        <EditorGroup title={t('editor.groups.publication')}>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label htmlFor="blog-tags" className={editorLabelClass}>
                {t('blog.tagsLabel')}
              </label>
              <input
                id="blog-tags"
                type="text"
                value={formData.post_tags}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, post_tags: e.target.value }))
                }
                className={editorInputClass}
                placeholder={t('blog.tagsPlaceholder')}
              />
            </div>
            <div>
              <label htmlFor="blog-date" className={editorLabelClass}>
                {t('blog.dateLabel')}
              </label>
              <input
                id="blog-date"
                type="date"
                value={formData.created_at}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, created_at: e.target.value }))
                }
                className={editorInputClass}
              />
            </div>
            <div>
              <label htmlFor="blog-author" className={editorLabelClass}>
                {t('blog.authorLabel')}
              </label>
              <Dropdown
                id="blog-author"
                value={formData.author_id}
                onChange={(value) =>
                  setFormData((p) => ({ ...p, author_id: value }))
                }
                placeholder={t('blog.authorPlaceholder')}
                triggerClassName={editorInputClass}
                options={[
                  { label: t('blog.authorPlaceholder'), value: '' },
                  ...authors.map((a) => ({
                    value: a.id,
                    label: a.display_name,
                  })),
                ]}
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={formData.hidden}
              onChange={(e) =>
                setFormData((p) => ({ ...p, hidden: e.target.checked }))
              }
              className="h-4 w-4 rounded border-border-subtle text-accent-violet focus:ring-accent-violet"
            />
            {t('blog.hiddenLabel')}
          </label>
        </EditorGroup>

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={closeForm}
            className={editorSecondaryButtonClass}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={isEditing ? handleUpdate : handleCreate}
            className={editorPrimaryButtonClass}
          >
            {isEditing ? t('editor.applyDraft') : t('editor.addDraft')}
          </button>
        </div>
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
          />
        }
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <EditorToolbar
        title={t('blog.postsTitle')}
        count={posts.length}
        actions={
          <button
            type="button"
            onClick={openCreate}
            className={editorPrimaryButtonClass}
          >
            <Plus className="w-4 h-4" />
            {t('blog.addBlogPost')}
          </button>
        }
      />

      {posts.length === 0 ? (
        <EmptyState icon={FileText} message={t('blog.noBlogPosts')} />
      ) : (
        <div className="space-y-3">
          {posts.map((post) => {
            const title =
              activeLocale === 'it'
                ? post.title_it || post.title_en
                : post.title_en;
            const description =
              activeLocale === 'it'
                ? post.description_it || post.description_en
                : post.description_en;
            return (
              <div
                key={post.id}
                className={`${editorRowClass} flex flex-wrap items-start gap-4`}
              >
                <ListPostImage
                  imageFile={post.image_file}
                  imageUrl={post.image}
                  blurhashURL={post.blurhashURL}
                  alt={title}
                  compact
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold text-text-main">
                      {title}
                    </h3>
                    {post.hidden && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-text-muted">
                        <EyeOff className="h-3 w-3" />
                        {t('blog.hiddenLabel')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-text-muted">
                    {description}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
                    <span>
                      <Calendar className="mr-1 inline h-3 w-3" />
                      {new Date(post.created_at).toLocaleDateString()}
                    </span>
                    <span>
                      <FileText className="mr-1 inline h-3 w-3" />
                      {t('blog.viewsLabel', { count: post.views })}
                    </span>
                  </div>
                </div>
                <div className="flex w-full justify-end sm:w-auto">
                  <CardToolbar
                    onEdit={() => openEdit(post)}
                    onDelete={() => handleDelete(post.id)}
                  />
                </div>
              </div>
            );
          })}
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
    </fieldset>
  );
}

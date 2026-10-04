'use client';

import {
  Calendar,
  Edit3,
  Eye,
  FileText,
  Info,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import {
  type Author,
  portfolioActions,
} from '@/app/actions/cms/sections/portfolioActions';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
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
import { PortfolioPreview } from '@/components/common/cms/previews/PortfolioPreview';
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
import type { PortfolioPost } from '@/types/fetchedData.types';
import {
  deriveButtonsFromPost,
  type PostButton,
  type PostButtonKind,
  postButtonKinds,
} from '@/utils/cms/postButtons';

type FormMode = 'list' | 'create' | 'edit';
type EditablePost = PortfolioPost & { image_file?: File | null };

interface PortfolioFormData {
  title_en: string;
  title_it: string;
  image: string;
  blurhashURL: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  buttons: PostButton[];
  post_tags: string;
  created_at: string;
  author_id: string;
  hidden: boolean;
}

const emptyForm: PortfolioFormData = {
  title_en: '',
  title_it: '',
  image: '',
  blurhashURL: '',
  description_en: '',
  description_it: '',
  body_en: '',
  body_it: '',
  buttons: [],
  post_tags: '',
  created_at: new Date().toISOString().split('T')[0],
  author_id: '',
  hidden: false,
};

export default function PortfolioSection() {
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
  const [formData, setFormData] = useState<PortfolioFormData>(emptyForm);
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
  useSectionDirty('portfolio', isDirty);

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
        const r = await portfolioActions({ type: 'GET' });
        if (!current()) return;
        if (r.success) {
          const server = (r.data as PortfolioPost[]).map((p) => ({
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
        const ar = await portfolioActions({ type: 'GET_AUTHORS' });
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
      // A row written before the buttons column existed opens on a populated
      // builder, derived from the legacy link columns.
      buttons: deriveButtonsFromPost(post),
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

  const addButton = () =>
    setFormData((p) => ({
      ...p,
      buttons: [...p.buttons, { kind: 'source', url: '' }],
    }));

  const removeButton = (index: number) =>
    setFormData((p) => ({
      ...p,
      buttons: p.buttons.filter((_, i) => i !== index),
    }));

  const updateButton = (index: number, patch: Partial<PostButton>) =>
    setFormData((p) => ({
      ...p,
      buttons: p.buttons.map((button, i) =>
        i === index ? { ...button, ...patch } : button
      ),
    }));

  // Order is render order, so moving a button is a real edit the editor must
  // be able to make — same up/down affordance as skills and contacts.
  const moveButton = (index: number, direction: -1 | 1) =>
    setFormData((p) => {
      const target = index + direction;
      if (target < 0 || target >= p.buttons.length) return p;
      const next = [...p.buttons];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...p, buttons: next };
    });

  const handleCreate = () => {
    if (!formData.title_en || !imgUpload.file) {
      setError('Title and image are required');
      return;
    }
    const tempId = -Date.now();
    const post: EditablePost = {
      id: tempId,
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
            buttons: post.buttons ?? [],
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
            buttons: post.buttons ?? [],
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

      const batch = await portfolioActions({
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

  useSectionCallbacks('portfolio', handlePublish, handleRevert);

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
            {isEditing ? t('portfolio.editPost') : t('portfolio.createNewPost')}
          </h2>
          <div className="flex items-center gap-3">
            <LocaleToggle activeLocale={formLocale} onChange={setFormLocale} />
            <button
              type="button"
              onClick={closeForm}
              className="flex items-center gap-2 px-4 py-2 bg-surface-raised rounded-lg text-text-main hover:bg-surface-raised"
            >
              <X className="w-4 h-4" />
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
            label={t('portfolio.titleEnLabel')}
            enValue={formData.title_en}
            itValue={formData.title_it}
            onChangeEn={(v) => setFormData((p) => ({ ...p, title_en: v }))}
            onChangeIt={(v) => setFormData((p) => ({ ...p, title_it: v }))}
            required
            activeLocale={formLocale}
          />
          <TranslationField
            label={t('portfolio.descriptionEnLabel')}
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
            label={t('portfolio.bodyEnLabel')}
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
                {t('portfolio.syntaxHighlight')}
              </p>
              <p>
                <code className="text-accent-violet bg-accent-violet/10 px-1 rounded">
                  ![alt-blurhash](url)
                </code>{' '}
                {t('portfolio.syntaxImage')}
              </p>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="bg-surface-card rounded-xl p-4 md:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-accent-violet">
              {t('portfolio.buttonsTitle')}
            </h3>
            <button
              type="button"
              onClick={addButton}
              className="flex items-center gap-2 px-4 py-2 bg-accent-violet-deep hover:bg-accent-violet text-white rounded-lg"
            >
              <Plus className="w-4 h-4" />
              {t('portfolio.addButton')}
            </button>
          </div>
          <p className="text-xs text-text-muted">
            {t('portfolio.buttonsHint')}
          </p>
          {formData.buttons.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t('portfolio.buttonsEmpty')}
            </p>
          ) : (
            <div className="space-y-3">
              {formData.buttons.map((button, index) => (
                <div
                  key={index}
                  className="bg-surface-base rounded-lg border border-border-subtle p-3 space-y-3"
                >
                  <div className="flex items-center gap-2">
                    <CardToolbar
                      showReorder
                      onMoveUp={() => moveButton(index, -1)}
                      onMoveDown={() => moveButton(index, 1)}
                      isFirst={index === 0}
                      isLast={index === formData.buttons.length - 1}
                      onDelete={() => removeButton(index)}
                    />
                    <select
                      aria-label={t('portfolio.buttonKindLabel')}
                      value={button.kind}
                      onChange={(e) =>
                        updateButton(index, {
                          kind: e.target.value as PostButtonKind,
                        })
                      }
                      className={`${inputClass} sm:w-48`}
                    >
                      {postButtonKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`portfolio.buttonKind.${kind}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    type="url"
                    aria-label={t('portfolio.buttonUrlLabel')}
                    value={button.url}
                    onChange={(e) =>
                      updateButton(index, { url: e.target.value })
                    }
                    className={inputClass}
                    placeholder={t('portfolio.buttonUrlPlaceholder')}
                  />
                  {button.kind === 'custom' && (
                    <input
                      type="text"
                      aria-label={t('portfolio.buttonLabelLabel')}
                      value={button.label ?? ''}
                      onChange={(e) =>
                        updateButton(index, { label: e.target.value })
                      }
                      className={inputClass}
                      placeholder={t('portfolio.buttonLabelPlaceholder')}
                      required
                    />
                  )}
                </div>
              ))}
            </div>
          )}
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
                placeholder={t('portfolio.tagsPlaceholder')}
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
            {t('portfolio.selectImage')}
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
            {t('portfolio.previewPost')}
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
          title={t('portfolio.postPreviewTitle')}
          copy={{
            locale: formLocale,
            namespace: 'posts-section',
            drafts: translations,
          }}
        >
          <PostPreview
            formData={formData}
            postType="portfolio"
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
        title={t('portfolio.title')}
        description={t('portfolio.subtitle')}
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
                label={t('portfolio.translationTitleLabel')}
                enValue={getField('en', 'title1')}
                itValue={getField('it', 'title1')}
                onChangeEn={(v) => setField('en', 'title1', v)}
                onChangeIt={(v) => setField('it', 'title1', v)}
                activeLocale={activeLocale}
              />
              <TranslationField
                label={t('portfolio.translationSubtitleLabel')}
                enValue={getField('en', 'subtitle1')}
                itValue={getField('it', 'subtitle1')}
                onChangeEn={(v) => setField('en', 'subtitle1', v)}
                onChangeIt={(v) => setField('it', 'subtitle1', v)}
                type="textarea"
                rows={3}
                activeLocale={activeLocale}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-main ">
          {t('portfolio.postsTitle')}
        </h2>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-accent-violet-deep hover:bg-accent-violet text-white rounded-lg"
        >
          <Plus className="w-4 h-4" />
          {t('portfolio.addPortfolioPost')}
        </button>
      </div>

      {posts.length === 0 ? (
        <EmptyState icon={FileText} message={t('portfolio.noPortfolioPosts')} />
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
        title={t('portfolio.previewTitle')}
        copy={{
          locale: activeLocale,
          namespace: 'posts-section',
          drafts: translations,
        }}
      >
        <PortfolioPreview posts={posts} deletedPostIds={deletedIds} />
      </PreviewModal>
    </fieldset>
  );
}

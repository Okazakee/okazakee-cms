'use client';

import { Calendar, FileText, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Author,
  portfolioActions,
} from '@/app/actions/cms/sections/portfolioActions';
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
import { TagEditor } from '@/components/cms/shared/TagEditor';
import { Toggle } from '@/components/cms/shared/Toggle';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { ListPostImage } from '@/components/common/cms/ListPostImage';
import {
  mergeServerWithDrafts,
  readBatchEvidence,
  reconcileDrafts,
} from '@/hooks/cms/batchDrafts';
import {
  bodyColumnFields,
  type LoadedBodies,
  mergeFetchedBodies,
  publishBodyFields,
  publishedBodies,
  retainDraftBodies,
  rowBodies,
} from '@/hooks/cms/postBodyState';
import { useBodyImages } from '@/hooks/cms/useBodyImages';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { usePostBodies } from '@/hooks/cms/usePostBodies';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { bodyLazyLoadEnabled } from '@/libs/cms/postList';
import { demoPortfolioPosts } from '@/libs/demo/fixtures';
import { useCmsStore } from '@/store/cmsStore';
import type { PortfolioListPost } from '@/types/fetchedData.types';
import {
  deriveButtonsFromPost,
  type PostButton,
  type PostButtonKind,
  postButtonKinds,
} from '@/utils/cms/postButtons';

type FormMode = 'list' | 'create' | 'edit';

/**
 * Phase 9B: a metadata-only list row plus the local-only draft bits. The body
 * fields are OPTIONAL — an absent locale means NOT LOADED, never an
 * intentionally empty body — so every body read goes through `rowBodies()`.
 */
type EditablePost = PortfolioListPost & {
  body_en?: string;
  body_it?: string;
  image_file?: File | null;
};

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

/**
 * Framework cap is 10 MB per server-action request: covers plus body
 * snapshots must fit together or nothing is sent.
 */
const MAX_PUBLISH_BYTES = 9 * 1024 * 1024;

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
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [mode, setMode] = useState<FormMode>('list');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<PortfolioFormData>(emptyForm);
  const activeLocale = useLocale() === 'it' ? 'it' : 'en';
  const [formLocale, setFormLocale] = useState<'en' | 'it'>('en');
  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newPosts, setNewPosts] = useState<
    Array<{ post: EditablePost; imageFile: File | null }>
  >([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  // Lazy Markdown bodies (Phase 9B). `baselinesRef` holds the committed
  // Markdown each dirty candidate is compared against; `postsRef` and
  // `modifiedRef` mirror state that async list loads and publishes read after
  // a render has been queued, so neither can observe a stale closure.
  const baselinesRef = useRef<Map<number, LoadedBodies>>(new Map());
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const modifiedRef = useRef(modifiedIds);
  const markModified = useCallback((next: Set<number>) => {
    modifiedRef.current = next;
    setModifiedIds(next);
  }, []);
  const {
    loadingId: loadingBodyId,
    failure: bodyFailure,
    load: loadBody,
    clearFailure: clearBodyFailure,
  } = usePostBodies(
    useCallback(
      (id: number) => portfolioActions({ type: 'GET_BODIES', id }),
      []
    )
  );

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
      // Offline showcase: fixture posts, no server round-trip.
      if (useCmsStore.getState().demoMode) {
        if (!current()) return;
        baselinesRef.current = new Map();
        setPosts(
          JSON.parse(JSON.stringify(demoPortfolioPosts)).map(
            (p: EditablePost) => ({ ...p, image_file: null })
          )
        );
        setAuthors([
          {
            id: 'demo-user',
            display_name: 'Demo Dana',
            avatar_url: null,
          },
        ]);
        setError(null);
        setIsLoading(false);
        return;
      }
      try {
        // Phase 9B: the metadata-only projection when the lazy gate is on, the
        // legacy full read otherwise. Either way no body is fetched here — a
        // list row without Markdown means "not loaded".
        const r = await portfolioActions({
          type: bodyLazyLoadEnabled() ? 'GET_LIST' : 'GET',
        });
        if (!current()) return;
        if (r.success) {
          // `GET` (flag off) carries bodies, `GET_LIST` does not; the declared
          // list type only ever promises the metadata columns, so a body is
          // read strictly through the loader.
          const server: EditablePost[] = (r.data as PortfolioListPost[]).map(
            (p) => ({
              ...p,
              image_file: null,
            })
          );
          const merged = drafts
            ? mergeServerWithDrafts(server, drafts)
            : server;
          // Bodies may only survive for a post that still holds an unresolved
          // draft; every other row returns to "not loaded" and loses its
          // baseline.
          const stillModified: ReadonlySet<number> = drafts
            ? new Set(drafts.modified.keys())
            : modifiedRef.current;
          const baselines = baselinesRef.current;
          const nextBaselines = new Map<number, LoadedBodies>();
          setPosts(
            merged.map((row) => {
              const baseline = baselines.get(row.id);
              const modified = stillModified.has(row.id);
              const previous = postsRef.current.find((p) => p.id === row.id);
              if (modified && baseline) nextBaselines.set(row.id, baseline);
              return {
                ...row,
                ...bodyColumnFields(
                  retainDraftBodies({
                    existing: previous ? rowBodies(previous) : undefined,
                    baseline,
                    modified,
                  })
                ),
              };
            })
          );
          baselinesRef.current = nextBaselines;
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
    clearBodyFailure();
    setEditingId(null);
    setFormLocale(activeLocale);
    setMode('create');
  };
  const applyEdit = (post: EditablePost) => {
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

  /**
   * Phase 9B: with the lazy gate on, an existing post's Markdown is fetched
   * BEFORE the editor opens, so the form is never populated from bodies the
   * client never loaded. A failed read surfaces the failure and leaves the
   * editor closed — an unknown body must never become an empty-body save.
   * Pending creates (local Markdown) and the flag-off path stay synchronous.
   */
  const openEdit = async (post: EditablePost) => {
    if (
      post.id > 0 &&
      bodyLazyLoadEnabled() &&
      !useCmsStore.getState().demoMode
    ) {
      clearBodyFailure();
      const fetched = await loadBody(post.id);
      if (!fetched) return;
      // A fresh read rebases the baseline without discarding a local edit the
      // post still holds as a draft.
      const merged = mergeFetchedBodies({
        fetched,
        baseline: baselinesRef.current.get(post.id),
        local: rowBodies(post),
      });
      baselinesRef.current.set(post.id, merged.baseline);
      const loaded = bodyColumnFields(merged.current);
      setPosts((prev) =>
        prev.map((p) => (p.id === post.id ? { ...p, ...loaded } : p))
      );
      applyEdit({ ...post, ...loaded });
      return;
    }
    applyEdit(post);
  };
  const closeForm = () => {
    setMode('list');
    imgUpload.clearFile();
    clearBodyFailure();
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
    markModified(new Set(modifiedRef.current).add(editingId));
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
    const nextModified = new Set(modifiedRef.current);
    nextModified.delete(id);
    markModified(nextModified);
    setPosts((prev) => prev.filter((p) => p.id !== id));
  };

  // List quick toggle: stages a visibility flip like any other edit, so
  // Publish commits it through the normal evidence flow.
  const toggleHidden = (id: number) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, hidden: !(p.hidden ?? false) } : p
      )
    );
    markModified(new Set(modifiedRef.current).add(id));
  };

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    const lazyBodyLoad = bodyLazyLoadEnabled();
    setIsUpdating(true);
    setError(null);

    // Offline showcase: remap temp ids, materialize staged covers as
    // object URLs, drop deletes, and clear every draft set.
    if (useCmsStore.getState().demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const retained = posts.filter((p) => !deletedIds.has(p.id));
      let nextFakeId = Math.max(0, ...retained.map((p) => p.id)) + 1;
      setPosts(
        retained.map((p) => ({
          ...p,
          id: p.id < 0 ? nextFakeId++ : p.id,
          image: p.image_file ? URL.createObjectURL(p.image_file) : p.image,
          image_file: null,
        }))
      );
      setNewPosts([]);
      markModified(new Set());
      setDeletedIds(new Set());
      bodyImages.reconcile(retained.flatMap((p) => [p.body_en, p.body_it]));
      setIsUpdating(false);
      return;
    }

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
          bodyFiles: bodyImages.referencedPayload([post.body_en, post.body_it]),
          data: {
            title_en: post.title_en,
            title_it: post.title_it,
            image: '',
            description_en: post.description_en,
            description_it: post.description_it,
            body_en: post.body_en ?? '',
            body_it: post.body_it ?? '',
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
      // Lazy gate on: only Markdown that is loaded AND differs from its
      // committed baseline travels, so a metadata-only or visibility-only
      // change sends no body field and stages no body image — the committed
      // body and its pointer are left untouched. Gate off: the row still
      // carries the server bodies, so both fields are sent exactly as before.
      const body = rowBodies(post);
      const baseline = lazyBodyLoad ? baselinesRef.current.get(id) : undefined;
      const bodyFields = lazyBodyLoad
        ? publishBodyFields(body, baseline)
        : { en: post.body_en ?? '', it: post.body_it ?? '' };
      const bodyReferences = lazyBodyLoad
        ? publishedBodies(body, baseline)
        : [post.body_en, post.body_it];
      return [
        {
          id,
          file: post.image_file || null,
          currentImageUrl: post.image,
          blurhashURL: post.blurhashURL,
          bodyFiles: bodyImages.referencedPayload(bodyReferences),
          data: {
            title_en: post.title_en,
            title_it: post.title_it,
            description_en: post.description_en,
            description_it: post.description_it,
            ...bodyColumnFields(bodyFields),
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
        // Baselines follow the drafts: committed ids lose theirs (fetchData
        // above already dropped them), retained drafts keep theirs.
        markModified(new Set(retainedUpdates as number[]));
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
    // Offline showcase: restore the fixture snapshot locally.
    if (useCmsStore.getState().demoMode) {
      setPosts(
        JSON.parse(JSON.stringify(demoPortfolioPosts)).map(
          (p: EditablePost) => ({ ...p, image_file: null })
        )
      );
    } else {
      fetchData();
    }
    markModified(new Set());
    setNewPosts([]);
    setDeletedIds(new Set());
    setError(null);
    // Every draft is gone: its baseline and staged blobs are residue.
    baselinesRef.current = new Map();
    clearBodyFailure();
    bodyImages.revokeAll();
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
        <EditorToolbar
          title={
            isEditing ? t('portfolio.editPost') : t('portfolio.createNewPost')
          }
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
            type="textarea"
            rows={3}
            activeLocale={formLocale}
          />
        </EditorGroup>
        <EditorGroup title={t('editor.groups.media')}>
          <FileDropzone
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
            overlayActions
          />
        </EditorGroup>
        <EditorGroup title={t('editor.groups.content')}>
          <PostBodyField
            id="portfolio-body"
            label={t('editor.fields.content')}
            value={formLocale === 'en' ? formData.body_en : formData.body_it}
            onChange={(v) =>
              setFormData((p) =>
                formLocale === 'en'
                  ? { ...p, body_en: v }
                  : { ...p, body_it: v }
              )
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
                {t('portfolio.syntaxImage')}
              </p>
            </div>
          </details>
        </EditorGroup>

        <EditorGroup
          title={t('editor.groups.links')}
          description={t('portfolio.buttonsHint')}
          actions={
            <button
              type="button"
              onClick={addButton}
              className={editorPrimaryButtonClass}
            >
              <Plus className="h-4 w-4" />
              {t('portfolio.addButton')}
            </button>
          }
        >
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
                    <Dropdown
                      className="relative inline-block w-full sm:w-48"
                      triggerClassName={inputClass}
                      label={t('portfolio.buttonKindLabel')}
                      value={button.kind}
                      onChange={(value) =>
                        updateButton(index, { kind: value as PostButtonKind })
                      }
                      options={postButtonKinds.map((kind) => ({
                        value: kind,
                        label: t(`portfolio.buttonKind.${kind}`),
                      }))}
                    />
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
        </EditorGroup>

        <EditorGroup title={t('editor.groups.publication')}>
          <div className="grid gap-4 md:grid-cols-3">
            <TagEditor
              id="portfolio-tags"
              label={t('portfolio.tagsLabel')}
              value={formData.post_tags}
              onChange={(post_tags) =>
                setFormData((p) => ({ ...p, post_tags }))
              }
              placeholder={t('portfolio.tagsPlaceholder')}
            />
            <div>
              <label htmlFor="portfolio-date" className={editorLabelClass}>
                {t('portfolio.dateLabel')}
              </label>
              <input
                id="portfolio-date"
                type="date"
                value={formData.created_at}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, created_at: e.target.value }))
                }
                className={editorInputClass}
              />
            </div>
            <div>
              <label htmlFor="portfolio-author" className={editorLabelClass}>
                {t('portfolio.authorLabel')}
              </label>
              <Dropdown
                id="portfolio-author"
                value={formData.author_id}
                onChange={(value) =>
                  setFormData((p) => ({ ...p, author_id: value }))
                }
                placeholder={t('portfolio.authorPlaceholder')}
                triggerClassName={inputClass}
                options={[
                  {
                    label: t('portfolio.authorPlaceholder'),
                    value: '',
                  },
                  ...authors.map((a) => ({
                    value: a.id,
                    label: a.display_name,
                  })),
                ]}
              />
            </div>
          </div>
          <Toggle
            checked={formData.hidden}
            onChange={(hidden) => setFormData((p) => ({ ...p, hidden }))}
            label={t('portfolio.hiddenLabel')}
          />
        </EditorGroup>

        <div className="flex flex-wrap gap-3 pt-4">
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
        title={t('portfolio.title')}
        description={t('portfolio.subtitle')}
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
      {bodyFailure && (
        <ErrorBanner message={bodyFailure.error} onDismiss={clearBodyFailure} />
      )}

      <EditorToolbar
        title={t('portfolio.postsTitle')}
        count={posts.length}
        actions={
          <button
            type="button"
            onClick={openCreate}
            className={editorPrimaryButtonClass}
          >
            <Plus className="h-4 w-4" />
            {t('portfolio.addPortfolioPost')}
          </button>
        }
      />

      {posts.length === 0 ? (
        <EmptyState icon={FileText} message={t('portfolio.noPortfolioPosts')} />
      ) : (
        <ul className="space-y-3">
          {posts.map((post) => {
            const title =
              (activeLocale === 'it' ? post.title_it : post.title_en) ||
              post.title_en;
            const description =
              (activeLocale === 'it'
                ? post.description_it
                : post.description_en) || post.description_en;
            return (
              <li
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
                  <h3 className="truncate font-semibold text-text-main">
                    {title}
                  </h3>
                  {description && (
                    <p className="truncate text-sm text-text-muted">
                      {description}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {new Date(post.created_at).toLocaleDateString()}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <FileText className="h-3 w-3" />
                      {t('portfolio.viewsLabel', { count: post.views })}
                    </span>
                    {post.hidden && (
                      <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
                        {t('portfolio.hiddenLabel')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex w-full justify-end sm:w-auto">
                  {loadingBodyId === post.id ? (
                    <div
                      role="status"
                      aria-label={t('common.loading')}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center"
                    >
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-violet" />
                    </div>
                  ) : (
                    <CardToolbar
                      onToggleHidden={() => toggleHidden(post.id)}
                      hidden={post.hidden ?? false}
                      onEdit={() => {
                        void openEdit(post);
                      }}
                      onDelete={() => handleDelete(post.id)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
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

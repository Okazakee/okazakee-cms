'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  finalizeStagedPostImage,
  getAdminClient,
  getCmsActionContext,
  prepareImageUpload,
  removePrefixBestEffort,
  removePublicFileIfDifferent,
  removePublicFileIfPresent,
  removeStorageObjectBestEffort,
  requireAllowedPostWriter,
  requireAuth,
  uploadImmutablePreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import {
  applyBodyImageRewrites,
  bodyUploadStaged,
  captionOverridesFor,
  cleanupOrphanedBodyImages,
  removeBodyUploads,
  uploadBodyImages,
  validateBodyImagePayload,
} from '@/app/actions/cms/utils/postBodyFiles';
import {
  batchFailureSummary,
  batchHadCommits,
  batchSucceeded,
  emptyBatchEvidence,
  markCreated,
  markDeleted,
  markFailed,
  markUpdated,
  normalizeTempId,
} from '@/libs/cms/batchEvidence';
import { currentBodyWrite } from '@/libs/cms/bodyWriteGate';
import { legacyBodyEnShimFields } from '@/libs/cms/legacyBodyEnShim';
import {
  errorMessage,
  type MutationResult,
  type RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { PORTFOLIO_LIST_COLUMNS } from '@/libs/cms/postList';
import type { BodyContentStorageApi } from '@/libs/cms/storage/bodyContent';
import {
  clientBodyPointerRejection,
  commitGuardedRow,
  modifiedLocales,
  POINTER_CONFLICT_MESSAGE,
  type PointerGuard,
  type PriorBodyPointers,
  pointerCommitFields,
  pointerGuards,
  replacedBodyMarkdown,
  stagePostBodies,
  stripRetiredBodyColumns,
} from '@/libs/cms/storage/bodyPointerCommit';
import {
  getCmsStorageBucket,
  getCmsStorageOrigin,
} from '@/libs/cms/storage/bucket';
import { currentContentBucket } from '@/libs/cms/storage/contentBucket';
import {
  PORTFOLIO_STAGING_PREFIX,
  portfolioPostPrefix,
} from '@/libs/cms/storage/paths';
import {
  POST_BODY_POINTER_COLUMNS,
  type PostBodyPointerRow,
  readPostBodies,
} from '@/libs/cms/storage/postBodyRead';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import type { BodyImageUpload } from '@/utils/cms/postBody';
import { hasPendingRefs } from '@/utils/cms/postBody';
import { type PostButton, validatePostButtons } from '@/utils/cms/postButtons';
import { createClient } from '@/utils/supabase/server';

type PortfolioOperation =
  | { type: 'GET' }
  | { type: 'GET_LIST' }
  | { type: 'GET_AUTHORS' }
  | { type: 'GET_BODIES'; id: number }
  | { type: 'CREATE'; data: CreatePortfolioData }
  | { type: 'UPDATE'; id: number; data: UpdatePortfolioData }
  | { type: 'DELETE'; id: number }
  | {
      type: 'UPLOAD_IMAGE_FOR_NEW_POST';
      file: File;
      titleEn: string;
      blurhashURL?: string;
    }
  | { type: 'ROLLBACK_CREATE'; postId: number; imagePath: string }
  | {
      type: 'UPLOAD_IMAGE';
      portfolioId: number;
      file: File;
      currentImageUrl?: string;
      blurhashURL?: string;
    }
  | {
      type: 'BATCH_PUBLISH';
      creates: Array<{
        data: CreatePortfolioData;
        file: File;
        blurhashURL?: string;
        /** Client-generated temporary id; echoed back in `created`/`createdIds`. */
        tempId?: string;
        /** Blob-staged body images; uploaded to the post folder after INSERT. */
        bodyFiles?: BodyImageUpload[];
      }>;
      updates: Array<{
        id: number;
        data: UpdatePortfolioData;
        file?: File | null;
        currentImageUrl?: string;
        blurhashURL?: string;
        /** Blob-staged body images; uploaded straight into the post folder. */
        bodyFiles?: BodyImageUpload[];
      }>;
      deletes: number[];
    };

export type Author = {
  id: string;
  display_name: string;
  avatar_url: string | null;
};

type CreatePortfolioData = {
  title_en: string;
  title_it: string;
  image: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  buttons?: PostButton[];
  created_at?: string;
  author_id: string;
  hidden?: boolean;
};

type UpdatePortfolioData = Partial<CreatePortfolioData>;

/**
 * Trusted prior state for a write. Only the cover and the committed pointers
 * are read: the retired `body_en`/`body_it` columns are never consulted by the
 * write path (the pointer is the body state).
 */
type PriorPortfolioBodyRow = {
  id: number;
  image: string | null;
  body_en_path: string | null;
  body_it_path: string | null;
};

type PortfolioResult = MutationResult;

// Validation functions
type PortfolioDataValidation =
  | { isValid: true; data: CreatePortfolioData | UpdatePortfolioData }
  | { isValid: false; error: string };

function validatePortfolioData(
  data: CreatePortfolioData | UpdatePortfolioData
): PortfolioDataValidation {
  // Required fields validation
  if (
    data.title_en !== undefined &&
    (!data.title_en || data.title_en.trim().length === 0)
  ) {
    return { isValid: false, error: 'English title is required' };
  }

  if (
    data.title_it !== undefined &&
    (!data.title_it || data.title_it.trim().length === 0)
  ) {
    return { isValid: false, error: 'Italian title is required' };
  }

  if (
    data.description_en !== undefined &&
    (!data.description_en || data.description_en.trim().length === 0)
  ) {
    return { isValid: false, error: 'English description is required' };
  }

  if (
    data.description_it !== undefined &&
    (!data.description_it || data.description_it.trim().length === 0)
  ) {
    return { isValid: false, error: 'Italian description is required' };
  }

  if (
    data.body_en !== undefined &&
    (!data.body_en || data.body_en.trim().length === 0)
  ) {
    return { isValid: false, error: 'English content is required' };
  }

  if (
    data.body_it !== undefined &&
    (!data.body_it || data.body_it.trim().length === 0)
  ) {
    return { isValid: false, error: 'Italian content is required' };
  }

  // Length validation
  if (data.title_en && data.title_en.length > 200) {
    return {
      isValid: false,
      error: 'English title must be less than 200 characters',
    };
  }

  if (data.title_it && data.title_it.length > 200) {
    return {
      isValid: false,
      error: 'Italian title must be less than 200 characters',
    };
  }

  if (data.description_en && data.description_en.length > 500) {
    return {
      isValid: false,
      error: 'English description must be less than 500 characters',
    };
  }

  if (data.description_it && data.description_it.length > 500) {
    return {
      isValid: false,
      error: 'Italian description must be less than 500 characters',
    };
  }

  // Buttons validation; returns the normalised list so the write carries
  // exactly what was checked (preset labels dropped, urls trimmed).
  const buttons = validatePostButtons(data.buttons);
  if (!buttons.isValid) {
    return { isValid: false, error: buttons.error };
  }

  return { isValid: true, data: { ...data, buttons: buttons.buttons } };
}

export async function portfolioActions(
  operation: PortfolioOperation
): Promise<PortfolioResult> {
  if (operation.type === 'BATCH_PUBLISH') {
    return await batchPublishPortfolio(operation);
  }

  // Per-post Markdown bodies authorize at the post-writer level and read
  // through the canonical admin client, so — like BATCH_PUBLISH — they run
  // their own gate instead of passing through the shared allowlist check twice.
  if (operation.type === 'GET_BODIES') {
    return await getPortfolioBodies(operation.id);
  }

  // Auth check - reject unauthenticated requests
  try {
    await requireAuth();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getPortfolioData(supabase);

      case 'GET_LIST':
        return await getPortfolioList(supabase);

      case 'GET_AUTHORS':
        return await getAuthors(supabase);

      case 'CREATE':
        return await createPortfolio(supabase, operation.data);

      case 'UPDATE':
        return await updatePortfolio(supabase, operation.id, operation.data);

      case 'DELETE':
        return await deletePortfolio(supabase, operation.id);

      case 'UPLOAD_IMAGE_FOR_NEW_POST':
        return await uploadPortfolioImageForNewPost(
          operation.file,
          operation.titleEn,
          operation.blurhashURL
        );

      case 'ROLLBACK_CREATE':
        return await rollbackPortfolioCreate(
          operation.postId,
          operation.imagePath
        );

      case 'UPLOAD_IMAGE':
        return await uploadPortfolioImage(
          supabase,
          operation.portfolioId,
          operation.file,
          operation.currentImageUrl,
          operation.blurhashURL
        );

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Portfolio action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

/** Storage origin for body orphan cleanup; null skips it (best-effort). */
function readStorageOrigin(): string | null {
  try {
    return getCmsStorageOrigin();
  } catch {
    return null;
  }
}

/**
 * Authenticated EN/IT Markdown for ONE portfolio post.
 *
 * Authorization is the canonical post-writer check, and the service-role admin
 * client is used only after it — so hidden drafts resolve for authorized CMS
 * users and never for anyone else. The result carries the Markdown only: no
 * pointer paths, hashes, sizes, signed URLs or object metadata.
 *
 * Storage is the only body store: the row read names the canonical pointers and
 * never the retired `body_en` / `body_it` columns. The environment's content
 * bucket is resolved BEFORE any DB or Storage call, so an unknown or crossed
 * environment fails closed. A referenced object that is missing, unreadable,
 * hash-mismatched or named by a malformed pointer fails the action; it is never
 * reported as an empty body.
 */
async function getPortfolioBodies(id: number): Promise<PortfolioResult> {
  try {
    const bucket = currentContentBucket();
    if (!bucket.ok) {
      return { success: false, error: bucket.error };
    }

    await getCmsActionContext('post-writer');

    if (!Number.isSafeInteger(id) || id <= 0) {
      return { success: false, error: 'Invalid post id' };
    }

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('portfolio_posts')
      .select(POST_BODY_POINTER_COLUMNS)
      .eq('id', id)
      .single();

    if (error || !data) {
      return { success: false, error: 'Portfolio post not found' };
    }

    // The projection is a column list the generated client types cannot follow,
    // so the read-path row is asserted once here.
    const row = data as unknown as PostBodyPointerRow;
    const bodies = await readPostBodies(
      admin.storage.from(bucket.bucket) as unknown as BodyContentStorageApi,
      'portfolio',
      id,
      {
        en: row.body_en_path ?? null,
        it: row.body_it_path ?? null,
      }
    );

    return {
      success: true,
      data: {
        id,
        body_en: bodies.en,
        body_it: bodies.it,
      },
    };
  } catch (error) {
    console.error('Error fetching portfolio bodies:', error);
    return {
      success: false,
      error: errorMessage(error, 'Failed to fetch portfolio bodies'),
    };
  }
}

async function batchPublishPortfolio(
  operation: Extract<PortfolioOperation, { type: 'BATCH_PUBLISH' }>
): Promise<PortfolioResult> {
  const evidence = emptyBatchEvidence();
  try {
    // The content bucket (and therefore the environment pairing) is resolved
    // before any DB or Storage mutation: an incompatible environment must
    // never half-write a body.
    const write = currentBodyWrite();
    if (write.mode === 'invalid') {
      return { success: false, error: write.error };
    }

    const context = await getCmsActionContext('post-writer');
    const admin = getAdminClient();
    const bucket = getCmsStorageBucket();

    for (const [index, item] of operation.creates.entries()) {
      const tempId = normalizeTempId(item.tempId, 'portfolio', index);
      const pointerViolation = clientBodyPointerRejection(item.data);
      if (pointerViolation) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: pointerViolation,
        });
        continue;
      }
      const validation = validatePortfolioData(item.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      // Blob-staged body images resolve here; unresolved refs must fail
      // before the cover upload so nothing is written for a broken draft.
      const bodyPayloadError = validateBodyImagePayload(item.bodyFiles, [
        validation.data.body_en,
        validation.data.body_it,
      ]);
      if (bodyPayloadError) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: bodyPayloadError,
        });
        continue;
      }

      const prepared = await prepareImageUpload(item.file, item.blurhashURL);
      if (!prepared.success) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: prepared.error ?? 'Image processing failed',
        });
        continue;
      }

      const upload = await uploadImmutablePreparedImage(
        admin,
        bucket,
        PORTFOLIO_STAGING_PREFIX,
        validation.data.title_en || 'untitled',
        prepared.image
      );

      const insertData = {
        ...stripRetiredBodyColumns(validation.data),
        author_id: item.data.author_id || context.user.id,
        image: upload.publicUrl,
        blurhashURL: prepared.image.blurhash,
        // Provisional insert: hidden, unpointed, and carrying only the legacy
        // `body_en` shim value (the only field the retired column still needs
        // while it is NOT NULL). The row can therefore never be publicly
        // readable before its objects and pointers commit together below.
        hidden: true,
        ...legacyBodyEnShimFields(),
      };

      const { data, error } = await admin
        .from('portfolio_posts')
        .insert(insertData)
        .select()
        .single();

      if (error) {
        await removeStorageObjectBestEffort(admin, bucket, upload.path);
        markFailed(evidence, { kind: 'create', tempId, error: error.message });
        continue;
      }

      // The row id exists only after the INSERT, so staged body images are
      // uploaded into the per-post folder now and the markdown is rewritten
      // to the committed URLs. Any failure rolls the row back: a created
      // row must never keep `pending:` refs behind.
      let bodyStaged: string[] = [];
      try {
        const bodyUpload = await uploadBodyImages(
          admin,
          bucket,
          portfolioPostPrefix(data.id as number),
          validation.data.title_en || 'untitled',
          item.bodyFiles,
          captionOverridesFor([
            validation.data.body_en,
            validation.data.body_it,
          ])
        );
        bodyStaged = bodyUpload.staged;
        const rewrittenBodies = applyBodyImageRewrites(
          {
            body_en: validation.data.body_en,
            body_it: validation.data.body_it,
          },
          bodyUpload.rewrites
        );
        // Objects are uploaded and their bytes verified BEFORE the pointer
        // commit; a failure rolls the provisional row back in the catch below.
        // The guard requires the pointers this INSERT just wrote (NULL) to be
        // untouched, so a concurrent write to the same provisional row loses
        // instead of being overwritten.
        const bodyStorage = admin.storage.from(
          write.bucket
        ) as unknown as BodyContentStorageApi;
        const staged = await stagePostBodies(
          bodyStorage,
          'portfolio',
          data.id as number,
          [
            { locale: 'en', body: rewrittenBodies.body_en },
            { locale: 'it', body: rewrittenBodies.body_it },
          ]
        );
        const committed = await commitGuardedRow(
          admin,
          'portfolio_posts',
          data.id as number,
          {
            ...pointerCommitFields(staged.pointers),
            hidden: item.data.hidden ?? false,
          },
          pointerGuards(staged.pointers, {})
        );
        if (committed.status === 'failed') {
          throw new Error(
            errorMessage(committed.error, 'Final body commit failed')
          );
        }
        if (committed.status === 'conflict') {
          throw new Error(POINTER_CONFLICT_MESSAGE);
        }
      } catch (error) {
        const { error: rollbackError } = await admin
          .from('portfolio_posts')
          .delete()
          .eq('id', data.id);
        // A surviving provisional row may reference these assets: only clean
        // them up once the row is confirmed gone.
        if (!rollbackError) {
          await removeStorageObjectBestEffort(admin, bucket, upload.path);
          await removeBodyUploads(admin, bucket, [
            ...bodyStaged,
            ...bodyUploadStaged(error),
          ]);
        }
        const baseError =
          error instanceof Error ? error.message : 'Body publish failed';
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: rollbackError
            ? `${baseError} (rollback failed for provisional row ${data.id as number}: ${rollbackError.message}; the row stays hidden and unpointed, assets retained because the surviving row may reference them; manual reconciliation may be needed)`
            : baseError,
        });
        continue;
      }

      // The row id exists only after the INSERT, so the staged upload is
      // moved into its per-post folder now. The row keeps the staging URL
      // when the move fails (still valid; the next update moves it).
      const finalized = await finalizeStagedPostImage(
        admin,
        bucket,
        upload.path,
        portfolioPostPrefix(data.id as number)
      );
      if (finalized) {
        const { error: finalizeError } = await admin
          .from('portfolio_posts')
          .update({ image: finalized.publicUrl })
          .eq('id', data.id);
        if (finalizeError) {
          console.error(
            'Error finalizing portfolio cover path:',
            finalizeError
          );
        }
      }

      markCreated(evidence, tempId, data.id);
    }

    for (const item of operation.updates) {
      const pointerViolation = clientBodyPointerRejection(item.data);
      if (pointerViolation) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: pointerViolation,
        });
        continue;
      }
      const validation = validatePortfolioData(item.data);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const bodyPayloadError = validateBodyImagePayload(item.bodyFiles, [
        validation.data.body_en,
        validation.data.body_it,
      ]);
      if (bodyPayloadError) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: bodyPayloadError,
        });
        continue;
      }

      let uploaded: { publicUrl: string; path: string } | null = null;
      const updateData: UpdatePortfolioData = { ...validation.data };
      // Trusted replacement source: the previous row (cover + committed
      // pointers) is read from the DB, never trusted from a client payload.
      // The retired Markdown columns are not read at all.
      let previousImage: string | null = null;
      let bodyStaged: string[] = [];
      const { data: currentRowRaw, error: fetchError } = await admin
        .from('portfolio_posts')
        .select('image, body_en_path, body_it_path')
        .eq('id', item.id)
        .single();
      const currentRow = currentRowRaw as PriorPortfolioBodyRow | null;

      if (fetchError || !currentRow) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: fetchError?.message ?? 'Portfolio post not found',
        });
        continue;
      }
      previousImage = currentRow.image ?? null;
      const priorPointers: PriorBodyPointers = {
        en: currentRow.body_en_path,
        it: currentRow.body_it_path,
      };

      if (item.bodyFiles && item.bodyFiles.length > 0) {
        try {
          const bodyUpload = await uploadBodyImages(
            admin,
            bucket,
            portfolioPostPrefix(item.id),
            validation.data.title_en || `portfolio-${item.id}`,
            item.bodyFiles,
            captionOverridesFor([
              validation.data.body_en,
              validation.data.body_it,
            ])
          );
          bodyStaged = bodyUpload.staged;
          const rewritten = applyBodyImageRewrites(
            { body_en: updateData.body_en, body_it: updateData.body_it },
            bodyUpload.rewrites
          );
          updateData.body_en = rewritten.body_en;
          updateData.body_it = rewritten.body_it;
        } catch (error) {
          await removeBodyUploads(admin, bucket, [
            ...bodyStaged,
            ...bodyUploadStaged(error),
          ]);
          markFailed(evidence, {
            kind: 'update',
            id: item.id,
            error:
              error instanceof Error
                ? error.message
                : 'Body image upload failed',
          });
          continue;
        }
      }

      if (item.file) {
        const prepared = await prepareImageUpload(item.file, item.blurhashURL);
        if (!prepared.success) {
          await removeBodyUploads(admin, bucket, bodyStaged);
          markFailed(evidence, {
            kind: 'update',
            id: item.id,
            error: prepared.error ?? 'Image processing failed',
          });
          continue;
        }

        uploaded = await uploadImmutablePreparedImage(
          admin,
          bucket,
          portfolioPostPrefix(item.id),
          item.data.title_en || `portfolio-${item.id}`,
          prepared.image
        );
        updateData.image = uploaded.publicUrl;
        updateData.blurhashURL = prepared.image.blurhash;
      }

      // Markdown objects are uploaded (and their bytes verified) BEFORE the
      // guarded pointer commit; a failure leaves the previously committed
      // pointer authoritative. A metadata-only update issues no Storage call
      // at all, because only the locales present in the payload are staged.
      const dbUpdate: Record<string, unknown> = stripRetiredBodyColumns({
        ...updateData,
      });
      const requests = modifiedLocales(updateData);
      const guards: PointerGuard[] = [];
      let previousBodies: Array<string | undefined> = [];
      if (requests.length > 0) {
        try {
          const bodyStorage = admin.storage.from(
            write.bucket
          ) as unknown as BodyContentStorageApi;
          const staged = await stagePostBodies(
            bodyStorage,
            'portfolio',
            item.id,
            requests,
            priorPointers
          );
          Object.assign(dbUpdate, pointerCommitFields(staged.pointers));
          if (Object.hasOwn(staged.pointers, 'en')) {
            // Legacy NOT NULL placeholder only — never the real Markdown.
            Object.assign(dbUpdate, legacyBodyEnShimFields());
          }
          guards.push(...pointerGuards(staged.pointers, priorPointers));
          previousBodies = await replacedBodyMarkdown(
            bodyStorage,
            requests,
            priorPointers,
            staged.pointers
          );
        } catch (error) {
          // The replacement cover may already be uploaded: remove it too. The
          // previously committed cover and pointers are untouched.
          if (uploaded) {
            await removeStorageObjectBestEffort(admin, bucket, uploaded.path);
          }
          await removeBodyUploads(admin, bucket, bodyStaged);
          markFailed(evidence, {
            kind: 'update',
            id: item.id,
            error:
              error instanceof Error
                ? error.message
                : 'Markdown body upload failed',
          });
          continue;
        }
      }

      // ONE guarded UPDATE: metadata and pointers together. Zero matched rows
      // means the observed pointer no longer holds, so this save loses cleanly
      // instead of overwriting a concurrent edit.
      const committed = await commitGuardedRow(
        admin,
        'portfolio_posts',
        item.id,
        dbUpdate,
        guards
      );

      if (committed.status !== 'committed') {
        if (uploaded) {
          await removeStorageObjectBestEffort(admin, bucket, uploaded.path);
        }
        await removeBodyUploads(admin, bucket, bodyStaged);
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error:
            committed.status === 'conflict'
              ? POINTER_CONFLICT_MESSAGE
              : errorMessage(committed.error, 'Portfolio post update failed'),
        });
        continue;
      }

      if (uploaded) {
        await removePublicFileIfDifferent(
          admin,
          previousImage,
          bucket,
          uploaded.path
        );
      }

      // Body-image assets the new markdown dropped (same-prefix only, covers
      // always kept). The previous markdown comes from the object the replaced
      // pointer named, never from the retired columns. Best-effort: it never
      // fails the publish, and content-bucket objects belong to the GC.
      const storageOrigin = readStorageOrigin();
      if (storageOrigin) {
        await cleanupOrphanedBodyImages(
          admin,
          bucket,
          storageOrigin,
          portfolioPostPrefix(item.id),
          previousBodies,
          [updateData.body_en, updateData.body_it],
          [previousImage, uploaded?.publicUrl]
        );
      }

      markUpdated(evidence, item.id);
    }

    if (operation.deletes.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('portfolio_posts')
        .select('id, image')
        .in('id', operation.deletes);

      if (fetchError) {
        markFailed(evidence, { kind: 'delete', error: fetchError.message });
      } else {
        // Returned-row evidence: only ids present at delete time may be
        // reported as committed, so concurrent/unknown ids keep their drafts.
        const existingIds = new Set(
          (existingRows || []).map((row) => row.id as number)
        );
        for (const id of operation.deletes) {
          if (!existingIds.has(id)) {
            markFailed(evidence, {
              kind: 'delete',
              id,
              error: 'Portfolio post not found',
            });
          }
        }
        const deletable = operation.deletes.filter((id) => existingIds.has(id));
        if (deletable.length > 0) {
          const { data: deletedRows, error } = await admin
            .from('portfolio_posts')
            .delete()
            .in('id', deletable)
            .select('id');

          if (error) {
            markFailed(evidence, { kind: 'delete', error: error.message });
          } else {
            const deletedIds = new Set(
              (deletedRows || []).map((row) => row.id as number)
            );
            for (const id of deletable) {
              if (deletedIds.has(id)) markDeleted(evidence, id);
              else {
                markFailed(evidence, {
                  kind: 'delete',
                  id,
                  error: 'Portfolio post was not deleted',
                });
              }
            }
            // Asset-bucket cleanup only (cover + body images). The
            // content-bucket Markdown objects of the deleted rows become
            // unreferenced and are reclaimed by the Storage garbage collector;
            // the write path must never delete them itself.
            for (const row of existingRows || []) {
              if (deletedIds.has(row.id as number)) {
                await removePublicFileIfPresent(
                  admin,
                  row.image as string | null,
                  bucket
                );
                // Per-post folder: covers body assets the image column never
                // referenced. Legacy rows may also hold a pre-reorg URL, which
                // the cover removal above already handled.
                await removePrefixBestEffort(
                  admin,
                  bucket,
                  portfolioPostPrefix(row.id as number)
                );
              }
            }
          }
        }
      }
    }

    let revalidation: RevalidationStatus | undefined;
    if (batchHadCommits(evidence)) {
      revalidation = await invalidatePublicContent({
        entity: 'portfolio',
        operation: 'publish',
        ids: [
          ...Object.values(evidence.createdIds),
          ...evidence.updated,
          ...evidence.deleted,
        ],
      });
    }

    return {
      success: batchSucceeded(evidence),
      data: evidence,
      error: batchFailureSummary(evidence),
      revalidation,
    };
  } catch (error) {
    console.error('Error batch publishing portfolio posts:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to publish portfolio posts';
    markFailed(evidence, { kind: 'update', error: message });
    const revalidation = batchHadCommits(evidence)
      ? await invalidatePublicContent({
          entity: 'portfolio',
          operation: 'publish',
          ids: [
            ...Object.values(evidence.createdIds),
            ...evidence.updated,
            ...evidence.deleted,
          ],
        })
      : undefined;
    return {
      success: false,
      data: evidence,
      error: batchFailureSummary(evidence),
      revalidation,
    };
  }
}
/**
 * Metadata-only portfolio list (Phase 9B).
 *
 * Same authorization model and sort order as `GET`, but with an explicit
 * projection that cannot carry a Markdown body or a body pointer. The legacy
 * link columns and `buttons` ARE included: list rendering and
 * `deriveButtonsFromPost()` still need them. `GET` is left untouched.
 */
async function getPortfolioList(
  _supabase: SupabaseClient
): Promise<PortfolioResult> {
  try {
    // CMS lists include drafts: published-only RLS hides them from session
    // reads, so this goes through the admin client after the requireAuth gate
    // in portfolioActions (service-role-after-check).
    const { data, error } = await getAdminClient()
      .from('portfolio_posts')
      .select(PORTFOLIO_LIST_COLUMNS)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Database error:', error);
      return {
        success: false,
        error: `Database error: ${error.message}`,
      };
    }

    return { success: true, data: data || [] };
  } catch (error) {
    console.error('Error fetching portfolio list:', error);
    return {
      success: false,
      error: `Failed to fetch portfolio list: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function getPortfolioData(
  _supabase: SupabaseClient
): Promise<PortfolioResult> {
  try {
    // CMS lists include drafts: published-only RLS hides them from session
    // reads, so this goes through the admin client after the requireAuth
    // gate in portfolioActions (service-role-after-check). Authorized CMS
    // users only; the public site never calls this path.
    const { data: portfolioPosts, error } = await getAdminClient()
      .from('portfolio_posts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { success: true, data: portfolioPosts };
  } catch (error) {
    console.error('Error fetching portfolio data:', error);
    return {
      success: false,
      error: 'Failed to fetch portfolio data',
    };
  }
}

async function getAuthors(_supabase: SupabaseClient): Promise<PortfolioResult> {
  try {
    // Author picker: admin client after the requireAuth gate. Column set is
    // the picker contract (id/display_name/avatar_url); email never leaves
    // the allowlist through this path.
    const { data: profiles, error } = await getAdminClient()
      .from('user_profiles')
      .select('id, display_name, avatar_url')
      .order('display_name', { ascending: true });

    if (error) {
      console.error('Database error:', error);
      return {
        success: false,
        error: `Database error: ${error.message}`,
      };
    }

    return { success: true, data: profiles || [] };
  } catch (error) {
    console.error('Error fetching authors:', error);
    return {
      success: false,
      error: `Failed to fetch authors: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function createPortfolio(
  _supabase: SupabaseClient,
  data: CreatePortfolioData
): Promise<PortfolioResult> {
  try {
    const validation = validatePortfolioData(data);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
    const pointerViolation = clientBodyPointerRejection(data);
    if (pointerViolation) {
      return { success: false, error: pointerViolation };
    }

    const { id: userId } = await requireAllowedPostWriter();
    // Legacy single-shot path has no body-file upload: refuse staged refs.
    if (hasPendingRefs(data.body_en, data.body_it)) {
      return {
        success: false,
        error: 'Body images must be published through batch publish',
      };
    }
    const write = currentBodyWrite();
    if (write.mode === 'invalid') {
      return { success: false, error: write.error };
    }

    const insertData = {
      ...stripRetiredBodyColumns(validation.data),
      blurhashURL: validation.data.blurhashURL ?? '',
      author_id: data.author_id || userId,
      // Provisional insert: hidden, unpointed, and carrying only the legacy
      // `body_en` shim value. The intended visibility commits together with
      // the pointers below, so the post can never be publicly readable before
      // its objects exist.
      hidden: true,
      ...legacyBodyEnShimFields(),
    };

    const admin = getAdminClient();
    const { data: newPortfolio, error } = await admin
      .from('portfolio_posts')
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    let committed = newPortfolio;
    const postId = newPortfolio.id as number;
    try {
      // The row id exists only now, so the objects (and their read-back hash
      // proof) are written after the INSERT and before the pointer commit.
      const bodyStorage = admin.storage.from(
        write.bucket
      ) as unknown as BodyContentStorageApi;
      const staged = await stagePostBodies(bodyStorage, 'portfolio', postId, [
        { locale: 'en', body: validation.data.body_en },
        { locale: 'it', body: validation.data.body_it },
      ]);
      const result = await commitGuardedRow(
        admin,
        'portfolio_posts',
        postId,
        {
          ...pointerCommitFields(staged.pointers),
          hidden: data.hidden ?? false,
        },
        // The provisional row is unpointed, so the commit only applies while
        // that is still true.
        pointerGuards(staged.pointers, {})
      );
      if (result.status === 'failed') {
        throw new Error(
          errorMessage(result.error, 'Body pointer commit failed')
        );
      }
      if (result.status === 'conflict') {
        throw new Error(POINTER_CONFLICT_MESSAGE);
      }
      committed = result.row ?? newPortfolio;
    } catch (error) {
      const { error: rollbackError } = await admin
        .from('portfolio_posts')
        .delete()
        .eq('id', postId);
      const baseError =
        error instanceof Error ? error.message : 'Body write failed';
      throw new Error(
        rollbackError
          ? `${baseError} (rollback failed for provisional row ${postId}: ${rollbackError.message}; the row stays hidden and unpointed)`
          : baseError
      );
    }

    const revalidation = await invalidatePublicContent({
      entity: 'portfolio',
      operation: 'create',
    });
    return { success: true, data: committed, revalidation };
  } catch (error) {
    console.error('Error creating portfolio post:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create portfolio post',
    };
  }
}

async function updatePortfolio(
  _supabase: SupabaseClient,
  id: number,
  data: UpdatePortfolioData
): Promise<PortfolioResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const validation = validatePortfolioData(data);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
    const pointerViolation = clientBodyPointerRejection(data);
    if (pointerViolation) {
      return { success: false, error: pointerViolation };
    }
    // Legacy single-shot path has no body-file upload: refuse staged refs.
    if (hasPendingRefs(data.body_en, data.body_it)) {
      return {
        success: false,
        error: 'Body images must be published through batch publish',
      };
    }

    const write = currentBodyWrite();
    if (write.mode === 'invalid') {
      return { success: false, error: write.error };
    }

    const admin = getAdminClient();
    const { data: existingPortfolioRaw, error: fetchError } = await admin
      .from('portfolio_posts')
      .select('id, body_en_path, body_it_path')
      .eq('id', id)
      .single();
    const existingPortfolio =
      existingPortfolioRaw as PriorPortfolioBodyRow | null;

    if (fetchError || !existingPortfolio) {
      return { success: false, error: 'Portfolio post not found' };
    }

    const priorPointers: PriorBodyPointers = {
      en: existingPortfolio.body_en_path,
      it: existingPortfolio.body_it_path,
    };

    // Objects are uploaded (and their bytes verified) before the guarded
    // pointer commit; a failure leaves the committed pointer authoritative. A
    // metadata-only update issues no Storage call and touches no pointer.
    const dbUpdate: Record<string, unknown> = stripRetiredBodyColumns({
      ...validation.data,
    });
    const requests = modifiedLocales(validation.data);
    const guards: PointerGuard[] = [];
    if (requests.length > 0) {
      const bodyStorage = admin.storage.from(
        write.bucket
      ) as unknown as BodyContentStorageApi;
      const staged = await stagePostBodies(
        bodyStorage,
        'portfolio',
        id,
        requests,
        priorPointers
      );
      Object.assign(dbUpdate, pointerCommitFields(staged.pointers));
      if (Object.hasOwn(staged.pointers, 'en')) {
        // Legacy NOT NULL placeholder only — never the real Markdown.
        Object.assign(dbUpdate, legacyBodyEnShimFields());
      }
      // Guards name only the locales this save writes, so an EN-only edit can
      // never be rejected because of a concurrent IT edit (and vice versa).
      guards.push(...pointerGuards(staged.pointers, priorPointers));
    }

    const committed = await commitGuardedRow(
      admin,
      'portfolio_posts',
      id,
      dbUpdate,
      guards
    );
    if (committed.status === 'failed') {
      throw new Error(
        errorMessage(committed.error, 'Failed to update portfolio post')
      );
    }
    if (committed.status === 'conflict') {
      // No retry, no invalidation: nothing was written, so the public cache
      // still matches the row.
      return { success: false, error: POINTER_CONFLICT_MESSAGE };
    }

    const revalidation = await invalidatePublicContent({
      entity: 'portfolio',
      operation: 'update',
      id,
    });
    return { success: true, data: committed.row, revalidation };
  } catch (error) {
    console.error('Error updating portfolio post:', error);
    return {
      success: false,
      error: 'Failed to update portfolio post',
    };
  }
}

async function deletePortfolio(
  _supabase: SupabaseClient,
  id: number
): Promise<PortfolioResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const admin = getAdminClient();
    const bucket = getCmsStorageBucket();
    const { data: existingPortfolio, error: fetchError } = await admin
      .from('portfolio_posts')
      .select('id, image')
      .eq('id', id)
      .single();

    if (fetchError || !existingPortfolio) {
      return { success: false, error: 'Portfolio post not found' };
    }

    // Commit the DB delete FIRST; only then remove the ASSET objects
    // (best-effort). Deleting them before the row is gone would leave the row
    // pointing at a deleted image if the DB delete failed.
    //
    // Content-bucket Markdown is deliberately NOT touched: the removed row's
    // `<kind>/<id>/<locale>/<sha>.md` objects become unreferenced and are
    // reclaimed by the Storage garbage collector.
    const { error } = await admin.from('portfolio_posts').delete().eq('id', id);

    if (error) throw error;

    await removePublicFileIfPresent(
      admin,
      existingPortfolio.image as string | null,
      bucket
    );
    await removePrefixBestEffort(admin, bucket, portfolioPostPrefix(id));

    const revalidation = await invalidatePublicContent({
      entity: 'portfolio',
      operation: 'delete',
      id,
    });
    return { success: true, revalidation };
  } catch (error) {
    console.error('Error deleting portfolio post:', error);
    return {
      success: false,
      error: 'Failed to delete portfolio post',
    };
  }
}

/** Upload image with a deterministic path (timestamp + title slug). Returns URL and blurhash for use in INSERT. */
async function uploadPortfolioImageForNewPost(
  file: File,
  titleEn: string,
  blurhashURL?: string
): Promise<PortfolioResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return {
      success: false,
      error: 'Unauthorized: You do not have permission to upload images',
    };
  }

  try {
    const fileValidation = validateImageFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();
    const bucket = getCmsStorageBucket();

    // Shared format-aware pipeline: extension + MIME follow the actual
    // processed format (WebP passthrough or Sharp fallback to PNG).
    const prepared = await prepareImageUpload(file, blurhashURL);
    if (!prepared.success) {
      return {
        success: false,
        error: prepared.error,
      };
    }

    const upload = await uploadImmutablePreparedImage(
      admin,
      bucket,
      PORTFOLIO_STAGING_PREFIX,
      titleEn || 'untitled',
      prepared.image
    );

    return {
      success: true,
      data: {
        image: upload.publicUrl,
        blurhashURL: prepared.image.blurhash,
        path: upload.path,
      },
    };
  } catch (error) {
    console.error('Error uploading portfolio image for new post:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload image',
    };
  }
}

/** Rollback a created post and its uploaded image (e.g. on apply failure). */
async function rollbackPortfolioCreate(
  postId: number,
  imagePath: string
): Promise<PortfolioResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return { success: false, error: 'Unauthorized' };
  }
  try {
    const admin = getAdminClient();
    const bucket = getCmsStorageBucket();
    // The row is the authoritative state: delete it first, then remove the
    // uploaded image best-effort. Storage-first would leave a surviving row
    // pointing at a deleted object if the DB delete failed.
    const { error } = await admin
      .from('portfolio_posts')
      .delete()
      .eq('id', postId);
    if (error) throw error;
    await removeStorageObjectBestEffort(admin, bucket, imagePath);
    return { success: true };
  } catch (error) {
    console.error('Error rolling back portfolio create:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Rollback failed',
    };
  }
}

async function uploadPortfolioImage(
  _supabase: SupabaseClient,
  portfolioId: number,
  file: File,
  _currentImageUrl?: string,
  blurhashURL?: string
): Promise<PortfolioResult> {
  try {
    await requireAllowedPostWriter();
  } catch {
    return {
      success: false,
      error: 'Unauthorized: You do not have permission to upload images',
    };
  }

  try {
    const fileValidation = validateImageFile(file);
    if (!fileValidation.isValid) {
      return { success: false, error: fileValidation.error };
    }

    const admin = getAdminClient();
    const bucket = getCmsStorageBucket();

    const { data: existingPortfolio, error: fetchError } = await admin
      .from('portfolio_posts')
      .select('id, title_en, image')
      .eq('id', portfolioId)
      .single();

    if (fetchError || !existingPortfolio) {
      return { success: false, error: 'Portfolio post not found' };
    }

    // Shared format-aware pipeline: extension + MIME follow the actual
    // processed format (WebP passthrough or Sharp fallback to PNG).
    const prepared = await prepareImageUpload(file, blurhashURL);
    if (!prepared.success) {
      return {
        success: false,
        error: prepared.error,
      };
    }

    // Unique immutable path: the new object never overwrites the previous one,
    // so a failed DB update can never leave the row pointing at a deleted
    // object. The previous DB-referenced object is removed AFTER the commit.
    const upload = await uploadImmutablePreparedImage(
      admin,
      bucket,
      portfolioPostPrefix(portfolioId),
      existingPortfolio.title_en || `portfolio-${portfolioId}`,
      prepared.image
    );

    const updateData: { image: string; blurhashURL?: string | null } = {
      image: upload.publicUrl,
    };
    updateData.blurhashURL = prepared.image.blurhash || null;

    const { error: updateError } = await admin
      .from('portfolio_posts')
      .update(updateData)
      .eq('id', portfolioId)
      .select('id')
      .single();

    if (updateError) {
      // Best-effort staged cleanup must never mask the DB error.
      await removeStorageObjectBestEffort(admin, bucket, upload.path);
      throw updateError;
    }

    await removePublicFileIfDifferent(
      admin,
      existingPortfolio.image,
      bucket,
      upload.path
    );

    const revalidation = await invalidatePublicContent({
      entity: 'portfolio',
      operation: 'asset-update',
      id: portfolioId,
    });
    return {
      success: true,
      data: { image: upload.publicUrl, blurhashURL: prepared.image.blurhash },
      revalidation,
    };
  } catch (error) {
    console.error('Error uploading portfolio image:', error);
    return {
      success: false,
      error: 'Failed to upload portfolio image',
    };
  }
}

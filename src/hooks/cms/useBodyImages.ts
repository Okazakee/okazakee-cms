'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { processImageToWebP } from '@/utils/imageProcessor';
import {
  parseBodyImages,
  pendingImageMarkdown,
  sanitizeImageAlt,
  type BodyImageUpload,
} from '@/utils/cms/postBody';
import { MAX_UPLOAD_SIZE_BYTES } from '@/utils/cms/validation';

export type PendingBodyImage = BodyImageUpload & {
  blobUrl: string;
};

export type StagedBodyImage = {
  localId: string;
  blobUrl: string;
  markdown: string;
};

const BODY_IMAGE_OPTIONS = {
  maxWidth: 1920,
  maxHeight: 1920,
  quality: 0.82,
  fit: 'inside' as const,
};

/**
 * Client-side staging for post body images. Picked files are compressed
 * to WebP + blurhashed (blurkit, via the shared canvas pipeline) and
 * referenced in the draft markdown as `blob:` URLs — zero server writes
 * until Publish sends the finished snapshot. Closing or discarding the
 * draft revokes the object URLs and leaves no residue behind.
 */
export function useBodyImages() {
  const [pending, setPending] = useState<PendingBodyImage[]>([]);
  const [stagingErrors, setStagingErrors] = useState<string[]>([]);
  const pendingRef = useRef<PendingBodyImage[]>([]);
  pendingRef.current = pending;

  const revokeUrls = useCallback((urls: string[]) => {
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  }, []);

  const revokeAll = useCallback(() => {
    revokeUrls(pendingRef.current.map((item) => item.blobUrl));
    pendingRef.current = [];
    setPending([]);
  }, [revokeUrls]);

  useEffect(() => {
    const urls = pendingRef.current.map((item) => item.blobUrl);
    return () => revokeUrls(urls);
  }, [revokeUrls]);

  const stageFiles = useCallback(
    async (files: FileList | File[]): Promise<StagedBodyImage[]> => {
      const list = Array.from(files);
      const staged: StagedBodyImage[] = [];
      const errors: string[] = [];
      for (const file of list) {
        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
          errors.push(
            `${file.name}: exceeds the 10 MB limit, pick a smaller file`
          );
          continue;
        }
        const processed = await processImageToWebP(file, BODY_IMAGE_OPTIONS);
        if (!processed.success || !processed.file) {
          errors.push(
            `${file.name}: ${processed.error ?? 'could not be processed'}`
          );
          continue;
        }
        const alt = sanitizeImageAlt(file.name, file.name);
        const localId =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        const blobUrl = URL.createObjectURL(processed.file);
        const entry: PendingBodyImage = {
          localId,
          file: processed.file,
          // Empty lets the server derive the real hash (e.g. animated
          // WebP, which skips client processing to keep every frame).
          blurhash: processed.blurhash ?? '',
          alt,
          blobUrl,
        };
        staged.push({
          localId,
          blobUrl,
          markdown: pendingImageMarkdown(alt, localId, blobUrl),
        });
        setPending((prev) => [...prev, entry]);
      }
      setStagingErrors(errors);
      return staged;
    },
    []
  );

  /**
   * Payload for publish: only staged files still referenced by the given
   * bodies. Unreferenced entries stay client-side until reconcile().
   */
  const referencedPayload = useCallback(
    (bodies: Array<string | undefined>): BodyImageUpload[] => {
      const wanted = new Set<string>();
      for (const body of bodies) {
        if (!body) continue;
        for (const ref of parseBodyImages(body)) {
          if (ref.pendingId) wanted.add(ref.pendingId);
        }
      }
      return pendingRef.current
        .filter((item) => wanted.has(item.localId))
        .map(({ localId, file, blurhash, alt }) => ({
          localId,
          file,
          blurhash,
          alt,
        }));
    },
    []
  );

  /**
   * Drops staged entries no body references anymore (image line deleted),
   * revoking their object URLs. Call after a successful publish, on
   * revert, and when discarding drafts.
   */
  const reconcile = useCallback(
    (bodies: Array<string | undefined>) => {
      const wanted = new Set<string>();
      for (const body of bodies) {
        if (!body) continue;
        for (const ref of parseBodyImages(body)) {
          if (ref.pendingId) wanted.add(ref.pendingId);
        }
      }
      const dropped = pendingRef.current.filter(
        (item) => !wanted.has(item.localId)
      );
      if (dropped.length === 0) return;
      revokeUrls(dropped.map((item) => item.blobUrl));
      const droppedIds = new Set(dropped.map((item) => item.localId));
      setPending((prev) =>
        prev.filter((item) => !droppedIds.has(item.localId))
      );
    },
    [revokeUrls]
  );

  const pendingBytes = useCallback(
    () =>
      pendingRef.current.reduce((total, item) => total + item.file.size, 0),
    []
  );

  return {
    pending,
    stagingErrors,
    clearStagingErrors: () => setStagingErrors([]),
    stageFiles,
    referencedPayload,
    reconcile,
    revokeAll,
    pendingBytes,
  };
}

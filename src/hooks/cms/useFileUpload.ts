'use client';

import { useCallback, useRef, useState } from 'react';
import { encode as encodeBlurhash } from 'blurkit/browser';
import { FALLBACK_BLURHASH } from '@/utils/blurhashUtils';
import { processImageToWebP } from '@/utils/imageProcessor';

interface ImageProcessingOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

interface UseFileUploadOptions {
  accept?: string;
  maxSizeMB?: number;
  imageProcessing?: ImageProcessingOptions;
  generateBlurhash?: boolean;
}

interface UseFileUploadReturn {
  file: File | null;
  previewUrl: string | null;
  blurhash: string | null;
  isProcessing: boolean;
  isDragging: boolean;
  error: string | null;
  dropzoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  fileInputProps: {
    type: string;
    accept: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  };
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  clearFile: () => void;
  setFileFromUrl: (url: string) => void;
  openFileDialog: () => void;
}

export function useFileUpload({
  accept = 'image/*',
  maxSizeMB = 10,
  imageProcessing,
  generateBlurhash = false,
}: UseFileUploadOptions = {}): UseFileUploadReturn {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [blurhash, setBlurhash] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const generateBlurhashFromFile = useCallback(
    async (f: File): Promise<string> => {
      try {
        const { hash } = await encodeBlurhash(f, { size: 32 });
        return hash;
      } catch {
        return FALLBACK_BLURHASH;
      }
    },
    []
  );

  const processFile = useCallback(
    async (f: File) => {
      if (maxSizeMB && f.size > maxSizeMB * 1024 * 1024) {
        setError(`File size exceeds ${maxSizeMB}MB limit`);
        return;
      }

      const acceptedTypes = accept
        .split(',')
        .map((t) => t.trim());
      const matchesType = acceptedTypes.some((t) => {
        const normalizedType = t.toLowerCase();
        const fileName = f.name.toLowerCase();
        const fileType = f.type.toLowerCase();

        if (normalizedType.startsWith('.')) {
          return fileName.endsWith(normalizedType);
        }

        if (t.endsWith('/*')) {
          const prefix = normalizedType.slice(0, -2);
          return fileType.startsWith(prefix);
        }

        return fileType === normalizedType || normalizedType === '*';
      });

      if (!matchesType && accept !== '*') {
        setError(`File type not accepted. Expected: ${accept}`);
        return;
      }

      setError(null);
      setFile(f);

      const objUrl = URL.createObjectURL(f);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return objUrl;
      });

      if (imageProcessing) {
        setIsProcessing(true);
        try {
          const processed = await processImageToWebP(f, {
            maxWidth: imageProcessing.maxWidth ?? 1920,
            maxHeight: imageProcessing.maxHeight ?? 1080,
            quality: imageProcessing.quality ?? 0.85,
          });

          if (processed.success && processed.file) {
            setFile(processed.file);
            const processedUrl = URL.createObjectURL(processed.file);
            setPreviewUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return processedUrl;
            });

            if (generateBlurhash) {
              const bh = await generateBlurhashFromFile(processed.file);
              setBlurhash(bh);
            }
          }
        } catch {
          // continue with original file
        } finally {
          setIsProcessing(false);
        }
      } else if (generateBlurhash) {
        const bh = await generateBlurhashFromFile(f);
        setBlurhash(bh);
      }
    },
    [accept, maxSizeMB, imageProcessing, generateBlurhash, generateBlurhashFromFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current += 1;
      setIsDragging(true);
    },
    []
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        processFile(files[0]);
      }
    },
    [processFile]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected) {
        processFile(selected);
      }
      e.target.value = '';
    },
    [processFile]
  );

  const clearFile = useCallback(() => {
    setFile(null);
    setPreviewUrl(null);
    setBlurhash(null);
    setError(null);
  }, []);

  const setFileFromUrl = useCallback((url: string) => {
    setPreviewUrl(url);
    setFile(null);
    setBlurhash(null);
  }, []);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return {
    file,
    previewUrl,
    blurhash,
    isProcessing,
    isDragging,
    error,
    dropzoneProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    fileInputProps: {
      type: 'file',
      accept,
      onChange: handleFileChange,
    },
    fileInputRef,
    clearFile,
    setFileFromUrl,
    openFileDialog,
  };
}

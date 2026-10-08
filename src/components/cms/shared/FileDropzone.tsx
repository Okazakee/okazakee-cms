'use client';

import {
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Upload,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import type React from 'react';

interface FileDropzoneProps {
  accept?: string;
  previewUrl: string | null;
  hasPendingFile: boolean;
  blurhash?: string | null;
  isDragging: boolean;
  isProcessing: boolean;
  error: string | null;
  currentUrl?: string | null;
  currentBlurhash?: string | null;
  dropzoneProps: {
    onDragEnter?: (e: React.DragEvent) => void;
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
  onClear: () => void;
  onBrowse: () => void;
  onCopyUrl?: () => void;
  onOpen?: () => void;
  onDownload?: () => void;
  label?: string;
  showUrl?: string | null;
  compact?: boolean;
}

export function FileDropzone({
  previewUrl,
  hasPendingFile,
  blurhash,
  isDragging,
  isProcessing,
  error,
  currentUrl,
  dropzoneProps,
  fileInputProps,
  fileInputRef,
  onClear,
  onBrowse,
  onCopyUrl,
  onOpen,
  onDownload,
  label,
  showUrl,
  compact = false,
}: FileDropzoneProps) {
  const t = useTranslations('cms');
  const displayUrl = previewUrl ?? currentUrl ?? null;
  const displayBlur = previewUrl ? blurhash : currentUrl ? blurhash : null;
  const normalizedDisplayUrl = displayUrl?.split('?')[0].toLowerCase() ?? null;
  const isPdf =
    normalizedDisplayUrl?.endsWith('.pdf') ||
    fileInputProps.accept.includes('.pdf');

  return (
    <div>
      {label && (
        <label className="block text-sm font-medium text-text-main mb-2">
          {label}
        </label>
      )}
      <div
        className={`relative border-2 border-dashed rounded-lg text-center transition-colors ${
          isDragging
            ? 'border-accent-violet bg-accent-violet/10 '
            : 'border-border-subtle hover:border-accent-violet'
        } ${compact ? 'p-4' : 'p-6 md:p-8'}`}
        {...dropzoneProps}
      >
        {isProcessing && (
          <div className="absolute inset-0 bg-surface-base/80 flex items-center justify-center rounded-lg z-10">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-accent-violet border-t-transparent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-sm text-text-main ">
                {t('common.processing')}
              </p>
            </div>
          </div>
        )}

        {isDragging && (
          <div className="absolute inset-0 bg-accent-violet/80 flex items-center justify-center rounded-lg z-10">
            <div className="text-center text-white">
              <Upload className="w-10 h-10 mx-auto mb-2" />
              <p className="font-medium">{t('common.dropFilesHere')}</p>
            </div>
          </div>
        )}

        {displayUrl ? (
          <div className="space-y-3">
            <p className="text-xs font-medium text-text-muted" role="status">
              {t(hasPendingFile ? 'editor.pendingFile' : 'editor.currentFile')}
            </p>
            {!isPdf ? (
              <div className="flex justify-center">
                <Image
                  src={displayUrl}
                  alt="Preview"
                  width={compact ? 120 : 200}
                  height={compact ? 120 : 200}
                  className="rounded-lg object-cover mx-auto"
                  placeholder={displayBlur ? 'blur' : 'empty'}
                  blurDataURL={displayBlur ?? undefined}
                  unoptimized={displayUrl.startsWith('blob:')}
                />
              </div>
            ) : (
              <details className="rounded-lg border border-border-subtle bg-surface-base text-left">
                <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm text-text-main">
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  {t('editor.preview')}
                </summary>
                <iframe
                  src={displayUrl}
                  title={t('editor.preview')}
                  className={`w-full border-t border-border-subtle ${compact ? 'h-56' : 'h-80 md:h-96'}`}
                />
              </details>
            )}
            {showUrl && (
              <details className="text-left text-xs text-text-muted">
                <summary className="min-h-11 cursor-pointer py-3">
                  {t('editor.fileUrl')}
                </summary>
                <p className="break-all pb-2">{showUrl}</p>
              </details>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onBrowse();
                }}
                className="min-h-11 rounded-lg bg-accent-violet-deep px-3 py-2 text-sm text-white transition-colors hover:bg-accent-violet"
              >
                {t('common.changeFile')}
              </button>
              {onCopyUrl && showUrl && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyUrl();
                  }}
                  className="min-h-11 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
                >
                  {t('common.copyUrl')}
                </button>
              )}
              {onOpen && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen();
                  }}
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  {t('editor.openFile')}
                </button>
              )}
              {onDownload && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload();
                  }}
                  className="min-h-11 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised"
                >
                  <Download className="w-3 h-3 inline mr-1" />
                  {t('common.download')}
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                className="min-h-11 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
              >
                <X className="w-3 h-3 inline mr-1" />
                {t('common.removeFile')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="space-y-2 cursor-pointer w-full"
            onClick={onBrowse}
          >
            <ImageIcon className="h-8 w-8 mx-auto text-text-dim" />
            <p className="text-sm text-text-main ">
              {t('common.dropFilesHere')}
            </p>
          </button>
        )}

        <input ref={fileInputRef} {...fileInputProps} className="hidden" />
      </div>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}

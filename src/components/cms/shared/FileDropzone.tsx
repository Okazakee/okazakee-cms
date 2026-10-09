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
  actionsLayout?: 'below' | 'side';
  /**
   * Full-width image with hover-reveal action overlay (desktop) instead of
   * the thumbnail + buttons-below layout. Touch screens always show the
   * actions since hover does not exist there. PDFs ignore this.
   */
  overlayActions?: boolean;
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
  actionsLayout = 'below',
  overlayActions = false,
}: FileDropzoneProps) {
  const t = useTranslations('cms');
  const displayUrl = previewUrl ?? currentUrl ?? null;
  const displayBlur = previewUrl ? blurhash : currentUrl ? blurhash : null;
  const normalizedDisplayUrl = displayUrl?.split('?')[0].toLowerCase() ?? null;
  const isPdf =
    normalizedDisplayUrl?.endsWith('.pdf') ||
    fileInputProps.accept.includes('.pdf');
  const sideActions = actionsLayout === 'side' && !isPdf;
  const actionCount =
    2 + (onCopyUrl && showUrl ? 1 : 0) + (onOpen ? 1 : 0) + (onDownload ? 1 : 0);
  const lastSpansFull = sideActions && actionCount % 2 === 1;

  const actionButtons = (
    <div
      className={`flex flex-wrap items-center justify-center gap-2 ${sideActions ? 'md:grid md:grid-cols-2 md:items-stretch' : ''}`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onBrowse();
        }}
        className={`min-h-11 rounded-lg bg-accent-violet-deep px-3 py-2 text-sm text-white transition-colors hover:bg-accent-violet ${sideActions ? 'md:w-full' : ''}`}
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
          className={`min-h-11 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised ${sideActions ? 'md:w-full' : ''}`}
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
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised ${sideActions ? 'md:w-full' : ''}`}
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
          className={`min-h-11 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised ${sideActions ? 'md:w-full' : ''}`}
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
        className={`min-h-11 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10 ${sideActions ? 'md:w-full' : ''} ${lastSpansFull ? 'md:col-span-2' : ''}`}
      >
        <X className="w-3 h-3 inline mr-1" />
        {t('common.removeFile')}
      </button>
    </div>
  );

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
        } ${overlayActions && displayUrl && !isPdf ? 'border-0 p-0' : compact ? 'p-4' : 'p-6 md:p-8'}`}
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
          overlayActions && !isPdf ? (
            <div className="group relative overflow-hidden rounded-lg border border-border-subtle">
              <Image
                src={displayUrl}
                alt="Preview"
                width={1200}
                height={630}
                className="h-auto max-h-[480px] w-full object-cover"
                placeholder={displayBlur ? 'blur' : 'empty'}
                blurDataURL={displayBlur ?? undefined}
                unoptimized={displayUrl.startsWith('blob:')}
              />
              <p
                className="absolute left-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white"
                role="status"
              >
                {t(hasPendingFile ? 'editor.pendingFile' : 'editor.currentFile')}
              </p>
              <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-3 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                {actionButtons}
              </div>
            </div>
          ) : sideActions ? (
            <div className="space-y-3 md:grid md:grid-cols-[200px_1fr] md:items-center md:gap-6 md:space-y-0 md:text-left">
              <div className="space-y-3">
                <p
                  className="text-xs font-medium text-text-muted"
                  role="status"
                >
                  {t(
                    hasPendingFile ? 'editor.pendingFile' : 'editor.currentFile'
                  )}
                </p>
                <div className="flex justify-center md:justify-start">
                  <Image
                    src={displayUrl}
                    alt="Preview"
                    width={compact ? 120 : 200}
                    height={compact ? 120 : 200}
                    className="rounded-lg object-cover"
                    placeholder={displayBlur ? 'blur' : 'empty'}
                    blurDataURL={displayBlur ?? undefined}
                    unoptimized={displayUrl.startsWith('blob:')}
                  />
                </div>
              </div>
              <div className="min-w-0 md:self-center">{actionButtons}</div>
            </div>
          ) : (
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
              {actionButtons}
            </div>
          )
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

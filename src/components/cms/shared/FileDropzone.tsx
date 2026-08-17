'use client';

import { Download, FileText, Image as ImageIcon, Upload, X } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import type React from 'react';

interface FileDropzoneProps {
  accept?: string;
  previewUrl: string | null;
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
  onDownload?: () => void;
  label?: string;
  showUrl?: string | null;
  compact?: boolean;
}

export function FileDropzone({
  previewUrl,
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
        <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-2">
          {label}
        </label>
      )}
      <div
        className={`relative border-2 border-dashed rounded-lg text-center transition-colors ${
          isDragging
            ? 'border-main bg-main/10 dark:bg-main/20'
            : 'border-gray-300 dark:border-lighttext2/30 hover:border-main'
        } ${compact ? 'p-4' : 'p-6 md:p-8'}`}
        {...dropzoneProps}
      >
        {isProcessing && (
          <div className="absolute inset-0 bg-bglight/80 dark:bg-darkergray/80 flex items-center justify-center rounded-lg z-10">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-main border-t-transparent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-sm text-darktext dark:text-lighttext">
                {t('common.processing')}
              </p>
            </div>
          </div>
        )}

        {isDragging && (
          <div className="absolute inset-0 bg-main/80 flex items-center justify-center rounded-lg z-10">
            <div className="text-center text-white">
              <Upload className="w-10 h-10 mx-auto mb-2" />
              <p className="font-medium">{t('common.dropFilesHere')}</p>
            </div>
          </div>
        )}

        {displayUrl ? (
          <div className="space-y-3">
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
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-lg border border-gray-200 dark:border-lighttext2/20 bg-white dark:bg-darkestgray">
                  <iframe
                    src={displayUrl}
                    title="PDF preview"
                    className={`w-full ${compact ? 'h-56' : 'h-80 md:h-96'}`}
                  />
                </div>
                <div className="flex items-center justify-center text-sm text-gray-500 dark:text-lighttext2">
                  <FileText className="w-4 h-4 mr-2" />
                  <span>PDF Document</span>
                </div>
              </div>
            )}
            {showUrl && (
              <p className="text-xs text-gray-500 dark:text-lighttext2 truncate max-w-full">
                {showUrl}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onBrowse();
                }}
                className="px-3 py-1.5 text-sm bg-secondary hover:bg-tertiary text-white rounded-lg transition-colors"
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
                  className="px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-white rounded-lg transition-colors"
                >
                  {t('common.copyUrl')}
                </button>
              )}
              {onDownload && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload();
                  }}
                  className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
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
                className="px-3 py-1.5 text-sm bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors"
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
            <ImageIcon className="h-8 w-8 mx-auto text-gray-400" />
            <p className="text-sm text-darktext dark:text-lighttext2">
              {t('common.dropFilesHere')}
            </p>
          </button>
        )}

        <input
          ref={fileInputRef}
          {...fileInputProps}
          className="hidden"
        />
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}

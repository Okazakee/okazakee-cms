'use client';

import { useTranslations } from 'next-intl';
import { VisualBodyEditor } from '@/components/cms/shared/VisualBodyEditor';
import type { StagedBodyImage } from '@/hooks/cms/useBodyImages';

/**
 * Post body field: the visual block editor with a preview entry point.
 * Storage stays plain markdown; every structural character hides behind
 * formatted blocks, like the rest of the CMS custom editors.
 */
export function PostBodyField({
  id,
  label,
  value,
  onChange,
  placeholder,
  stageImages,
  stagingErrors,
  onPreview,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  stageImages: (files: FileList | File[]) => Promise<StagedBodyImage[]>;
  stagingErrors: string[];
  onPreview: () => void;
}) {
  const t = useTranslations('cms.editor');

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label
          htmlFor={id}
          className="block text-sm font-medium text-text-main"
        >
          {label}
        </label>
        <button
          type="button"
          onClick={onPreview}
          className="inline-flex min-h-9 items-center rounded-md border border-border-subtle bg-surface-base px-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-raised hover:text-text-main"
        >
          {t('markdownPreview')}
        </button>
      </div>
      <VisualBodyEditor
        id={id}
        value={value}
        onChange={onChange}
        minHeight={220}
        placeholder={placeholder}
        stageImages={stageImages}
      />
      {stagingErrors.length > 0 && (
        <ul className="mt-2 space-y-1">
          {stagingErrors.map((message, index) => (
            <li key={index} className="text-xs text-red-500">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

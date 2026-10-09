'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MarkdownToolbar } from '@/components/cms/shared/MarkdownToolbar';
import type { StagedBodyImage } from '@/hooks/cms/useBodyImages';
import { quadActiveAt, violetActiveAt } from '@/utils/cms/postBody';

/**
 * Plain-textarea post body field with the minimal markdown toolbar.
 * Bodies are markdown documents: structure (`#`, `-`, fences, tables)
 * stays visible and only Bold/Violet/Image/Code have buttons. Image
 * picks are staged client-side by the parent hook; the markdown inserted
 * here references `blob:` URLs until Publish uploads the snapshot.
 */
export function PostBodyField({
  id,
  label,
  value,
  onChange,
  rows = 8,
  placeholder,
  stageImages,
  stagingErrors,
  onPreview,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  stageImages: (files: FileList | File[]) => Promise<StagedBodyImage[]>;
  stagingErrors: string[];
  onPreview: () => void;
}) {
  const t = useTranslations('cms.editor');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [formatActive, setFormatActive] = useState({
    bold: false,
    violet: false,
  });

  const refreshFormatState = useCallback(() => {
    const field = areaRef.current;
    if (!field) return;
    const from = field.selectionStart ?? 0;
    const to = field.selectionEnd ?? 0;
    setFormatActive({
      bold: quadActiveAt(field.value, from, to),
      violet: violetActiveAt(field.value, from, to),
    });
  }, []);

  // Locale switches swap the value underneath the same field.
  useEffect(() => {
    refreshFormatState();
  }, [value, refreshFormatState]);

  const insertAtCaret = (snippet: string) => {
    const field = areaRef.current;
    if (!field) {
      onChange(value ? `${value}\n\n${snippet}` : snippet);
      return;
    }
    const { selectionStart, selectionEnd, scrollTop } = field;
    const from = selectionStart ?? value.length;
    const to = selectionEnd ?? value.length;
    const before = value.slice(0, from);
    const after = value.slice(to);
    const gapBefore =
      before === '' || before.endsWith('\n\n')
        ? ''
        : before.endsWith('\n')
          ? '\n'
          : '\n\n';
    const gapAfter =
      after === '' || after.startsWith('\n\n')
        ? ''
        : after.startsWith('\n')
          ? '\n'
          : '\n\n';
    const next = `${before}${gapBefore}${snippet}${gapAfter}${after}`;
    onChange(next);
    const caret = before.length + gapBefore.length + snippet.length;
    requestAnimationFrame(() => {
      const current = areaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(caret, caret);
      current.scrollTop = scrollTop;
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const staged = await stageImages(files);
    for (const item of staged) insertAtCaret(item.markdown);
    if (fileRef.current) fileRef.current.value = '';
  };

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
          className="inline-flex min-h-9 items-center rounded-md px-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-raised hover:text-text-main"
        >
          {t('markdownPreview')}
        </button>
      </div>
      <MarkdownToolbar
        targetRef={areaRef}
        onChange={onChange}
        onPickImage={() => fileRef.current?.click()}
        boldActive={formatActive.bold}
        violetActive={formatActive.violet}
        onApplied={refreshFormatState}
      />
      <textarea
        id={id}
        ref={areaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        onSelect={refreshFormatState}
        onKeyUp={refreshFormatState}
        onClick={refreshFormatState}
        className="w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 font-mono text-sm text-text-main outline-none focus:border-accent-violet"
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => void handleFiles(e.target.files)}
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

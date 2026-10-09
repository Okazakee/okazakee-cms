'use client';

import { Braces, Highlighter, ImagePlus, Italic } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import {
  toggleInlineMarker,
  wrapCodeFence,
  type TextEdit,
} from '@/utils/cms/postBody';

function ToolButton({
  label,
  active,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(event: MouseEvent) => {
        // Keep focus (and the selection) inside the textarea.
        event.preventDefault();
        onPress();
      }}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent-violet-deep bg-accent-violet-deep text-white'
          : 'border-border-subtle bg-surface-base text-text-muted hover:bg-surface-raised hover:text-text-main'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Minimal markdown toolbar for post bodies. Operates on a plain textarea
 * ref with caret/scroll restore: Bold writes `****` (white on the site),
 * Violet writes `* *` (violet on the site), Code wraps a fenced block,
 * Image opens the parent-owned file dialog. Nothing is hidden — bodies
 * are markdown documents and structure stays visible.
 */
export function MarkdownToolbar({
  targetRef,
  onChange,
  onPickImage,
  boldActive = false,
  violetActive = false,
  onApplied,
}: {
  targetRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (next: string) => void;
  onPickImage: () => void;
  boldActive?: boolean;
  violetActive?: boolean;
  /** Fires after a button applied its edit (selection already restored). */
  onApplied?: () => void;
}) {
  const t = useTranslations('cms.editor');

  const applyEdit = (edit: (value: string) => TextEdit) => {
    const field = targetRef.current;
    if (!field) return;
    const { value, scrollTop } = field;
    const next = edit(value);
    onChange(next.text);
    requestAnimationFrame(() => {
      const current = targetRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(next.caretStart, next.caretEnd);
      current.scrollTop = scrollTop;
      onApplied?.();
    });
  };

  const selectionOf = (): { value: string; from: number; to: number } => {
    const field = targetRef.current;
    const value = field?.value ?? '';
    return {
      value,
      from: field?.selectionStart ?? value.length,
      to: field?.selectionEnd ?? value.length,
    };
  };

  return (
    <div
      role="toolbar"
      aria-label={t('markdownToolbar')}
      className="mb-1 flex flex-wrap items-center gap-1"
    >
      <ToolButton
        label={t('markdownBold')}
        active={boldActive}
        onPress={() => {
          const { value, from, to } = selectionOf();
          applyEdit(() => toggleInlineMarker(value, from, to, '****'));
        }}
      >
        <Highlighter className="h-4 w-4" aria-hidden="true" />
        {t('markdownBold')}
      </ToolButton>
      <ToolButton
        label={t('markdownViolet')}
        active={violetActive}
        onPress={() => {
          const { value, from, to } = selectionOf();
          applyEdit(() => toggleInlineMarker(value, from, to, '*'));
        }}
      >
        <Italic className="h-4 w-4" aria-hidden="true" />
        {t('markdownViolet')}
      </ToolButton>
      <ToolButton label={t('markdownImage')} onPress={onPickImage}>
        <ImagePlus className="h-4 w-4" aria-hidden="true" />
        {t('markdownImage')}
      </ToolButton>
      <ToolButton
        label={t('markdownCode')}
        onPress={() => {
          const { value, from, to } = selectionOf();
          applyEdit(() => wrapCodeFence(value, from, to));
        }}
      >
        <Braces className="h-4 w-4" aria-hidden="true" />
        {t('markdownCode')}
      </ToolButton>
    </div>
  );
}

'use client';

import { Bold, Eraser, Italic } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { MouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { editorInputClass } from '@/components/cms/shared/EditorBody';
import { sanitizeRichText } from '@/libs/resume/template';

function findNowrap(
  node: Node | null,
  root: HTMLElement
): HTMLElement | null {
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (current && current !== root) {
    if (
      current.tagName === 'SPAN' &&
      current.classList.contains('nowrap')
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

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
        // Keep focus (and the selection) inside the editor.
        event.preventDefault();
        onPress();
      }}
      className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border px-2 text-sm transition-colors ${
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
 * Lightweight rich-text field for the resume builder. The editable model
 * is sanitized HTML, but the user never types markup: keystrokes and
 * pastes land as plain text (auto-escaped), and <strong>/<em>/
 * <span class="nowrap"> only ever come from the toolbar.
 */
export function RichTextEditor({
  value,
  onChange,
  minHeight = 44,
}: {
  value: string;
  onChange: (next: string) => void;
  minHeight?: number;
}) {
  const t = useTranslations('cms.resume.builder');
  const editorRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [boldActive, setBoldActive] = useState(false);
  const [italicActive, setItalicActive] = useState(false);
  const [nowrapActive, setNowrapActive] = useState(false);

  // Mount plus external changes (revert, bullet add/remove/reorder):
  // reset the DOM. Own keystrokes skip this via lastEmitted, keeping
  // the caret where the user left it.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && value !== lastEmitted.current) {
      editor.innerHTML = value;
      lastEmitted.current = value;
    }
  }, [value]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const clean = sanitizeRichText(editor.innerHTML);
    lastEmitted.current = clean;
    onChange(clean);
  }, [onChange]);

  const refreshStates = useCallback(() => {
    try {
      setBoldActive(document.queryCommandState('bold'));
      setItalicActive(document.queryCommandState('italic'));
    } catch {
      // queryCommandState is deprecated but universal; ignore failures.
    }
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      setNowrapActive(false);
      return;
    }
    setNowrapActive(
      !selection.isCollapsed && !!findNowrap(selection.anchorNode, editor)
    );
  }, []);

  const toggleNowrap = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    if (selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const existing = findNowrap(selection.anchorNode, editor);
    if (existing?.contains(selection.focusNode)) {
      const parent = existing.parentNode;
      if (!parent) return;
      while (existing.firstChild) {
        parent.insertBefore(existing.firstChild, existing);
      }
      parent.removeChild(existing);
      return;
    }
    const span = document.createElement('span');
    span.className = 'nowrap';
    try {
      span.appendChild(range.extractContents());
    } catch {
      return;
    }
    range.insertNode(span);
    selection.selectAllChildren(span);
    selection.collapseToEnd();
  }, []);

  const clearFormatting = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      document.execCommand('removeFormat');
    } catch {
      // ignore
    }
    for (const span of Array.from(
      editor.querySelectorAll('span.nowrap')
    )) {
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    // Pasted markup arrives as plain text: no raw tags, no scripts.
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    try {
      document.execCommand('insertText', false, text);
    } catch {
      // ignore
    }
  }, []);

  const handleBlur = useCallback(() => {
    // Snap the visible DOM back to the stored (sanitized) value so any
    // stripped markup the browser briefly rendered disappears.
    const editor = editorRef.current;
    if (editor && lastEmitted.current !== null) {
      editor.innerHTML = lastEmitted.current;
    }
    setBoldActive(false);
    setItalicActive(false);
    setNowrapActive(false);
  }, []);

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-base focus-within:border-accent-violet">
      <div
        role="toolbar"
        aria-label={t('formatToolbar')}
        className="flex items-center gap-1 border-b border-border-subtle bg-surface-card px-2 py-1"
      >
        <ToolButton
          label={t('toolbarBold')}
          active={boldActive}
          onPress={() => {
            try {
              document.execCommand('bold');
            } catch {
              // ignore
            }
            emit();
            refreshStates();
          }}
        >
          <Bold className="h-4 w-4" aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label={t('toolbarItalic')}
          active={italicActive}
          onPress={() => {
            try {
              document.execCommand('italic');
            } catch {
              // ignore
            }
            emit();
            refreshStates();
          }}
        >
          <Italic className="h-4 w-4" aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label={t('toolbarNowrap')}
          active={nowrapActive}
          onPress={() => {
            toggleNowrap();
            emit();
            refreshStates();
          }}
        >
          <span className="font-mono text-xs font-semibold">a↔b</span>
        </ToolButton>
        <ToolButton
          label={t('toolbarClear')}
          onPress={() => {
            clearFormatting();
            emit();
            refreshStates();
          }}
        >
          <Eraser className="h-4 w-4" aria-hidden="true" />
        </ToolButton>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a contentEditable rich-text region needs the explicit textbox role; input/textarea cannot host formatted content */}
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={t('richEditor')}
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={handleBlur}
        onPaste={handlePaste}
        onSelect={refreshStates}
        onKeyUp={refreshStates}
        onClick={refreshStates}
        style={{ minHeight }}
        className={`cms-rich-editor ${editorInputClass} rounded-none border-0 px-3 py-2 focus:border-0`}
      />
    </div>
  );
}

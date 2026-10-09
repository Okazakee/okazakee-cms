'use client';

import { Highlighter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { MouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { editorInputClass } from '@/components/cms/shared/EditorBody';
import {
  editorDomToMarkers,
  markersToHtml,
} from '@/utils/cms/markers';

function findMarker(node: Node | null, root: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (current && current !== root) {
    if (current.hasAttribute('data-marker')) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Visual editor for the `****text****` violet-highlight syntax. Highlighted
 * runs show as violet spans with the markers hidden; typing and pasting
 * stay plain text (auto-escaped) and the DOM serializes back to the exact
 * storage text. The toolbar's Highlight button wraps/unwraps the selection.
 */
export function MarkerEditor({
  id,
  value,
  onChange,
  multiline,
  minHeight,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  multiline: boolean;
  minHeight: number;
  placeholder?: string;
}) {
  const t = useTranslations('cms.editor');
  const editorRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [highlightActive, setHighlightActive] = useState(false);

  // Mount plus external changes (revert, locale switch): reset the DOM.
  // Own keystrokes skip this via lastEmitted, keeping the caret.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && value !== lastEmitted.current) {
      editor.innerHTML = markersToHtml(value);
      lastEmitted.current = value;
    }
  }, [value]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = editorDomToMarkers(editor);
    lastEmitted.current = next;
    onChange(next);
  }, [onChange]);

  const refreshState = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    setHighlightActive(
      !!editor &&
        !!selection &&
        selection.rangeCount > 0 &&
        !selection.isCollapsed &&
        !!findMarker(selection.anchorNode, editor)
    );
  }, []);

  const toggleHighlight = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return false;
    if (selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    const existing = findMarker(selection.anchorNode, editor);
    if (existing?.contains(selection.focusNode)) {
      const parent = existing.parentNode;
      if (!parent) return false;
      while (existing.firstChild) {
        parent.insertBefore(existing.firstChild, existing);
      }
      parent.removeChild(existing);
    } else {
      const span = document.createElement('span');
      span.setAttribute('data-marker', '1');
      try {
        span.appendChild(range.extractContents());
      } catch {
        return false;
      }
      range.insertNode(span);
      selection.selectAllChildren(span);
      selection.collapseToEnd();
    }
    return true;
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
    // Snap the visible DOM back to the stored text.
    const editor = editorRef.current;
    if (editor && lastEmitted.current !== null) {
      editor.innerHTML = markersToHtml(lastEmitted.current);
    }
    setHighlightActive(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!multiline && event.key === 'Enter') event.preventDefault();
    },
    [multiline]
  );

  const handlePress = (event: MouseEvent) => {
    // Keep focus (and the selection) inside the editor.
    event.preventDefault();
    if (toggleHighlight()) emit();
    refreshState();
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-base focus-within:border-accent-violet">
      <div
        role="toolbar"
        aria-label={t('highlightButton')}
        className="flex items-center gap-1 border-b border-border-subtle bg-surface-card px-2 py-1"
      >
        <button
          type="button"
          title={t('highlightButton')}
          aria-label={t('highlightButton')}
          onMouseDown={(event: MouseEvent) => event.preventDefault()}
          onClick={handlePress}
          className={`inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
            highlightActive
              ? 'border-accent-violet-deep bg-accent-violet-deep text-white'
              : 'border-border-subtle bg-surface-base text-text-muted hover:bg-surface-raised hover:text-text-main'
          }`}
        >
          <Highlighter className="h-4 w-4" aria-hidden="true" />
          {t('highlightButton')}
        </button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a contentEditable marker region needs the explicit textbox role; input/textarea cannot host highlighted runs */}
      <div
        ref={editorRef}
        id={id}
        role="textbox"
        aria-multiline={multiline}
        aria-label={t('highlightButton')}
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? ''}
        onInput={emit}
        onBlur={handleBlur}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onSelect={refreshState}
        onKeyUp={refreshState}
        onClick={refreshState}
        style={{ minHeight }}
        className={`cms-marker-editor ${editorInputClass} rounded-none border-0 px-3 py-2 whitespace-pre-wrap focus:border-0`}
      />
    </div>
  );
}

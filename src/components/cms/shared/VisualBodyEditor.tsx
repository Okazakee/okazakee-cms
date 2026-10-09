'use client';

import {
  Bold,
  Braces,
  Heading,
  ImagePlus,
  Italic,
  Link2,
  List,
  Quote,
  Table2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { MouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StagedBodyImage } from '@/hooks/cms/useBodyImages';
import {
  editorDomToMarkdown,
  markdownToEditorHtml,
} from '@/utils/cms/bodyBlocks';

function findAncestor(
  node: Node | null,
  root: HTMLElement,
  predicate: (element: HTMLElement) => boolean
): HTMLElement | null {
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (current && current !== root) {
    if (predicate(current)) return current;
    current = current.parentElement;
  }
  return null;
}

const isMark = (tag: string, names: string[]): boolean =>
  names.includes(tag);

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

type FormatState = {
  bold: boolean;
  violet: boolean;
  link: boolean;
  heading: number;
  list: boolean;
  quote: boolean;
  code: boolean;
};

const IDLE_FORMAT: FormatState = {
  bold: false,
  violet: false,
  link: false,
  heading: 0,
  list: false,
  quote: false,
  code: false,
};

/**
 * Visual post-body editor. Storage markdown renders as formatted blocks
 * (headings, lists, code, quotes, tables, figures, rules) with all syntax
 * hidden; typing, toolbar and paste serialize back to the exact storage
 * text. Images stay blob-staged until Publish, like the textarea flow.
 */
export function VisualBodyEditor({
  id,
  value,
  onChange,
  minHeight,
  placeholder,
  stageImages,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  minHeight: number;
  placeholder?: string;
  stageImages: (files: FileList | File[]) => Promise<StagedBodyImage[]>;
}) {
  const t = useTranslations('cms.editor');
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const [format, setFormat] = useState<FormatState>(IDLE_FORMAT);
  const [linkBar, setLinkBar] = useState<{ href: string; fresh: boolean } | null>(
    null
  );
  const linkInputRef = useRef<HTMLInputElement | null>(null);

  // Mount plus external changes (revert, locale switch): reset the DOM.
  // Own keystrokes skip this via lastEmitted, keeping the caret.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && value !== lastEmitted.current) {
      editor.innerHTML = markdownToEditorHtml(value);
      lastEmitted.current = value;
    }
  }, [value]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = editorDomToMarkdown(editor);
    lastEmitted.current = next;
    onChange(next);
  }, [onChange]);

  const currentBlock = useCallback((): HTMLElement | null => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return null;
    return findAncestor(selection.anchorNode, editor, (element) =>
      element.hasAttribute('data-block')
    );
  }, []);

  const refreshFormat = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      setFormat(IDLE_FORMAT);
      return;
    }
    const inEditor =
      editor.contains(selection.anchorNode) &&
      (selection.isCollapsed ||
        (selection.focusNode !== null &&
          editor.contains(selection.focusNode)));
    if (!inEditor) {
      setFormat(IDLE_FORMAT);
      return;
    }
    const strong = findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['STRONG', 'B'])
    );
    const em = findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['EM', 'I'])
    );
    const link = findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['A'])
    );
    const block = currentBlock();
    const inList = !!findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['UL', 'OL'])
    );
    const inQuote = !!findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['BLOCKQUOTE'])
    );
    const inCode = !!findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['PRE'])
    );
    const headingLevel =
      block && /^H[1-6]$/.test(block.tagName)
        ? Number(block.tagName.slice(1))
        : 0;
    const covers = (element: HTMLElement | null): boolean => {
      if (!element || selection.isCollapsed) return false;
      const endContainer = selection.focusNode ?? selection.anchorNode;
      return !!endContainer && element.contains(endContainer);
    };
    setFormat({
      bold: !!strong && (selection.isCollapsed || covers(strong)),
      violet: !!em && (selection.isCollapsed || covers(em)),
      link: !!link,
      heading: headingLevel,
      list: inList,
      quote: inQuote,
      code: inCode,
    });
  }, [currentBlock]);

  const replaceBlock = useCallback(
    (block: HTMLElement, html: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      const nodes = Array.from(wrapper.childNodes);
      block.replaceWith(...nodes);
      const first = nodes[0];
      const selection = window.getSelection();
      if (selection && first) {
        selection.selectAllChildren(first);
        selection.collapseToEnd();
        editor.focus();
      }
    },
    []
  );

  const toggleInline = useCallback(
    (tag: 'STRONG' | 'EM') => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) return;
      if (selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      const names = tag === 'STRONG' ? ['STRONG', 'B'] : ['EM', 'I'];
      const existing = findAncestor(selection.anchorNode, editor, (element) =>
        isMark(element.tagName, names)
      );
      if (
        existing?.contains(selection.focusNode ?? selection.anchorNode)
      ) {
        const parent = existing.parentNode;
        if (!parent) return;
        while (existing.firstChild) {
          parent.insertBefore(existing.firstChild, existing);
        }
        parent.removeChild(existing);
      } else {
        const wrapper = document.createElement(tag);
        try {
          wrapper.appendChild(range.extractContents());
        } catch {
          return;
        }
        range.insertNode(wrapper);
        selection.selectAllChildren(wrapper);
        selection.collapseToEnd();
      }
    },
    []
  );

  const press = useCallback(
    (action: () => void) => {
      action();
      emit();
      refreshFormat();
    },
    [emit, refreshFormat]
  );

  const cycleHeading = useCallback(() => {
    const block = currentBlock();
    if (!block) return;
    const level = /^H([1-6])$/.exec(block.tagName)?.[1];
    const next = !level ? '2' : level === '2' ? '3' : null;
    if (next === null) {
      replaceBlock(
        block,
        `<p data-block="paragraph">${block.innerHTML}</p>`
      );
    } else {
      replaceBlock(
        block,
        `<h${next} data-block="heading" data-level="${next}">${block.innerHTML}</h${next}>`
      );
    }
  }, [currentBlock, replaceBlock]);

  const toggleList = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const list = findAncestor(
      window.getSelection()?.anchorNode ?? null,
      editor,
      (element) => isMark(element.tagName, ['UL', 'OL'])
    );
    if (list) {
      const items = Array.from(list.querySelectorAll(':scope > li'));
      const paragraphs = items
        .map((item) => `<p data-block="paragraph">${item.innerHTML}</p>`)
        .join('');
      replaceBlock(list, paragraphs || '<p data-block="paragraph"><br></p>');
      return;
    }
    const block = currentBlock();
    if (!block) return;
    replaceBlock(
      block,
      `<ul data-block="list" data-style="-"><li data-marker="-">${block.innerHTML}</li></ul>`
    );
  }, [currentBlock, replaceBlock]);

  const toggleQuote = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const quote = findAncestor(
      window.getSelection()?.anchorNode ?? null,
      editor,
      (element) => isMark(element.tagName, ['BLOCKQUOTE'])
    );
    if (quote) {
      replaceBlock(
        quote,
        `<p data-block="paragraph">${quote.innerHTML}</p>`
      );
      return;
    }
    const block = currentBlock();
    if (!block) return;
    replaceBlock(
      block,
      `<blockquote data-block="quote">${block.innerHTML}</blockquote>`
    );
  }, [currentBlock, replaceBlock]);

  const toggleCode = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const pre = findAncestor(
      window.getSelection()?.anchorNode ?? null,
      editor,
      (element) => isMark(element.tagName, ['PRE'])
    );
    if (pre) {
      const code = pre.querySelector('code');
      const text = code ? code.innerText ?? '' : pre.innerText ?? '';
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      replaceBlock(pre, `<p data-block="paragraph">${escaped}</p>`);
      return;
    }
    const block = currentBlock();
    if (!block) return;
    const text = block.innerText ?? '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    replaceBlock(
      block,
      `<pre data-block="code" data-lang=""><code>${escaped}</code></pre>`
    );
  }, [currentBlock, replaceBlock]);

  const insertTable = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const table = document.createElement('table');
    table.setAttribute('data-block', 'table');
    table.innerHTML =
      '<tbody><tr><th>Header</th><th>Header</th></tr><tr><td></td><td></td></tr></tbody>';
    range.deleteContents();
    range.insertNode(table);
    const firstCell = table.querySelector('th');
    selection.selectAllChildren(firstCell ?? table);
    selection.collapseToStart();
  }, []);

  const openLinkBar = useCallback(
    (href: string, fresh: boolean) => {
      setLinkBar({ href, fresh });
      requestAnimationFrame(() => linkInputRef.current?.focus());
    },
    []
  );

  const pressLink = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const existing = findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['A'])
    );
    if (existing) {
      openLinkBar(
        existing.getAttribute('data-href') ??
          existing.getAttribute('href') ??
          '',
        false
      );
      return;
    }
    if (selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const anchor = document.createElement('a');
    anchor.setAttribute('data-href', '');
    try {
      anchor.appendChild(range.extractContents());
    } catch {
      return;
    }
    range.insertNode(anchor);
    selection.selectAllChildren(anchor);
    openLinkBar('', true);
  }, [openLinkBar]);

  const applyLinkHref = useCallback(
    (href: string) => {
      const editor = editorRef.current;
      const trimmed = href.trim();
      const target = editor
        ? findAncestor(
            window.getSelection()?.anchorNode ?? null,
            editor,
            (element) => isMark(element.tagName, ['A'])
          )
        : null;
      if (target) {
        if (trimmed) {
          target.setAttribute('data-href', trimmed);
          target.setAttribute('title', trimmed);
        } else {
          const parent = target.parentNode;
          if (parent) {
            while (target.firstChild) {
              parent.insertBefore(target.firstChild, target);
            }
            parent.removeChild(target);
          }
        }
      }
      setLinkBar(null);
      emit();
      refreshFormat();
    },
    [emit, refreshFormat]
  );

  const insertImageFigure = useCallback(
    (staged: StagedBodyImage) => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      const figureHtml =
        `<figure data-block="image" contenteditable="false" data-pending="1" data-local-id="${staged.localId}" data-hash="">` +
        `<img src="${staged.blobUrl}" alt="">` +
        `<figcaption>${staged.alt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</figcaption>` +
        `<button type="button" data-remove-image="1" aria-label="Remove image">×</button>` +
        `</figure>`;
      if (!editor || !selection || selection.rangeCount === 0) {
        editor?.insertAdjacentHTML('beforeend', figureHtml);
        emit();
        return;
      }
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      const wrapper = document.createElement('div');
      wrapper.innerHTML = figureHtml;
      const figure = wrapper.firstElementChild;
      if (!figure) return;
      range.insertNode(figure);
      selection.selectAllChildren(figure);
      selection.collapseToEnd();
      emit();
    },
    [emit]
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const staged = await stageImages(files);
      for (const item of staged) insertImageFigure(item);
    },
    [stageImages, insertImageFigure]
  );

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const inPre = !!findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['PRE'])
    );
    const inItem = !!findAncestor(selection.anchorNode, editor, (element) =>
      isMark(element.tagName, ['LI'])
    );
    event.preventDefault();
    let text = event.clipboardData.getData('text/plain');
    if (!inPre) {
      // Markdown soft breaks flow as spaces inside running text; blank
      // lines stay structural so pasted documents keep their blocks.
      text = inItem
        ? text.replace(/\s+/g, ' ')
        : text
            .split(/\n{2,}/)
            .map((chunk) => chunk.replace(/\s+/g, ' '))
            .join('\n\n');
    }
    try {
      document.execCommand('insertText', false, text);
    } catch {
      // ignore
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const editor = editorRef.current;
      const target = event.target as HTMLElement | null;
      // Caption dashes would shift the blurhash segment: use an en dash.
      if (
        event.key === '-' &&
        target &&
        editor &&
        target !== editor &&
        target.closest?.('figcaption')
      ) {
        event.preventDefault();
        try {
          document.execCommand('insertText', false, '–');
        } catch {
          // ignore
        }
        return;
      }
      // Tab walks table cells (appending a row at the end) instead of
      // leaving the editor.
      if (event.key === 'Tab' && editor) {
        const cell = target
          ? target.closest?.('th, td') ?? null
          : null;
        if (cell) {
          event.preventDefault();
          const row = cell.parentElement;
          const table = cell.closest?.('table') ?? null;
          const cells = row
            ? Array.from(row.querySelectorAll('th, td'))
            : [];
          const index = cells.indexOf(cell as HTMLTableCellElement);
          const next = cells[index + 1];
          const selection = window.getSelection();
          if (next && selection) {
            selection.selectAllChildren(next);
            return;
          }
          if (table && row && row === table.querySelector('tr:last-child')) {
            const columns = Math.max(cells.length, 1);
            const body =
              table.querySelector('tbody') ?? table;
            const newRow = document.createElement('tr');
            for (let c = 0; c < columns; c += 1) {
              newRow.appendChild(document.createElement('td'));
            }
            body.appendChild(newRow);
            const first = newRow.querySelector('td');
            if (first && selection) selection.selectAllChildren(first);
            emit();
          }
        }
      }
    },
    [emit]
  );

  const handleBlur = useCallback(() => {
    // Snap the visible DOM back to the stored markdown.
    const editor = editorRef.current;
    if (editor && lastEmitted.current !== null) {
      editor.innerHTML = markdownToEditorHtml(lastEmitted.current);
    }
    setFormat(IDLE_FORMAT);
  }, []);

  const handleClick = useCallback(
    (event: MouseEvent) => {
      const editor = editorRef.current;
      const target = event.target as HTMLElement | null;
      const remover = target?.closest?.('[data-remove-image]') ?? null;
      if (remover && editor) {
        event.preventDefault();
        remover.closest('figure')?.remove();
        emit();
        refreshFormat();
      }
    },
    [emit, refreshFormat]
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-base focus-within:border-accent-violet">
      <div
        role="toolbar"
        aria-label={t('markdownToolbar')}
        className="flex flex-wrap items-center gap-1 border-b border-border-subtle bg-surface-card px-2 py-1"
      >
        <ToolButton
          label={t('markdownBold')}
          active={format.bold}
          onPress={() => press(() => toggleInline('STRONG'))}
        >
          <Bold className="h-4 w-4" aria-hidden="true" />
          {t('markdownBold')}
        </ToolButton>
        <ToolButton
          label={t('markdownViolet')}
          active={format.violet}
          onPress={() => press(() => toggleInline('EM'))}
        >
          <Italic className="h-4 w-4" aria-hidden="true" />
          {t('markdownViolet')}
        </ToolButton>
        <ToolButton
          label={t('markdownLink')}
          active={format.link}
          onPress={() => press(pressLink)}
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          {t('markdownLink')}
        </ToolButton>
        <ToolButton
          label={t('markdownHeading')}
          active={format.heading > 0}
          onPress={() => press(cycleHeading)}
        >
          <Heading className="h-4 w-4" aria-hidden="true" />
          {t('markdownHeading')}
        </ToolButton>
        <ToolButton
          label={t('markdownList')}
          active={format.list}
          onPress={() => press(toggleList)}
        >
          <List className="h-4 w-4" aria-hidden="true" />
          {t('markdownList')}
        </ToolButton>
        <ToolButton
          label={t('markdownQuote')}
          active={format.quote}
          onPress={() => press(toggleQuote)}
        >
          <Quote className="h-4 w-4" aria-hidden="true" />
          {t('markdownQuote')}
        </ToolButton>
        <ToolButton
          label={t('markdownTable')}
          onPress={() => press(insertTable)}
        >
          <Table2 className="h-4 w-4" aria-hidden="true" />
          {t('markdownTable')}
        </ToolButton>
        <ToolButton
          label={t('markdownImage')}
          onPress={() => fileRef.current?.click()}
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          {t('markdownImage')}
        </ToolButton>
        <ToolButton
          label={t('markdownCode')}
          active={format.code}
          onPress={() => press(toggleCode)}
        >
          <Braces className="h-4 w-4" aria-hidden="true" />
          {t('markdownCode')}
        </ToolButton>
      </div>
      {linkBar && (
        <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-card px-2 py-1">
          <input
            ref={linkInputRef}
            type="url"
            defaultValue={linkBar.href}
            placeholder={t('markdownLinkUrl')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLinkHref(linkInputRef.current?.value ?? '');
              }
              if (event.key === 'Escape') {
                event.stopPropagation();
                if (linkBar.fresh) applyLinkHref('');
                else setLinkBar(null);
              }
            }}
            onBlur={() => applyLinkHref(linkInputRef.current?.value ?? '')}
            className="min-h-9 w-full rounded-md border border-border-subtle bg-surface-base px-2 text-xs text-text-main outline-none focus:border-accent-violet"
          />
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a contentEditable document region needs the explicit textbox role; textarea cannot host formatted blocks */}
      <div
        ref={editorRef}
        id={id}
        role="textbox"
        aria-multiline="true"
        aria-label={t('markdownToolbar')}
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? ''}
        onInput={emit}
        onBlur={handleBlur}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onSelect={refreshFormat}
        onKeyUp={refreshFormat}
        onClick={(event) => {
          handleClick(event);
          refreshFormat();
        }}
        style={{ minHeight }}
        className="cms-visual-body focus:border-0 w-full rounded-none border-0 px-3 py-2 text-sm leading-relaxed text-text-main outline-none"
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

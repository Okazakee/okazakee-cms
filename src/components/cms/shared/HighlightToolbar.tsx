'use client';

import { Highlighter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { RefObject } from 'react';
import { toggleHighlightMarkers } from '@/utils/cms/highlight';

/**
 * One-button toolbar for the `****text****` violet-highlight syntax.
 * Operates on a plain textarea/input ref: select text, click, and the
 * selection is wrapped (or unwrapped) without typing markers by hand.
 * The mousedown guard keeps the field's selection while clicking.
 */
export function HighlightToolbar({
  targetRef,
  onChange,
}: {
  targetRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  onChange: (next: string) => void;
}) {
  const t = useTranslations('cms.editor');

  const apply = () => {
    const field = targetRef.current;
    if (!field) return;
    const { value, scrollTop } = field;
    const edit = toggleHighlightMarkers(
      value,
      field.selectionStart ?? value.length,
      field.selectionEnd ?? value.length
    );
    onChange(edit.text);
    requestAnimationFrame(() => {
      const current = targetRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(edit.caretStart, edit.caretEnd);
      current.scrollTop = scrollTop;
    });
  };

  return (
    <div className="mb-1 flex items-center">
      <button
        type="button"
        title={t('highlightButton')}
        aria-label={t('highlightButton')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={apply}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-raised hover:text-text-main"
      >
        <Highlighter className="h-4 w-4" aria-hidden="true" />
        {t('highlightButton')}
      </button>
    </div>
  );
}

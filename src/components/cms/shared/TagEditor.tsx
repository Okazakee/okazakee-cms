'use client';

import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { parsePostTags, serializePostTags } from '@/utils/cms/postTags';

/**
 * Chip editor for post tags. Tags add one at a time (Enter or Add button),
 * quotes are stripped since they delimit storage, chips remove with ×.
 * The stored string stays the canonical JSON form the site parses.
 */
export function TagEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const t = useTranslations('cms');
  const tags = parsePostTags(value);

  const commit = (next: string[]) => {
    onChange(serializePostTags(next));
  };

  const add = () => {
    const cleaned = draft.replace(/"/g, '').trim();
    if (!cleaned) return;
    if (!tags.includes(cleaned)) commit([...tags, cleaned]);
    setDraft('');
  };

  return (
    <div>
      <label
        htmlFor={`${id}-input`}
        className="mb-1 block text-sm font-medium text-text-main"
      >
        {label}
      </label>
      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-lg border border-border-subtle bg-surface-raised px-2 py-1 font-mono text-xs text-text-main"
            >
              {tag}
              <button
                type="button"
                onClick={() => commit(tags.filter((t) => t !== tag))}
                aria-label={`Remove ${tag}`}
                className="rounded p-0.5 text-text-muted transition-colors hover:text-red-400"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          id={`${id}-input`}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="min-h-11 w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main outline-none focus:border-accent-violet"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.replace(/"/g, '').trim()}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-raised disabled:opacity-40"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

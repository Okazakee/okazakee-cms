'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  editorInputClass,
  editorLabelClass,
} from '@/components/cms/shared/EditorBody';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className={editorLabelClass}>{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs text-text-muted">{hint}</span>
      )}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`${editorInputClass} ${mono ? 'font-mono' : ''}`}
    />
  );
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  mono = false,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      className={`${editorInputClass} resize-y ${mono ? 'font-mono text-xs' : ''}`}
    />
  );
}

export function ListEditor<T>({
  items,
  onChange,
  renderItem,
  addLabel,
  upLabel,
  downLabel,
  removeLabel,
  onCreate,
}: {
  items: T[];
  onChange: (next: T[]) => void;
  renderItem: (item: T, onPatch: (patch: Partial<T>) => void) => ReactNode;
  addLabel: string;
  upLabel: string;
  downLabel: string;
  removeLabel: string;
  onCreate: () => T;
}) {
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div
          key={index}
          className="rounded-xl border border-border-subtle bg-surface-base p-3"
        >
          <div className="mb-2 flex items-center justify-end gap-1">
            <button
              type="button"
              aria-label={upLabel}
              title={upLabel}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              className="rounded-md p-2 text-text-muted transition-colors hover:bg-surface-raised disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={downLabel}
              title={downLabel}
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
              className="rounded-md p-2 text-text-muted transition-colors hover:bg-surface-raised disabled:opacity-30"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              className="rounded-md p-2 text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          {renderItem(item, (patch) =>
            onChange(
              items.map((current, i) =>
                i === index ? { ...current, ...patch } : current
              )
            )
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, onCreate()])}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-border-subtle px-4 py-2 text-sm text-text-muted transition-colors hover:border-accent-violet hover:text-text-main"
      >
        <Plus className="h-4 w-4" />
        {addLabel}
      </button>
    </div>
  );
}

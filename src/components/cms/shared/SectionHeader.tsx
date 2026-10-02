'use client';

import type { ReactNode } from 'react';

interface SectionHeaderProps {
  title: string;
  description?: string;
  meta?: string;
  actions?: ReactNode;
}

export function SectionHeader({
  title,
  description,
  meta,
  actions,
}: SectionHeaderProps) {
  return (
    <div className="mb-8 text-center">
      <h1 className="font-heading text-2xl font-semibold text-text-white sm:text-3xl">
        {title}
      </h1>
      {description && (
        <p className="mt-2 font-mono text-xs text-accent-violet-light sm:text-sm">
          {description}
        </p>
      )}
      <div className="mx-auto mt-3 h-0.5 w-10 rounded-full bg-accent-violet" />
      {meta && <p className="text-sm text-text-dim mb-2">{meta}</p>}
      {actions && (
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {actions}
        </div>
      )}
    </div>
  );
}

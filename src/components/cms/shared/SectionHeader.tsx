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
    <div className="text-center mb-6 md:mb-8">
      <h1 className="hidden lg:block text-2xl md:text-3xl lg:text-4xl font-bold text-main mb-2 md:mb-4">
        {title}
      </h1>
      {description && (
        <p className="text-gray-500 dark:text-lighttext2 text-sm md:text-base lg:text-lg mb-4">
          {description}
        </p>
      )}
      {meta && (
        <p className="text-sm text-gray-400 dark:text-lighttext2/70 mb-2">
          {meta}
        </p>
      )}
      {actions && (
        <div className="flex flex-col sm:flex-row justify-center gap-3 mt-4">
          {actions}
        </div>
      )}
    </div>
  );
}

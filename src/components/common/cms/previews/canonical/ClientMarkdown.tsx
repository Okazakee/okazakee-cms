'use client';

import { MarkdownRenderer } from '@/components/layout/MarkdownRenderer';

/**
 * Canonical markdown renderer (mirrors the public site). Previews render draft
 * bodies with plain markdown, inside the shared `.post` prose scope.
 */
export function ClientMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <MarkdownRenderer markdown={children ?? ''} />
    </div>
  );
}

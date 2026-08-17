'use client';

import Markdown from 'markdown-to-jsx';

/**
 * Renders markdown on the client to avoid RSC serialization issues with
 * markdown-to-jsx elements (missing _store.validated in React 19 / Next 16).
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
      <Markdown options={{ forceBlock: true }}>{children ?? ''}</Markdown>
    </div>
  );
}

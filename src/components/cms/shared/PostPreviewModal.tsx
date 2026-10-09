'use client';

import { MarkdownPreview } from '@/components/cms/shared/MarkdownPreview';
import { ModalShell } from '@/components/cms/shared/ModalShell';

/**
 * Rendered body preview in a resume-style modal: full-page on mobile,
 * centered dialog on desktop. Shows the active locale exactly as the
 * shared markdown rules render it (pending blob images included).
 */
export function PostPreviewModal({
  title,
  markdown,
  closeLabel,
  onClose,
}: {
  title: string;
  markdown: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <ModalShell title={title} closeLabel={closeLabel} onClose={onClose}>
      <MarkdownPreview markdown={markdown} />
    </ModalShell>
  );
}

'use client';

interface InnerHtmlProps {
  html: string;
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div';
  className?: string;
}

export function InnerHtml({
  html,
  as: Tag = 'span',
  className,
}: InnerHtmlProps) {
  return (
    <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

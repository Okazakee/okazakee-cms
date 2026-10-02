'use client';
import Markdown from 'markdown-to-jsx';
import { Children, isValidElement, type ReactNode } from 'react';
import NextImage from '@/components/layout/NextImage';
import { type PreChild, PreCustom } from './PreCustom';

function MarkdownImage({ src, alt = '' }: { src?: string; alt?: string }) {
  // Public content uses ![alt-blurDataURL](url) for inline image metadata.
  const split = alt.indexOf('-');
  const label = split < 0 ? alt : alt.slice(0, split);
  const blurhash = split < 0 ? undefined : alt.slice(split + 1);
  return <NextImage src={src || ''} alt={label} blurhash={blurhash} />;
}

export function MarkdownRenderer({ markdown }: { markdown: string }) {
  return (
    <Markdown
      options={{
        forceBlock: true,
        overrides: {
          p: {
            component: ({ children }: { children: ReactNode }) => {
              const nodes = Children.toArray(children);
              const onlyImages =
                nodes.length > 0 &&
                nodes.every(
                  (child) =>
                    isValidElement(child) &&
                    (child.type === 'img' || child.type === MarkdownImage)
                );
              return onlyImages ? children : <p>{children}</p>;
            },
          },
          pre: {
            component: ({ children }: { children: PreChild }) => (
              <PreCustom>{children}</PreCustom>
            ),
          },
          img: { component: MarkdownImage },
        },
      }}
    >
      {markdown}
    </Markdown>
  );
}

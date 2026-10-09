'use client';

import Markdown from 'markdown-to-jsx';
import { Fragment, type ReactNode } from 'react';

function CmsFigure({ src, alt }: { src?: unknown; alt?: unknown }) {
  // Same first-dash contract as the public site: caption before the dash,
  // blur placeholder after it (ignored here; plain img needs neither).
  const rawAlt = typeof alt === 'string' ? alt : '';
  const dash = rawAlt.indexOf('-');
  const caption = dash < 0 ? rawAlt : rawAlt.slice(0, dash);
  const imageSrc = typeof src === 'string' ? src : '';
  if (!imageSrc) return null;
  return (
    <figure className="cms-post-figure">
      {/* biome-ignore lint/performance/noImgElement: blob-staged and arbitrary-host preview URLs cannot go through NextImage optimization */}
      <img src={imageSrc} alt={caption} loading="lazy" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function CmsPre({ children }: { children?: ReactNode }) {
  return (
    <div className="cms-post-codeblock">
      <div className="cms-post-codehead">Code</div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

function isFigureChild(child: unknown): boolean {
  if (typeof child !== 'object' || child === null) return false;
  const type = (child as { type?: unknown }).type;
  return type === CmsFigure || type === 'figure' || type === 'img';
}

function CmsParagraph({ children }: { children?: ReactNode }) {
  // Mirrors the public site: figures can never nest inside <p>, so
  // image-only runs render bare and mixed runs split into text
  // paragraphs plus sibling figures.
  const list = (Array.isArray(children) ? children : [children]).filter(
    (child) => !(typeof child === 'string' && child.trim() === '')
  );
  if (list.length === 0) return null;
  if (list.every(isFigureChild)) return <>{children}</>;
  if (list.some(isFigureChild)) {
    const blocks: ReactNode[] = [];
    let run: ReactNode[] = [];
    const flushRun = () => {
      if (run.length > 0) {
        blocks.push(<p key={`t-${blocks.length}`}>{run}</p>);
        run = [];
      }
    };
    list.forEach((child, index) => {
      if (isFigureChild(child)) {
        flushRun();
        blocks.push(<Fragment key={`f-${index}`}>{child}</Fragment>);
      } else {
        run.push(child);
      }
    });
    flushRun();
    return <>{blocks}</>;
  }
  return <p>{children}</p>;
}

/**
 * CMS-side post body preview. Mirrors the public site's structural rules
 * (block figures with captions, code blocks) so broken syntax is visible
 * before publish. Colors are approximate — the production theme owns the
 * final palette.
 */
export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="cms-post">
      <Markdown
        options={{
          forceBlock: true,
          overrides: {
            img: { component: CmsFigure },
            pre: { component: CmsPre },
            p: { component: CmsParagraph },
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

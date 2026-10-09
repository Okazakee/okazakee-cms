'use client';

import Markdown from 'markdown-to-jsx';

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

function CmsPre({ children }: { children?: React.ReactNode }) {
  return (
    <div className="cms-post-codeblock">
      <div className="cms-post-codehead">Code</div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
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
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

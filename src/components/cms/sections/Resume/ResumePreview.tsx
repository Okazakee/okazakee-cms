'use client';

import { useEffect, useRef, useState } from 'react';

/** A4 width in CSS pixels (210mm at 96dpi). */
const PAGE_WIDTH_PX = 794;

export function ResumePreview({
  html,
  title,
  overflowMessage,
}: {
  html: string;
  title: string;
  overflowMessage: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [frameHeight, setFrameHeight] = useState(1200);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const width = container.clientWidth;
      if (width > 0) setScale(Math.min(1, width / PAGE_WIDTH_PX));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setOverflow(false);
  }, [html]);

  const measure = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    setFrameHeight(doc.documentElement.scrollHeight || 1200);
    const pages = Array.from(doc.querySelectorAll('.page'));
    setOverflow(
      pages.some((page) => page.scrollHeight > page.clientHeight + 4)
    );
  };

  const handleLoad = () => {
    measure();
    const doc = iframeRef.current?.contentDocument;
    // Webfonts shift metrics after load: re-measure once settled.
    doc?.fonts?.ready.then(() => measure()).catch(() => undefined);
  };

  return (
    <div>
      {overflow && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
        >
          {overflowMessage}
        </p>
      )}
      <div ref={containerRef} className="w-full overflow-hidden rounded-xl">
        <div
          style={{
            width: PAGE_WIDTH_PX,
            height: frameHeight * scale,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <iframe
            ref={iframeRef}
            title={title}
            sandbox="allow-same-origin"
            srcDoc={html}
            onLoad={handleLoad}
            style={{
              width: PAGE_WIDTH_PX,
              height: frameHeight,
              border: 0,
              background: 'transparent',
            }}
          />
        </div>
      </div>
    </div>
  );
}

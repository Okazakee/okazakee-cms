'use client';

import { useEffect, useRef, useState } from 'react';

/** Gap between chips in every state — also the marquee's loop distance slack. */
const CHIP_GAP = 6;

/**
 * Single-row chip list (docs/DESIGN.md §5.2), canonical copy of the public
 * site: the chips render once while they fit and only become a seamless
 * marquee when the row overflows. The second copy exists only while looping.
 * Chips must carry `mr-1.5` so the loop junction matches the inner spacing.
 */
export const ChipRow = ({ children }: { children: React.ReactNode }) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [looping, setLooping] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    const track = trackRef.current;
    const viewport = viewportRef.current;
    if (!track || !viewport) return;

    const measure = () => {
      const copies = looping ? 2 : 1;
      // Track width includes the trailing chip gap; it must not count as
      // overflow, or a row that fits exactly would start looping.
      const single = track.scrollWidth / copies - CHIP_GAP;
      const reduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;
      const overflows = single > viewport.clientWidth + 1;

      if (overflows && !reduced) {
        if (!looping) setLooping(true);
        setDuration(Math.max(12, Math.round((single + CHIP_GAP) / 45)));
        return;
      }

      if (looping) setLooping(false);
      setDuration(null);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [looping]);

  return (
    <div
      className="tags-viewport relative w-full overflow-hidden"
      ref={viewportRef}
    >
      <div
        className={`flex w-max ${looping ? 'animate-tags' : ''}`}
        ref={trackRef}
        style={
          looping && duration
            ? ({ '--tags-duration': `${duration}s` } as React.CSSProperties)
            : undefined
        }
      >
        <div className={looping ? 'flex shrink-0' : 'contents'}>{children}</div>
        {looping ? (
          <div aria-hidden="true" className="flex shrink-0">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
};

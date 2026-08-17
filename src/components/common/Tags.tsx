'use client';
import { Tag } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

export const Tags = ({ tags }: { tags: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [totalWidth, setTotalWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  const reworkedTags = useMemo(() => {
    return tags
      ? Array.from(tags.matchAll(/"([^"]*?)"/g), (match) => match[1])
      : [];
  }, [tags]);

  useEffect(() => {
    const calculateWidths = () => {
      if (containerRef.current) {
        const tagElements = containerRef.current.querySelectorAll('.tag');
        let width = 0;

        for (const el of tagElements) {
          width += el.getBoundingClientRect().width + 8; // Include spacing
        }

        setTotalWidth(width);
        setContainerWidth(containerRef.current.offsetWidth); // Update container width
      }
    };

    calculateWidths();
    window.addEventListener('resize', calculateWidths);
    return () => window.removeEventListener('resize', calculateWidths);
  }, []);

  const shouldAnimate = useMemo(() => {
    return totalWidth > containerWidth;
  }, [totalWidth, containerWidth]);

  return (
    <div className="relative overflow-hidden w-full">
      <div
        ref={containerRef}
        className={`flex whitespace-nowrap transition-all duration-400 ease-in-out ${
          shouldAnimate ? 'animate-carousel' : 'flex-wrap'
        }`}
        style={
          shouldAnimate
            ? ({
                '--total-width': `${totalWidth}px`,
                '--container-width': '100%',
              } as React.CSSProperties)
            : {}
        }
      >
        {reworkedTags.map((tag) => (
          <span
            key={tag}
            className="tag bg-secondary text-lighttext text-sm xs:text-base sm:text-base gap-1.5 xs:gap-2 sm:gap-2 px-2 py-1 rounded-lg flex items-center mr-2 xs:mb-1 sm:mb-1 sm:mt-2 xs:mt-2 mt-1"
          >
            <Tag size={15} className="w-[14px] xs:w-[15px] sm:w-[15px]" />
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
};

export default Tags;

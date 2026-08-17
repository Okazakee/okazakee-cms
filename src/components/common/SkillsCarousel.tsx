'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

export const SkillsCarousel = ({
  skills,
  isEven,
}: {
  skills: string[];
  isEven?: boolean;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [totalWidth, setTotalWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const calculateWidths = () => {
      if (containerRef.current) {
        const skillElements =
          containerRef.current.querySelectorAll('.skill-tag');
        let width = 0;

        for (const el of skillElements) {
          width += el.getBoundingClientRect().width + 8; // Include spacing
        }

        setTotalWidth(width);
        setContainerWidth(containerRef.current.offsetWidth);
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
          shouldAnimate
            ? 'animate-carousel'
            : `flex-wrap justify-center ${isEven ? 'md:justify-end' : 'md:justify-start'}`
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
        {skills.map((skill) => (
          <span
            key={skill}
            className="skill-tag bg-secondary text-white px-2 py-1 rounded-md text-xs mr-2"
          >
            {skill}
          </span>
        ))}
      </div>
    </div>
  );
};

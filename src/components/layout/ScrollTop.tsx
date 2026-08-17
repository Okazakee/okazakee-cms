'use client';

import { ArrowUpToLine } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { scrollToSection } from '@/utils/scrollToSection';

export default function ScrollTop() {
  const [showLink, setShowLink] = useState(false);
  const [buttonOffset, setButtonOffset] = useState(16); // Initial offset from bottom in px
  const [opacity, setOpacity] = useState(0); // Start with opacity 0
  const t = useTranslations('footer');

  const handleScroll = useCallback(() => {
    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const totalHeight = document.body.scrollHeight;

    setShowLink(scrollY > 50); // Start showing link earlier (at 50px down)

    // Adjust opacity based on scroll position (fade in as user scrolls down)
    const fadeInThreshold = 200;
    const opacityValue = Math.min(1, (scrollY - 50) / (fadeInThreshold - 50)); // Gradual fade-in effect
    setOpacity(opacityValue);

    // Adjust button offset when near the bottom
    if (scrollY + viewportHeight >= totalHeight - 200) {
      setButtonOffset(100 - (totalHeight - (scrollY + viewportHeight)));
    } else {
      setButtonOffset(16); // Reset to default offset
    }
  }, []);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    showLink && (
      <button
        type="button"
        className="cursor-pointer fixed z-40 right-4 md:right-8 flex items-center justify-center text-base xs:text-lg sm:text-lg bg-darktext text-lighttext dark:bg-lighttext dark:text-darktext p-3 md:px-4 md:py-2 rounded-xl shadow-lg transition-opacity duration-400"
        style={{
          bottom: `${buttonOffset}px`,
          opacity: opacity,
        }}
        onClick={() => scrollToSection('about')}
      >
        <span className="hidden md:inline">{t('right')}</span>
        <ArrowUpToLine className="ml-0 md:ml-2" />
      </button>
    )
  );
}

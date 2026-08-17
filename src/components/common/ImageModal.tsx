import { X } from 'lucide-react';
import Image from 'next/image';
import { useEffect } from 'react';
import { useZoom } from '@/app/hooks/useZoom';

interface ImageModalProps {
  src: string;
  alt: string;
  blurDataURL: string;
  onClose: () => void;
}

export const ImageModal: React.FC<ImageModalProps> = ({
  src,
  alt,
  blurDataURL,
  onClose,
}) => {
  const {
    scale,
    position,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    blockScroll,
  } = useZoom();

  useEffect(() => {
    const unblock = blockScroll();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      unblock();
      window.removeEventListener('keydown', handleEscape);
    };
  }, [blockScroll, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75 backdrop-blur-xs -top-4">
      <div className="relative w-full h-full max-w-(--breakpoint-2xl)">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 md:top-10 right-4 md:right-0 z-10 p-2 dark:bg-lighttext bg-darktext dark:text-darktext text-lighttext rounded-md"
          aria-label="Close modal"
        >
          <X className="w-6 h-6" />
        </button>
        <div
          className="w-full h-full overflow-hidden"
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div
            style={{
              transform: `scale(${scale}) translate(${position.x}px, ${position.y}px)`,
              transition: 'transform 0.1s ease-out',
            }}
            className="w-full h-full flex items-center justify-center"
          >
            <Image
              src={src}
              alt={alt}
              placeholder="blur"
              blurDataURL={blurDataURL}
              quality={100}
              fill
              sizes="100vw"
              style={{ objectFit: 'contain' }}
              className="pointer-events-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

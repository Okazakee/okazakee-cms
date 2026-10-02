'use client';
import Image from 'next/image';
import { useState } from 'react';
import { ImageModal } from '../common/ImageModal';

interface NextImageProps {
  src: string;
  alt: string;
  blurhash?: string;
}

const NextImage = ({ src, alt, blurhash }: NextImageProps) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <Image
        src={src}
        alt={alt}
        width={1280}
        height={720}
        title="Click to view"
        placeholder={blurhash ? 'blur' : 'empty'}
        blurDataURL={blurhash || undefined}
        sizes="(min-width: 1024px) 1024px, 100vw"
        style={{
          objectFit: 'cover',
          objectPosition: 'center',
        }}
        onClick={() => setIsModalOpen(true)}
      />
      {alt ? <span className="fig-caption">{alt}</span> : null}
      {isModalOpen && (
        <ImageModal
          src={src}
          alt={alt}
          blurDataURL={blurhash || ''}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
};

export default NextImage;

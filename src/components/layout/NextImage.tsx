'use client';
import Image from 'next/image';
import { useState } from 'react';
import { ImageModal } from '../common/ImageModal';

interface NextImageProps {
  src: string;
  alt: string;
  blurhash: string;
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
        placeholder="blur"
        blurDataURL={blurhash}
        sizes="(min-width: 1024px) 1024px, 100vw"
        style={{
          objectFit: 'cover',
          objectPosition: 'center',
        }}
        className="rounded-xl cursor-pointer border border-main mx-auto max-h-200 w-auto"
        onClick={() => setIsModalOpen(true)}
      />
      {isModalOpen && (
        <ImageModal
          src={src}
          alt={alt}
          blurDataURL={blurhash}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
};

export default NextImage;

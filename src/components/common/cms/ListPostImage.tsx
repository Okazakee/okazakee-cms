'use client';

import { Image as ImageIcon } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';

/** Shows post image in CMS list: picked file (object URL) or existing image URL. */
export function ListPostImage({
  imageFile,
  imageUrl,
  blurhashURL,
  alt,
  compact = false,
}: {
  imageFile?: File | null;
  imageUrl?: string | null;
  blurhashURL?: string | null;
  alt: string;
  compact?: boolean;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!imageFile) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const src = objectUrl ?? imageUrl ?? null;
  if (!src) {
    return (
      <div
        className={`${compact ? 'h-16 w-20 shrink-0' : 'h-48'} flex items-center justify-center bg-surface-base`}
      >
        <ImageIcon className="h-8 w-8 text-accent-violet" />
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={300}
      height={200}
      className={`${compact ? 'h-16 w-20 shrink-0' : 'w-full h-48'} object-cover`}
      placeholder={blurhashURL && !objectUrl ? 'blur' : 'empty'}
      blurDataURL={objectUrl ? undefined : (blurhashURL ?? undefined)}
      unoptimized={src.startsWith('blob:')}
    />
  );
}

'use client';

import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatLabels } from '@/utils/formatLabels';

const PebbleClipPath = () => (
  <svg width="0" height="0" viewBox="0 0 500 500" className="absolute">
    <title>PebbleClipPath</title>
    <defs>
      <clipPath id="pebble-clip" clipPathUnits="objectBoundingBox">
        <path
          d="M 301.84,388.777 C 221.246,383.98 159.047,350.918 120.738,280.84 89.77,224.195 98.645,160.863 142.883,107.434 176.789,66.477 220.562,42.488 273.078,34.992 c 68.402,-9.765 123.5,20.813 155.106,80.125 21.683,40.692 29.902,84.567 29.117,130.129 -0.477,27.418 -5.43,54.246 -19.746,78.402 -19.985,33.723 -50.903,51.606 -88.25,59.106 -16.184,3.246 -32.817,4.23 -47.465,6.023"
          transform="scale(0.0027) translate(-100,-30)"
        />
      </clipPath>
    </defs>
  </svg>
);

interface HeroPreviewProps {
  mainImage: string;
  blurhashURL: string;
}

export function HeroPreview({ mainImage, blurhashURL }: HeroPreviewProps) {
  const pathname = usePathname();
  const _locale = pathname.split('/')[1] || 'en';
  const t = useTranslations('hero-section');

  return (
    <section className="md:mx-10 mx-5 md:h-svh flex items-center md:mt-20">
      <PebbleClipPath />
      <div>
        <div className="flex flex-col xl:flex-row items-center xl:justify-around">
          {/* Image Container */}
          <div
            className="relative
              w-[230px] xs:w-[250px] tablet:w-[300px] xl:w-[340px]
              h-[230px] xs:h-[250px] tablet:h-[300px] xl:h-[340px]
              xl:mr-10 mb-10 md:mb-20 mt-14 md:mt-20"
          >
            {/* Pebble Border (separate layer) */}
            <svg
              viewBox="0 0 500 500"
              className="absolute inset-0 z-0"
              style={{
                transform: 'scale(1.15)',
                overflow: 'visible',
                pointerEvents: 'none',
              }}
            >
              <title>background svg</title>
              <path
                d="M301.84,388.777C221.246,383.98 159.047,350.918 120.738,280.84 89.77,224.195 98.645,160.863 142.883,107.434 176.789,66.477 220.562,42.488 273.078,34.992c68.402,-9.765 123.5,20.813 155.106,80.125 21.683,40.692 29.902,84.567 29.117,130.129 -0.477,27.418 -5.43,54.246 -19.746,78.402 -19.985,33.723 -50.903,51.606 -88.25,59.106 -16.184,3.246 -32.817,4.23 -47.465,6.023"
                fill="#8B52FB"
                transform="scale(1.22) translate(-80, -10)"
              />
            </svg>

            {/* Clipped Image */}
            <div className="relative clip-pebble w-full h-full drop-shadow-2xl dark:drop-shadow-none">
              <Image
                priority
                src={mainImage}
                fill
                sizes="(min-width: 1280px) 340px, (min-width: 768px) 300px, (min-width: 475px) 250px, 230px"
                className="object-cover"
                alt="Profile picture"
                placeholder="blur"
                blurDataURL={blurhashURL}
              />
            </div>
          </div>
          <div className="text-center text-xl xs:text-2xl tablet:text-4xl lg:text-[3.5rem] drop-shadow-2xl dark:drop-shadow-none">
            <h1
              className="xl:mb-10 md:mb-12 mb-5"
              dangerouslySetInnerHTML={{ __html: formatLabels(t('top.name')) }}
            />
            <h2
              dangerouslySetInnerHTML={{ __html: formatLabels(t('top.role')) }}
            />
          </div>
        </div>
        <div className="flex items-center text-center mt-10 md:mt-20">
          <div>
            <h1
              className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-10"
              dangerouslySetInnerHTML={{ __html: t('aboutme.title') }}
            />
            <p
              className="text-left text-base xs:text-[1.2rem] tablet:text-lg tablet:mx-8 tracking-[0.02em] xs:leading-snug md:leading-normal lg:text-2xl"
              dangerouslySetInnerHTML={{
                __html: formatLabels(t('aboutme.paragraph')),
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

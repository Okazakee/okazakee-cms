'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { formatLabels } from '@/utils/formatLabels';
import { InnerHtml } from './canonical/InnerHtml';

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

/**
 * Canonical hero and about block (docs/DESIGN.md §6), driven by the draft
 * image props and the current `hero-section` messages. Missing copy degrades
 * to an empty string instead of throwing.
 */
export function HeroPreview({ mainImage, blurhashURL }: HeroPreviewProps) {
  const t = useTranslations('hero-section');

  const paragraph = t.has('aboutme.paragraph') ? t('aboutme.paragraph') : '';
  const paragraphs = paragraph.split('\n\n').filter((block) => block.trim());
  const unoptimized =
    mainImage.startsWith('blob:') || mainImage.startsWith('data:');

  return (
    <>
      <section
        className="bg-surface-alt/50 pt-24 pb-10 md:pt-36 md:pb-12"
        id="home"
      >
        <PebbleClipPath />
        <div className="mx-auto max-w-5xl px-6">
          <div className="flex flex-col items-center xl:flex-row xl:justify-center xl:gap-16">
            <div className="relative mb-10 aspect-square w-[200px] shrink-0 md:mb-12 md:w-[240px] xl:mb-0 xl:w-[260px]">
              {/* Pebble border, drawn behind the clipped image */}
              <svg
                className="absolute inset-0 z-0"
                style={{
                  transform: 'scale(1.15)',
                  overflow: 'visible',
                  pointerEvents: 'none',
                }}
                viewBox="0 0 500 500"
              >
                <title>background svg</title>
                <path
                  d="M301.84,388.777C221.246,383.98 159.047,350.918 120.738,280.84 89.77,224.195 98.645,160.863 142.883,107.434 176.789,66.477 220.562,42.488 273.078,34.992c68.402,-9.765 123.5,20.813 155.106,80.125 21.683,40.692 29.902,84.567 29.117,130.129 -0.477,27.418 -5.43,54.246 -19.746,78.402 -19.985,33.723 -50.903,51.606 -88.25,59.106 -16.184,3.246 -32.817,4.23 -47.465,6.023"
                  fill="var(--c-accent-violet)"
                  transform="scale(1.22) translate(-80, -10)"
                />
              </svg>

              <div className="clip-pebble relative h-full w-full">
                <Image
                  alt="Profile picture"
                  blurDataURL={blurhashURL || undefined}
                  className="object-cover"
                  fill
                  placeholder={blurhashURL ? 'blur' : 'empty'}
                  priority
                  sizes="(min-width: 1280px) 260px, (min-width: 768px) 240px, 200px"
                  src={mainImage}
                  unoptimized={unoptimized}
                />
              </div>
            </div>

            <div className="max-w-2xl text-center">
              <InnerHtml
                as="h1"
                className="mb-3 font-heading text-3xl font-semibold tracking-tight text-text-white sm:text-4xl md:text-5xl"
                html={formatLabels(t.has('top.name') ? t('top.name') : '')}
              />
              <InnerHtml
                as="p"
                className="font-mono text-lg tracking-normal text-text-muted md:text-xl"
                html={formatLabels(t.has('top.role') ? t('top.role') : '')}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-surface-alt/50 py-16" id="about">
        <div className="mx-auto max-w-3xl px-6">
          <div className="mb-10 text-center">
            <InnerHtml
              as="h2"
              className="font-heading text-2xl font-semibold text-text-white sm:text-3xl"
              html={formatLabels(
                t.has('aboutme.title') ? t('aboutme.title') : ''
              )}
            />
            <div className="mx-auto mt-3 h-0.5 w-10 rounded-full bg-accent-violet" />
          </div>

          <div className="space-y-4 rounded-2xl border border-border-subtle bg-surface-card p-6 text-sm leading-relaxed text-text-main/90 sm:p-8 md:text-base md:leading-6">
            {paragraphs.map((block) => (
              <InnerHtml
                as="p"
                html={formatLabels(block)}
                key={block.slice(0, 24)}
              />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

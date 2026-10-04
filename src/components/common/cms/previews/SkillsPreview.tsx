import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatLabels } from '@/utils/formatLabels';
import { InnerHtml } from './canonical/InnerHtml';
import { sortSkillsByPosition } from './canonical/skillOrder';

type Skill = {
  id: number;
  title: string;
  icon: string;
  invert: boolean;
  blurhashURL: string;
  link: string | null;
  position: number | null;
};

type SkillsCategory = {
  id: number;
  name: string;
  skills: Skill[];
};

const tileClass =
  'group flex aspect-square w-24 flex-col items-center justify-center gap-2 rounded-xl border border-border-subtle bg-surface-card p-3 transition-colors hover:border-accent-violet/50 hover:bg-surface-card-hover sm:w-32 md:w-[150px]';

interface SkillsPreviewProps {
  categories: SkillsCategory[];
}

/**
 * Canonical skills grid (docs/DESIGN.md §6): centred square tiles per category,
 * three per row on mobile and six from `md` up, with the real icon URLs from
 * the draft and no hover zoom — the tile itself is the hover target.
 *
 * Mirrors the public section exactly: skills are ordered by the canonical
 * comparator (`canonical/skillOrder.ts`) and a tile with a `link` renders as an
 * external anchor, an unlinked tile renders as a plain `<div>`.
 */
export function SkillsPreview({ categories }: SkillsPreviewProps) {
  const t = useTranslations('skills-section');

  return (
    <section className="mx-auto max-w-5xl px-6 py-24" id="skills">
      <div className="mb-16 text-center">
        <InnerHtml
          as="h2"
          className="font-heading text-2xl font-semibold text-text-white sm:text-3xl"
          html={formatLabels(t.has('title') ? t('title') : '')}
        />
        <InnerHtml
          as="p"
          className="mt-2 font-mono text-xs text-accent-violet-light sm:text-sm"
          html={formatLabels(t.has('subtitle') ? t('subtitle') : '')}
        />
        <div className="mx-auto mt-3 h-0.5 w-10 rounded-full bg-accent-violet" />
      </div>

      <div className="space-y-12">
        {categories.map((category) => (
          <div key={category.id}>
            <h3 className="mb-4 text-center font-mono text-sm uppercase tracking-wider text-text-dim">
              {category.name}
            </h3>
            <div className="flex flex-wrap justify-center gap-3">
              {sortSkillsByPosition(category.skills).map((skill) => {
                const href = skill.link?.trim() ? skill.link.trim() : null;
                const content = (
                  <>
                    <Image
                      alt={skill.title}
                      blurDataURL={skill.blurhashURL || undefined}
                      className={`h-10 w-10 object-contain ${
                        skill.invert ? 'dark:invert' : ''
                      }`}
                      height={80}
                      placeholder={skill.blurhashURL ? 'blur' : 'empty'}
                      sizes="40px"
                      src={skill.icon}
                      width={80}
                    />
                    <span className="text-center font-mono text-[11px] text-text-main transition-colors group-hover:text-text-white">
                      {skill.title}
                    </span>
                  </>
                );

                return href ? (
                  <Link
                    className={tileClass}
                    href={href}
                    key={skill.id}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {content}
                  </Link>
                ) : (
                  <div className={tileClass} key={skill.id}>
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

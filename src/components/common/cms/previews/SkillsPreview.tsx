'use client';

import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatLabels } from '@/utils/formatLabels';

type Skill = {
  id: number;
  title: string;
  icon: string;
  invert: boolean;
  blurhashURL: string;
};

type SkillsCategory = {
  id: number;
  name: string;
  skills: Skill[];
};

interface SkillsPreviewProps {
  categories: SkillsCategory[];
}

export function SkillsPreview({ categories }: SkillsPreviewProps) {
  const pathname = usePathname();
  const _locale = pathname.split('/')[1] || 'en';
  const t = useTranslations('skills-section');

  return (
    <section
      id="skills"
      className="flex items-center justify-center text-center mx-5 xl:mx-16 md:min-h-lvh mt-20 md:mt-20 lg:mt-32 xl:mt-40 mb-20 md:mb-32"
    >
      <div className="w-full h-full">
        <h1 className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-10 xl:mb-5">
          {t('title')}
        </h1>
        <h2
          className="xl:mb-20 text-base xs:text-lg tablet:text-2xl tablet:mx-16 md:text-2xl mb-10"
          dangerouslySetInnerHTML={{ __html: formatLabels(t('subtitle')) }}
        />
        {categories.map((skillCategory) => (
          <div key={skillCategory.id} className="">
            <h2 className="text-lg xs:text-xl tablet:text-3xl md:text-[2.33rem] xs:tracking-wider my-5">
              {t(`skills.${skillCategory.name}`)}
            </h2>
            <div className="flex xl:flex-nowrap flex-wrap justify-center items-center">
              {skillCategory.skills.map((skill) => (
                <div
                  key={skill.id}
                  className="md:drop-shadow-3xl drop-shadow-xl dark:drop-shadow-none hover:scale-110 transition-all mx-auto my-5 md:my-10 w-[calc(33.333%-1rem)]"
                >
                  <Image
                    placeholder="blur"
                    blurDataURL={skill.blurhashURL}
                    src={skill.icon}
                    width={80}
                    height={80}
                    sizes="(min-width: 1280px) 80px, (min-width: 475px) 70px, 60px"
                    className={`mx-auto rounded-xl w-[60px] xs:w-[70px] xl:w-[80px] ${
                      skill.invert && 'dark:invert'
                    }`}
                    alt={skill.title}
                  />
                  <h3 className="mt-5 text-base xs:text-lg tablet:text-xl xl:text-2xl">
                    {skill.title}
                  </h3>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

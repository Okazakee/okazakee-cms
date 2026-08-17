import { ErrorDiv } from '@components/common/ErrorDiv';
import type { LucideProps } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import React from 'react';
import { GithubIcon, LinkedinIcon, AppleIcon } from '@/components/common/BrandIcons';
import { InnerHtml } from '@/components/common/InnerHtml';
import ResumeButton from '@/components/common/ResumeButton';
import type { ResumeData } from '@/types/fetchedData.types';
import { formatLabels } from '@/utils/formatLabels';
import { getContacts, getResumeLink } from '@/utils/getData';

export default async function Contacts({ locale }: { locale: string }) {
  let contacts = await getContacts();
  const resumeData = (await getResumeLink()) as ResumeData;

  contacts = contacts
    ? [...contacts].sort((a, b) => a.position - b.position)
    : null;

  const t = await getTranslations({ locale, namespace: 'contacts-section' });

  // Get the correct resume link based on locale
  const resumeLink = resumeData
    ? resumeData[`resume_${locale}` as keyof ResumeData]
    : null;

  const brandIcons: Record<string, React.ComponentType<LucideProps>> = {
    Github: GithubIcon,
    Linkedin: LinkedinIcon,
    Apple: AppleIcon,
  };

  const getIconComponent = (iconName: string) => {
    const capitalized = iconName.charAt(0).toUpperCase() + iconName.slice(1);
    const BrandIcon = brandIcons[capitalized];
    if (BrandIcon) return BrandIcon;

    return React.lazy(() =>
      import('lucide-react').then((module) => {
        const Icon = module[capitalized] as React.ComponentType<LucideProps>;
        return { default: Icon ?? (() => null) };
      })
    );
  };

  return contacts ? (
    <section
      id="contacts"
      className="flex items-center justify-center text-center mx-5 xl:mx-16 md:min-h-lvh my-20 md:my-0 mdh:mt-40"
    >
      <div>
        <InnerHtml
          as="h1"
          className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-5"
          html={formatLabels(t('title'))}
        />
        <InnerHtml
          as="h2"
          className="md:mb-20 mb-10 text-base xs:text-lg tablet:text-2xl tablet:mx-16 md:text-2xl"
          html={formatLabels(t('subtitle'))}
        />
        <div className="flex lg:flex-row flex-col lg:gap-8 mx-12 md:mx-0 tablet:w-full tablet:max-w-lg tablet:mx-auto tablet:text-center justify-center drop-shadow-xl md:drop-shadow-2xl dark:drop-shadow-none">
          {contacts.map(({ id, label, icon, link, bg_color }) => {
            const IconComponent = getIconComponent(icon);

            return (
              <Link
                data-umami-event={`${label} button`}
                key={id}
                style={
                  {
                    '--dyn-color': `${bg_color}99`,
                    '--hover-color': bg_color,
                  } as React.CSSProperties
                }
                href={link}
                target="_blank"
                className={`text-lighttext mb-5 lg:mb-0 last:mb-0 transition-all hover:scale-105 border-2
                      border-main rounded-2xl bg-(--hover-color) lg:bg-(--dyn-color) lg:hover:bg-(--hover-color)`}
              >
                <div className="transition-all ease-in-out lg:my-0 my-2 lg:w-40 lg:h-40">
                  {IconComponent ? (
                    <div className="h-full flex lg:flex-col justify-center items-center">
                      <IconComponent
                        className="lg:mr-0 mr-5 dark:text-lighttext lg:w-[100px] w-16 lg:h-auto h-14 xs:h-16"
                        size={80}
                        strokeWidth={1}
                      />
                      <h3 className="text-xl xs:text-2xl text-left w-28 lg:text-center lg:w-auto">
                        {label}
                      </h3>
                    </div>
                  ) : (
                    <div>No Icon Available</div>
                  )}
                </div>
              </Link>
            );
          })}

          {/* Resume Link Button */}
          {resumeLink && (
            <ResumeButton resumeLink={resumeLink} locale={locale} />
          )}
        </div>
      </div>
    </section>
  ) : (
    <ErrorDiv>Error loading Contacts data</ErrorDiv>
  );
}

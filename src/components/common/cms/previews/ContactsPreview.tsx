'use client';

import type { LucideProps } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { useEffect, useState } from 'react';
import ResumeButton from '@/components/common/ResumeButton';
import type { Contact, ResumeData } from '@/types/fetchedData.types';
import { formatLabels } from '@/utils/formatLabels';

interface ContactsPreviewProps {
  contacts: Contact[];
  resumeData?: ResumeData;
}

// Icon component with error handling
function IconComponent({
  iconName,
  size = 24,
  className = '',
}: {
  iconName: string;
  size?: number;
  className?: string;
}) {
  const [Icon, setIcon] = useState<React.ComponentType<LucideProps> | null>(
    null
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    const loadIcon = async () => {
      try {
        const module = await import('lucide-react');
        // Use bracket notation with proper typing
        const iconKey = (iconName.charAt(0).toUpperCase() +
          iconName.slice(1)) as keyof typeof module;
        const IconComponent = module[iconKey] as
          | React.ComponentType<LucideProps>
          | undefined;

        if (!IconComponent) {
          throw new Error(`Icon "${iconName}" not found`);
        }

        setIcon(() => IconComponent);
      } catch (err) {
        console.error(`Failed to load icon: ${iconName}`, err);
        setError(true);
      }
    };

    if (iconName) {
      loadIcon();
    }
  }, [iconName]);

  if (error) {
    return (
      <div className="flex items-center justify-center w-6 h-6 bg-red-500/20 rounded-sm text-red-500 text-xs">
        ?
      </div>
    );
  }

  if (!Icon) {
    return (
      <div className="flex items-center justify-center w-6 h-6 bg-gray-500/20 rounded-sm text-gray-500 text-xs">
        ...
      </div>
    );
  }

  return <Icon size={size} className={className} />;
}

export function ContactsPreview({
  contacts,
  resumeData,
}: ContactsPreviewProps) {
  const pathname = usePathname();
  const locale = pathname.split('/')[1] || 'en';
  const t = useTranslations('contacts-section');

  // Sort contacts by position
  const sortedContacts = [...contacts].sort((a, b) => a.position - b.position);

  // Get the correct resume link based on locale
  const resumeLink = resumeData
    ? resumeData[`resume_${locale}` as keyof ResumeData]
    : null;

  if (!contacts || contacts.length === 0) {
    return (
      <section
        id="contacts"
        className="flex items-center justify-center text-center mx-5 xl:mx-16 md:min-h-lvh my-20 md:my-0 mdh:mt-40"
      >
        <div>
          <h1 className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-5">
            {t('title')}
          </h1>
          <h2
            className="md:mb-20 mb-10 text-base xs:text-lg tablet:text-2xl tablet:mx-16 md:text-2xl"
            dangerouslySetInnerHTML={{ __html: formatLabels(t('subtitle')) }}
          />
          <p className="text-lighttext2">No contacts to display</p>
        </div>
      </section>
    );
  }

  return (
    <section
      id="contacts"
      className="flex items-center justify-center text-center mx-5 xl:mx-16 md:min-h-lvh my-20 md:my-0 mdh:mt-40"
    >
      <div>
        <h1 className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-5">
          {t('title')}
        </h1>
        <h2
          className="md:mb-20 mb-10 text-base xs:text-lg tablet:text-2xl tablet:mx-16 md:text-2xl"
          dangerouslySetInnerHTML={{ __html: formatLabels(t('subtitle')) }}
        />
        <div className="flex lg:flex-row flex-col lg:gap-8 mx-12 md:mx-0 tablet:w-full tablet:max-w-lg tablet:mx-auto tablet:text-center justify-center drop-shadow-xl md:drop-shadow-2xl dark:drop-shadow-none">
          {sortedContacts.map(({ id, label, icon, link, bg_color }) => (
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
                <div className="h-full flex lg:flex-col justify-center items-center">
                  <IconComponent
                    iconName={icon}
                    size={80}
                    className="lg:mr-0 mr-5 dark:text-lighttext lg:w-[100px] w-16 lg:h-auto h-14 xs:h-16"
                  />
                  <h3 className="text-xl xs:text-2xl text-left w-28 lg:text-center lg:w-auto">
                    {label}
                  </h3>
                </div>
              </div>
            </Link>
          ))}

          {/* Resume Link Button */}
          {resumeLink && (
            <ResumeButton resumeLink={resumeLink} locale={locale} />
          )}
        </div>
      </div>
    </section>
  );
}

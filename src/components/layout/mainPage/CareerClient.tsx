'use client';

import { ClientMarkdown } from '@components/common/ClientMarkdown';
import { SkillsCarousel } from '@components/common/SkillsCarousel';
import { Calendar, MapPin } from 'lucide-react';
import { diffMonths, formatMonthYear } from '@/utils/formatDate';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { InnerHtml } from '@/components/common/InnerHtml';
import { formatLabels } from '@/utils/formatLabels';

interface CareerEntry {
  id: string;
  title: string;
  company: string;
  remote: string;
  startDate: string;
  endDate: string | null;
  skills: string;
  logo: string;
  blurhashurl: string;
  website_url: string;
  [key: `location_${string}`]: string;
  [key: `description_${string}`]: string;
  [key: `company_description_${string}`]: string;
}

interface CareerClientProps {
  careerEntries: CareerEntry[];
  locale: string;
}

export function CareerClient({
  careerEntries,
  locale,
}: CareerClientProps) {
  const t = useTranslations('career-section');
  const formatDate = (dateString: string | null) => {
    if (!dateString) return t('present');
    return formatMonthYear(dateString);
  };

  const calculateDuration = (startDate: string | null, endDate?: string | null) => {
    const end = endDate || new Date().toISOString();
    const months = Math.max(0, diffMonths(end, startDate));

    if (months < 12) {
      return months === 1 ? `1 ${t('month')}` : `${months} ${t('months')}`;
    } else {
      const years = Math.floor(months / 12);
      const remainingMonths = months % 12;

      if (remainingMonths === 0) {
        return years === 1 ? `1 ${t('year')}` : `${years} ${t('years')}`;
      } else {
        const yearText = years === 1 ? t('year') : t('years');
        const monthText = remainingMonths === 1 ? t('month') : t('months');
        return `${years} ${yearText} ${remainingMonths} ${monthText}`;
      }
    }
  };

  const groupEntriesByCompany = (entries: CareerEntry[]) => {
    const grouped = entries.reduce(
      (acc, entry) => {
        if (!acc[entry.company]) {
          acc[entry.company] = [];
        }
        acc[entry.company].push(entry);
        return acc;
      },
      {} as Record<string, CareerEntry[]>
    );

    return Object.entries(grouped).map(([company, positions]) => ({
      company,
      positions: positions.sort((a, b) =>
        diffMonths(b.startDate, a.startDate)
      ),
    }));
  };

  const groupedEntries = groupEntriesByCompany(careerEntries);

  return (
    <section
      id="career"
      className="flex items-center justify-center text-center mx-5 xl:mx-16 min-h-screen my-20 md:my-0 mb-20 md:mb-32"
    >
      <div className="w-full max-w-6xl">
        <InnerHtml
          as="h1"
          className="xl:text-6xl tablet:text-5xl text-xl xs:text-2xl mb-10 xl:mb-5"
          html={formatLabels(t('title'))}
        />
        <InnerHtml
          as="h2"
          className="xl:mb-20 text-base xs:text-lg tablet:text-2xl tablet:mx-16 md:text-2xl mb-10"
          html={formatLabels(t('subtitle'))}
        />

        <div className="relative">
          <div
            className="absolute left-1/2 transform -translate-x-1/2 h-full w-1 bg-main hidden md:block"
            style={{ top: '0.5rem' }}
          />

          {groupedEntries.map((companyGroup, index) => {
            const isEven = index % 2 === 0;
            const _isLast = index === groupedEntries.length - 1;
            const latestPosition = companyGroup.positions[0]; // Most recent position
            const olderPositions = companyGroup.positions.slice(1);

            return (
              <div key={companyGroup.company} className="mb-0 md:mb-8 relative">
                <div
                  className={`hidden md:flex items-center ${
                    isEven ? 'flex-row' : 'flex-row-reverse'
                  }`}
                >
                  <div
                    className={`absolute top-1/2 left-1/2 w-10 h-20 ${
                      isEven ? '-translate-x-full' : 'translate-x-0'
                    } -translate-y-1/2`}
                    style={{
                      borderTop: '2px solid #8B53FB',
                      borderRight: isEven ? 'none' : '2px solid #8B53FB',
                      borderLeft: isEven ? '2px solid #8B53FB' : 'none',
                      borderRadius: isEven ? '8px 0 0 0' : '0 8px 0 0',
                    }}
                  />

                  <div
                    className={`w-1/2 ${
                      isEven ? 'pr-16 text-right' : 'pl-16 text-left'
                    }`}
                  >
                    {/* Latest position - full UI */}
                    <h3 className="text-2xl font-bold text-main mb-2">
                      {latestPosition.title}
                    </h3>

                    <div
                      className={`flex mb-4 items-center text-sm text-gray-500 dark:text-gray-400 gap-2 ${
                        isEven ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      <Calendar size={16} className="inline" />
                      <span>
                        {formatDate(latestPosition.startDate)} —{' '}
                        {formatDate(latestPosition.endDate)}
                      </span>
                      <span className="px-1 text-main">•</span>
                      <span>
                        {calculateDuration(
                          latestPosition.startDate,
                          latestPosition.endDate
                        )}
                      </span>
                    </div>

                    <ClientMarkdown className="mb-4 prose dark:prose-invert max-w-none text-left">
                      {latestPosition[`description_${locale}`] ?? ''}
                    </ClientMarkdown>

                    <div
                      className={`flex flex-wrap gap-2 ${
                        isEven ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      <SkillsCarousel
                        skills={JSON.parse(latestPosition.skills) as string[]}
                        isEven={isEven}
                      />
                    </div>

                    {/* Older positions - compact UI */}
                    {olderPositions.length > 0 && (
                      <div
                        className={`mt-6 space-y-4 ${
                          isEven ? 'text-right' : 'text-left'
                        }`}
                      >
                        {olderPositions.map((position) => (
                          <div key={position.id} className="pl-4">
                            <h5 className="text-2xl font-bold text-main mb-2">
                              {position.title}
                            </h5>
                            <div
                              className={`flex items-center mb-4 text-sm text-gray-500 dark:text-gray-400 gap-2 ${
                                isEven ? 'justify-end' : 'justify-start'
                              }`}
                            >
                              <Calendar size={16} className="inline" />
                              <span>
                                {formatDate(position.startDate)} —{' '}
                                {formatDate(position.endDate)}
                              </span>
                              <span className="px-1 text-main">•</span>
                              <span>
                                {calculateDuration(
                                  position.startDate,
                                  position.endDate
                                )}
                              </span>
                            </div>
                            <ClientMarkdown className="prose dark:prose-invert max-w-none text-left mb-4">
                              {position[`description_${locale}`] ?? ''}
                            </ClientMarkdown>
                            <div
                              className={`flex flex-wrap gap-2 ${
                                isEven ? 'justify-end' : 'justify-start'
                              }`}
                            >
                              <SkillsCarousel
                                skills={JSON.parse(position.skills) as string[]}
                                isEven={isEven}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="absolute left-1/2 top-1 transform -translate-x-1/2 w-6 h-6 bg-main rounded-full z-10 border-2 border-white dark:border-gray-900" />

                  <div className={`w-1/2 ${isEven ? 'pl-16' : 'pr-16'}`}>
                    <Link
                      href={latestPosition.website_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={
                        'group bg-[#c5c5c5] dark:bg-[#0e0e0e] p-8 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700 mx-auto max-w-md hover:scale-105 transition-all cursor-pointer block'
                      }
                    >
                      <div className="text-center mb-6">
                        <div className="relative mx-auto h-[160px] w-full max-w-[400px]">
                          <Image
                            src={latestPosition.logo}
                            alt={latestPosition.company}
                            fill
                            sizes="400px"
                            placeholder="blur"
                            blurDataURL={latestPosition.blurhashurl}
                            className="rounded-xl object-contain shadow-md"
                          />
                        </div>
                      </div>
                      <div className="text-center">
                        <h5 className="font-semibold text-gray-900 dark:text-white mb-3 text-lg">
                          {latestPosition.company}
                        </h5>
                        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
                          {latestPosition[`company_description_${locale}`]}
                        </p>
                        <div className="w-28 h-px bg-gray-300 dark:bg-gray-600 mx-auto mb-3" />
                        <div className="flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 gap-1">
                          <MapPin size={16} className="inline mb-1 mr-1" />
                          <span>{latestPosition[`location_${locale}`]}</span>
                          <span className="px-1 text-main">•</span>
                          <span className="bg-secondary text-white px-1.5 py-0.5 rounded-md text-xs">
                            {t(`remote.${latestPosition.remote}`)}
                          </span>
                        </div>
                      </div>
                    </Link>
                  </div>
                </div>

                {/* MOBILE */}
                <div className="md:hidden flex flex-col items-center w-full">
                  {/* Timeline container */}
                  <div className="relative w-full max-w-md flex">
                    {/* Vertical line (full height of container) */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-1 bg-main -translate-x-1/2 z-0" />

                    {/* Card with dot */}
                    <div className="relative w-full flex flex-col items-center">
                      {/* Dot */}
                      <div className="absolute left-1/2 -top-4 w-4 h-4 bg-main rounded-full border-2 border-white dark:border-gray-900 z-10 -translate-x-1/2" />
                      {/* Card */}
                      <div className="bg-[#c5c5c5] dark:bg-[#0e0e0e] p-6 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700 mt-2 w-full max-w-84 xs:min-w-[24rem] md:max-w-xl mx-auto z-10">
                        {/* Company logo and info */}
                        <Link
                          href={latestPosition.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block"
                        >
                          <div className="text-center mb-2">
                            <div className="relative mx-auto mb-4 h-[120px] w-full max-w-[250px]">
                              <Image
                                src={latestPosition.logo}
                                alt={latestPosition.company}
                                fill
                                sizes="250px"
                                placeholder="blur"
                                blurDataURL={latestPosition.blurhashurl}
                                className="rounded-xl object-contain shadow-md"
                              />
                            </div>
                            <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                              {latestPosition.company}
                            </h4>
                          </div>
                        </Link>
                        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed text-center mb-4">
                          {latestPosition[`company_description_${locale}`]}
                        </p>

                        {/* Location and remote info */}
                        <div className="flex items-center justify-center mb-4 text-xs text-gray-500 dark:text-gray-400 gap-1">
                          <MapPin size={14} className="inline mb-1 mr-1" />
                          <span>{latestPosition[`location_${locale}`]}</span>
                          <span className="px-1 text-main">•</span>
                          <span className="bg-secondary text-white px-1.5 py-0.5 rounded-md text-xs">
                            {t(`remote.${latestPosition.remote}`)}
                          </span>
                        </div>

                        {/* Divider */}
                        <div className="w-16 h-px bg-gray-300 dark:bg-gray-600 mx-auto mb-4" />

                        {/* Latest job title */}
                        <h3 className="text-xl font-bold text-main mb-2 text-center">
                          {latestPosition.title}
                        </h3>

                        {/* Description */}
                        <ClientMarkdown className="mb-4 prose dark:prose-invert max-w-none text-sm text-left">
                          {latestPosition[`description_${locale}`] ?? ''}
                        </ClientMarkdown>

                        {/* Date and duration */}
                        <div className="flex items-center justify-center mb-5 text-xs text-gray-500 dark:text-gray-400 gap-1">
                          <Calendar size={14} className="inline mb-1" />
                          <span>
                            {formatDate(latestPosition.startDate)} —{' '}
                            {formatDate(latestPosition.endDate)}
                          </span>
                          <span className="px-1 text-main">•</span>
                          <span>
                            {calculateDuration(
                              latestPosition.startDate,
                              latestPosition.endDate
                            )}
                          </span>
                        </div>

                        {/* Skills */}
                        <div className="flex flex-wrap gap-2 justify-center">
                          <SkillsCarousel
                            skills={
                              JSON.parse(latestPosition.skills) as string[]
                            }
                          />
                        </div>

                        {/* Older positions for mobile */}
                        {olderPositions.length > 0 && (
                          <div className="mt-6">
                            <div className="space-y-3">
                              {olderPositions.map((position, _posIndex) => (
                                <div key={position.id}>
                                  {/* Connecting line from previous position */}
                                  <div className="flex justify-center mb-3">
                                    <div className="relative">
                                      <div className="w-1 h-6 bg-main rounded-full" />
                                      <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 w-3 h-3 bg-main rounded-full border-2 border-white dark:border-gray-900" />
                                    </div>
                                  </div>
                                  <div className="pl-3">
                                    <h3 className="text-xl font-bold text-main mb-2 text-center">
                                      {position.title}
                                    </h3>

                                    <ClientMarkdown className="mb-4 prose dark:prose-invert max-w-none text-sm text-left">
                                      {position[`description_${locale}`] ?? ''}
                                    </ClientMarkdown>

                                    {/* Date and duration */}
                                    <div className="flex items-center justify-center mb-5 text-xs text-gray-500 dark:text-gray-400 gap-1">
                                      <Calendar
                                        size={14}
                                        className="inline mb-1"
                                      />
                                      <span>
                                        {formatDate(position.startDate)} —{' '}
                                        {formatDate(position.endDate)}
                                      </span>
                                      <span className="px-1 text-main">•</span>
                                      <span>
                                        {calculateDuration(
                                          position.startDate,
                                          position.endDate
                                        )}
                                      </span>
                                    </div>

                                    <div className="flex flex-wrap gap-2 justify-center">
                                      <SkillsCarousel
                                        skills={
                                          JSON.parse(
                                            position.skills
                                          ) as string[]
                                        }
                                      />
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Connector: show only if not last card */}
                      {index !== groupedEntries.length - 1 && (
                        <div className="flex justify-center">
                          <div className="w-1 h-8 bg-main rounded-full my-2" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

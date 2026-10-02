'use client';

import { Tag } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { diffMonths, formatMonthYear } from '@/utils/formatDate';
import { formatLabels } from '@/utils/formatLabels';
import { ChipRow } from './canonical/ChipRow';
import { ClientMarkdown } from './canonical/ClientMarkdown';
import { InnerHtml } from './canonical/InnerHtml';

interface PreviewCareerEntry {
  id: number;
  title: string;
  company: string;
  remote: string;
  startDate: string;
  endDate: string | null;
  skills: string;
  logo: string;
  blurhashURL: string;
  website_url: string;
  location_en: string;
  location_it: string;
  description_en: string;
  description_it: string;
  company_description_en: string;
  company_description_it: string;
}

interface CareerPreviewProps {
  entries: PreviewCareerEntry[];
}

interface CompanyGroup {
  company: string;
  positions: PreviewCareerEntry[];
}

/** Same company means the same job — role upgrades share one card. */
const groupByCompany = (entries: PreviewCareerEntry[]): CompanyGroup[] => {
  const groups: CompanyGroup[] = [];

  for (const entry of entries) {
    const group = groups.find((item) => item.company === entry.company);

    if (group) {
      group.positions.push(entry);
    } else {
      groups.push({ company: entry.company, positions: [entry] });
    }
  }

  return groups.map((group) => ({
    ...group,
    positions: [...group.positions].sort((a, b) =>
      a.startDate < b.startDate ? 1 : -1
    ),
  }));
};

const parseSkills = (skills: string): string[] =>
  skills ? Array.from(skills.matchAll(/"([^"]*?)"/g), (match) => match[1]) : [];

/**
 * Canonical career timeline (docs/DESIGN.md §5.3): one card per company, newest
 * role featured with older roles nested beneath it. The line is drawn per entry
 * so it starts at the first dot's centre and ends at the last, and each card
 * links to the company site in a new tab so a preview never leaves the CMS.
 */
export function CareerPreview({ entries }: CareerPreviewProps) {
  const locale = useLocale();
  const t = useTranslations('career-section');

  const tr = (key: string) => (t.has(key) ? t(key) : '');
  const localized = (
    entry: PreviewCareerEntry,
    field: 'location' | 'description' | 'company_description'
  ): string =>
    (entry[`${field}_${locale}` as keyof PreviewCareerEntry] as string) ?? '';

  const groups = groupByCompany(entries);

  const duration = (startDate: string, endDate: string | null) => {
    const months = diffMonths(endDate ?? new Date(), startDate);

    if (months < 12) {
      return `${months} ${tr(months === 1 ? 'month' : 'months')}`;
    }

    const years = Math.floor(months / 12);
    return `${years} ${tr(years === 1 ? 'year' : 'years')}`;
  };

  const dates = (entry: PreviewCareerEntry) =>
    `${formatMonthYear(entry.startDate)} - ${
      entry.endDate ? formatMonthYear(entry.endDate) : tr('present')
    } • ${duration(entry.startDate, entry.endDate)}`;

  const pill = (entry: PreviewCareerEntry) => (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-surface-raised px-2.5 py-1 font-mono text-xs text-text-muted">
      {!entry.endDate && (
        <span className="h-1.5 w-1.5 rounded-full bg-status-active" />
      )}
      {dates(entry)}
    </span>
  );

  const chips = (entry: PreviewCareerEntry) => (
    <ChipRow>
      {parseSkills(entry.skills).map((skill) => (
        <span
          className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded border border-border-subtle bg-surface-raised px-2 py-0.5 font-mono text-xs text-text-muted"
          key={skill}
        >
          <Tag className="mr-0.5 h-3 w-3 shrink-0 text-accent-violet/70" />
          {skill}
        </span>
      ))}
    </ChipRow>
  );

  const position = (entry: PreviewCareerEntry, nested: boolean) => (
    <>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <h3
          className={`font-heading font-semibold text-text-white ${
            nested ? 'text-base' : 'text-lg'
          }`}
        >
          {entry.title}
        </h3>
        {nested && pill(entry)}
      </div>

      <p className="mb-4 text-xs text-text-dim">
        {localized(entry, 'location')} • {tr(`remote.${entry.remote}`)}
      </p>

      {localized(entry, 'description') && (
        <ClientMarkdown className="mb-5 text-sm font-light leading-relaxed text-text-main/90 [&_li]:mb-2 [&_li::marker]:text-accent-violet [&_ul]:list-disc [&_ul]:pl-4">
          {localized(entry, 'description')}
        </ClientMarkdown>
      )}

      {chips(entry)}
    </>
  );

  return (
    <section
      className="border-t border-border-subtle/50 bg-surface-alt py-24"
      id="career"
    >
      <div className="mx-auto max-w-4xl px-6">
        <div className="mb-16 text-center">
          <InnerHtml
            as="h2"
            className="font-heading text-2xl font-semibold text-text-white sm:text-3xl"
            html={tr('title')}
          />
          <InnerHtml
            as="p"
            className="mt-2 font-mono text-xs text-accent-violet-light sm:text-sm"
            html={formatLabels(tr('subtitle'))}
          />
          <div className="mx-auto mt-3 h-0.5 w-10 rounded-full bg-accent-violet" />
        </div>

        <div className="relative space-y-12 pl-6 sm:pl-8">
          {groups.map((group, index) => {
            const [latest, ...older] = group.positions;
            const companyDescription = localized(latest, 'company_description');

            return (
              <div className="group relative" key={group.company}>
                {index < groups.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="absolute -bottom-[61px] left-[-24.5px] top-[13px] w-px bg-accent-violet/30 sm:left-[-32.5px]"
                  />
                )}
                <div className="absolute -left-[31px] top-1.5 h-3.5 w-3.5 rounded-full border-4 border-surface-alt bg-accent-violet shadow-accent-violet/40 sm:-left-[39px]" />

                <a
                  className="block rounded-2xl border border-border-subtle bg-surface-card p-6 transition-colors hover:border-accent-violet/40 sm:p-7"
                  href={latest.website_url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <div className="mb-5 flex flex-wrap items-start gap-3">
                    {/* biome-ignore lint/performance/noImgElement: brand marks arrive in arbitrary aspect ratios, so the height is capped rather than fixed */}
                    <img
                      alt={group.company}
                      className="max-h-10 w-auto shrink-0 object-contain"
                      loading="lazy"
                      src={latest.logo}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-heading text-base font-semibold text-text-white">
                        {group.company}
                      </p>
                    </div>
                    {pill(latest)}
                  </div>

                  {companyDescription && (
                    <p className="mb-5 text-xs font-light leading-relaxed text-text-dim">
                      {companyDescription}
                    </p>
                  )}

                  {position(latest, false)}

                  {older.length > 0 && (
                    <div className="mt-6 space-y-5 border-t border-border-subtle pt-5">
                      {older.map((entry) => (
                        <div key={entry.id}>{position(entry, true)}</div>
                      ))}
                    </div>
                  )}
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

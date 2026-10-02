'use client';

import type { LucideProps } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { Contact, ResumeData } from '@/types/fetchedData.types';
import { formatLabels } from '@/utils/formatLabels';
import { AppleIcon, GithubIcon, LinkedinIcon } from './canonical/BrandIcons';
import { InnerHtml } from './canonical/InnerHtml';
import { RequestFormPreview } from './canonical/RequestForm';

interface ContactsPreviewProps {
  contacts: Contact[];
  resumeData?: ResumeData;
}

// Preview icon loader for non-brand names: resolves from lucide-react at
// runtime and degrades to a neutral placeholder instead of throwing.
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
        const iconKey = (iconName.charAt(0).toUpperCase() +
          iconName.slice(1)) as keyof typeof module;
        const LoadedIcon = module[iconKey] as
          | React.ComponentType<LucideProps>
          | undefined;

        if (!LoadedIcon) {
          throw new Error(`Icon "${iconName}" not found`);
        }

        setIcon(() => LoadedIcon);
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
      <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-red-500/20 text-xs text-red-500">
        ?
      </div>
    );
  }

  if (!Icon) {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-surface-raised/20 text-xs text-text-muted">
        ...
      </div>
    );
  }

  return <Icon size={size} className={className} />;
}

const brandIcons: Record<string, React.ComponentType<LucideProps>> = {
  Github: GithubIcon,
  Linkedin: LinkedinIcon,
  Apple: AppleIcon,
};

/**
 * Canonical contacts section (docs/DESIGN.md §5.4): centred header, contact
 * tiles and the request form. Tiles always open in a new tab so a preview
 * never navigates the CMS app away.
 */
export function ContactsPreview({ contacts }: ContactsPreviewProps) {
  const t = useTranslations('contacts-section');
  const tr = (key: string) => (t.has(key) ? t(key) : '');

  const sortedContacts = [...contacts].sort((a, b) => a.position - b.position);

  return (
    <section className="mx-auto max-w-4xl px-6 py-24 text-center" id="contacts">
      <div className="mb-14 text-center">
        <InnerHtml
          as="h2"
          className="font-heading text-2xl font-semibold text-text-white sm:text-3xl"
          html={formatLabels(tr('title'))}
        />
        <InnerHtml
          as="p"
          className="mt-2 font-mono text-xs text-accent-violet-light sm:text-sm"
          html={formatLabels(tr('subtitle'))}
        />
        <div className="mx-auto mt-3 h-0.5 w-10 rounded-full bg-accent-violet" />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {sortedContacts.map(({ id, label, icon, link, bg_color }) => {
          const BrandIcon =
            brandIcons[icon] ??
            brandIcons[icon.charAt(0).toUpperCase() + icon.slice(1)];

          return (
            <Link
              className="group flex flex-col items-center gap-3 rounded-2xl border border-border-subtle bg-surface-card p-5 text-center transition-colors hover:border-accent-violet hover:bg-surface-raised"
              data-umami-event={`${label} button`}
              href={link}
              key={id}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span
                className="flex h-12 w-12 items-center justify-center rounded-xl"
                style={{ backgroundColor: `${bg_color}1a`, color: bg_color }}
              >
                {BrandIcon ? (
                  <BrandIcon className="h-6 w-6" strokeWidth={1.8} />
                ) : (
                  <IconComponent className="h-6 w-6" iconName={icon} />
                )}
              </span>
              <span className="text-sm font-medium text-text-white">
                {label}
              </span>
            </Link>
          );
        })}
      </div>

      <RequestFormPreview />
    </section>
  );
}

/** Structured resume content for one locale (client-safe, no node imports). */

export type ResumeContactIcon =
  | 'location'
  | 'phone'
  | 'email'
  | 'github'
  | 'linkedin'
  | 'website'
  | 'document';

export type ResumeContact = {
  icon: ResumeContactIcon;
  text: string;
  href?: string;
};

export type ResumeSkillGroup = {
  label: string;
  tags: string[];
};

export type ResumeExperience = {
  title: string;
  sub: string;
  meta: string;
  bullets: string[];
};

export type ResumeProjectLink = {
  label: string;
  href: string;
};

export type ResumeProject = {
  name: string;
  links: ResumeProjectLink[];
  stack: string;
  bullets: string[];
};

export type ResumeEducation = {
  degree: string;
  school: string;
  year: string;
};

export type ResumeLanguage = {
  name: string;
  level: string;
};

export type ResumeData = {
  name: string;
  title: string;
  contacts: ResumeContact[];
  summaryTitle: string;
  summaryHtml: string;
  skillsTitle: string;
  skills: ResumeSkillGroup[];
  experienceTitle: string;
  experience: ResumeExperience[];
  projectsTitle: string;
  projects: ResumeProject[];
  educationTitle: string;
  education: ResumeEducation[];
  languagesTitle: string;
  languages: ResumeLanguage[];
};

export type ResumeLocale = 'en' | 'it';

export const RESUME_LOCALES: ResumeLocale[] = ['en', 'it'];

export function isResumeLocale(value: unknown): value is ResumeLocale {
  return value === 'en' || value === 'it';
}

/**
 * Fixed header schema: exactly these contact rows, in this order. The CMS
 * edits text (and href where a link exists) but never the row set or icons.
 */
export const FIXED_CONTACT_ICONS: ResumeContactIcon[] = [
  'location',
  'phone',
  'email',
  'github',
  'linkedin',
  'website',
  'document',
];

/** Rows without a link (location, VAT line) expose no href field. */
export function isLinkableContactIcon(icon: ResumeContactIcon): boolean {
  return icon !== 'location' && icon !== 'document';
}

/**
 * Projects stored contacts onto the fixed schema: same rows in the same
 * order, keeping stored text/href matched by icon, filling gaps (or fully
 * invalid lists) from the locale seed. Never throws.
 */
export function normalizeResumeContacts(
  contacts: unknown,
  fallback: ResumeContact[]
): ResumeContact[] {
  const byIcon = new Map<string, ResumeContact>();
  if (Array.isArray(contacts)) {
    for (const item of contacts) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ResumeContact).text === 'string'
      ) {
        const contact = item as ResumeContact;
        if (!byIcon.has(contact.icon)) byIcon.set(contact.icon, contact);
      }
    }
  }
  const fallbackByIcon = new Map(fallback.map((c) => [c.icon, c]));
  return FIXED_CONTACT_ICONS.map((icon) => {
    const stored = byIcon.get(icon);
    const seed = fallbackByIcon.get(icon) ?? { icon, text: '' };
    if (!stored) return { ...seed };
    const next: ResumeContact = { icon, text: stored.text };
    if (isLinkableContactIcon(icon)) {
      next.href =
        typeof stored.href === 'string' && stored.href !== ''
          ? stored.href
          : (seed.href ?? '');
    }
    return next;
  });
}

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
  continuationTitle: string;
  footerLeft: string;
  pageOneLabel: string;
  pageTwoLabel: string;
};

export type ResumeLocale = 'en' | 'it';

export const RESUME_LOCALES: ResumeLocale[] = ['en', 'it'];

export function isResumeLocale(value: unknown): value is ResumeLocale {
  return value === 'en' || value === 'it';
}

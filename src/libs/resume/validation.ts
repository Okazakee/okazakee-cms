/**
 * Pure validators for structured resume data (client-safe, unit-tested).
 *
 * Bounds keep the two-page A4 layout honest: oversized fields are rejected
 * before Chromium ever renders them instead of silently spilling to a
 * third page.
 */
import {
  FIXED_CONTACT_ICONS,
  isLinkableContactIcon,
  isResumeLocale,
  type ResumeData,
} from './types';

export type ResumeIssue = {
  path: string;
  message: string;
};

const MAX_SHORT = 200;
const MAX_TEXT = 2000;
const MAX_GROUPS = 8;
const MAX_TAGS = 30;
const MAX_ENTRIES = 12;
const MAX_BULLETS = 12;
const MAX_CSS_BYTES = 100_000;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkShort(
  issues: ResumeIssue[],
  path: string,
  value: unknown,
  max: number,
  required: boolean
): void {
  if (!nonEmpty(value)) {
    if (required) issues.push({ path, message: 'Required' });
    return;
  }
  if (value.length > max) {
    issues.push({ path, message: `Must be at most ${max} characters` });
  }
}

function checkList(
  issues: ResumeIssue[],
  path: string,
  value: unknown,
  max: number,
  required: boolean
): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    if (required) issues.push({ path, message: 'At least one entry' });
    return false;
  }
  if (value.length > max) {
    issues.push({ path, message: `At most ${max} entries` });
  }
  return true;
}

/** Validates one locale document; empty array means valid. */
export function validateResumeData(
  data: unknown,
  path = 'resume'
): ResumeIssue[] {
  const issues: ResumeIssue[] = [];
  if (typeof data !== 'object' || data === null) {
    return [{ path, message: 'Must be an object' }];
  }
  const d = data as Record<string, unknown>;

  checkShort(issues, `${path}.name`, d.name, MAX_SHORT, true);
  checkShort(issues, `${path}.title`, d.title, MAX_SHORT, true);
  checkShort(issues, `${path}.summaryHtml`, d.summaryHtml, MAX_TEXT, true);
  for (const key of [
    'summaryTitle',
    'skillsTitle',
    'experienceTitle',
    'projectsTitle',
    'educationTitle',
    'languagesTitle',
  ]) {
    checkShort(issues, `${path}.${key}`, d[key], MAX_SHORT, true);
  }

  // Fixed header schema: exact rows in exact order, no more, no less.
  if (!Array.isArray(d.contacts)) {
    issues.push({ path: `${path}.contacts`, message: 'At least one entry' });
  } else {
    if (d.contacts.length !== FIXED_CONTACT_ICONS.length) {
      issues.push({
        path: `${path}.contacts`,
        message: `Must have exactly ${FIXED_CONTACT_ICONS.length} entries`,
      });
    }
    d.contacts.forEach((item, i) => {
      const c = item as Record<string, unknown>;
      const at = `${path}.contacts[${i}]`;
      const expectedIcon = FIXED_CONTACT_ICONS[i];
      if (
        typeof c !== 'object' ||
        c === null ||
        c.icon !== expectedIcon
      ) {
        issues.push({
          path: `${at}.icon`,
          message: `Must be "${expectedIcon ?? '?'}"`,
        });
        return;
      }
      checkShort(issues, `${at}.text`, c.text, MAX_SHORT, true);
      if (expectedIcon && isLinkableContactIcon(expectedIcon)) {
        checkShort(issues, `${at}.href`, c.href, MAX_TEXT, true);
      } else if (typeof c.href === 'string' && c.href.trim() !== '') {
        issues.push({ path: `${at}.href`, message: 'Link not allowed' });
      }
    });
  }

  if (checkList(issues, `${path}.skills`, d.skills, MAX_GROUPS, true)) {
    (d.skills as unknown[]).forEach((item, i) => {
      const g = item as Record<string, unknown>;
      const at = `${path}.skills[${i}]`;
      checkShort(issues, `${at}.label`, g?.label, MAX_SHORT, true);
      if (checkList(issues, `${at}.tags`, g?.tags, MAX_TAGS, true)) {
        (g.tags as unknown[]).forEach((tag, j) => {
          checkShort(issues, `${at}.tags[${j}]`, tag, MAX_SHORT, true);
        });
      }
    });
  }

  if (
    checkList(issues, `${path}.experience`, d.experience, MAX_ENTRIES, true)
  ) {
    (d.experience as unknown[]).forEach((item, i) => {
      const e = item as Record<string, unknown>;
      const at = `${path}.experience[${i}]`;
      checkShort(issues, `${at}.title`, e?.title, MAX_SHORT, true);
      checkShort(issues, `${at}.sub`, e?.sub, MAX_SHORT, true);
      checkShort(issues, `${at}.meta`, e?.meta, MAX_SHORT, true);
      if (checkList(issues, `${at}.bullets`, e?.bullets, MAX_BULLETS, true)) {
        (e.bullets as unknown[]).forEach((bullet, j) => {
          checkShort(issues, `${at}.bullets[${j}]`, bullet, MAX_TEXT, true);
        });
      }
    });
  }

  if (checkList(issues, `${path}.projects`, d.projects, MAX_ENTRIES, true)) {
    (d.projects as unknown[]).forEach((item, i) => {
      const p = item as Record<string, unknown>;
      const at = `${path}.projects[${i}]`;
      checkShort(issues, `${at}.name`, p?.name, MAX_SHORT, true);
      checkShort(issues, `${at}.stack`, p?.stack, MAX_SHORT, false);
      if (Array.isArray(p?.links)) {
        if ((p.links as unknown[]).length > MAX_TAGS) {
          issues.push({ path: `${at}.links`, message: 'Too many links' });
        }
        (p.links as unknown[]).forEach((item2, j) => {
          const link = item2 as Record<string, unknown>;
          checkShort(
            issues,
            `${at}.links[${j}].label`,
            link?.label,
            MAX_SHORT,
            true
          );
          checkShort(
            issues,
            `${at}.links[${j}].href`,
            link?.href,
            MAX_TEXT,
            true
          );
        });
      }
      if (checkList(issues, `${at}.bullets`, p?.bullets, MAX_BULLETS, true)) {
        (p.bullets as unknown[]).forEach((bullet, j) => {
          checkShort(issues, `${at}.bullets[${j}]`, bullet, MAX_TEXT, true);
        });
      }
    });
  }

  if (checkList(issues, `${path}.education`, d.education, MAX_ENTRIES, true)) {
    (d.education as unknown[]).forEach((item, i) => {
      const e = item as Record<string, unknown>;
      const at = `${path}.education[${i}]`;
      checkShort(issues, `${at}.degree`, e?.degree, MAX_SHORT, true);
      checkShort(issues, `${at}.school`, e?.school, MAX_SHORT, true);
      checkShort(issues, `${at}.year`, e?.year, MAX_SHORT, true);
    });
  }

  if (checkList(issues, `${path}.languages`, d.languages, MAX_ENTRIES, true)) {
    (d.languages as unknown[]).forEach((item, i) => {
      const l = item as Record<string, unknown>;
      const at = `${path}.languages[${i}]`;
      checkShort(issues, `${at}.name`, l?.name, MAX_SHORT, true);
      checkShort(issues, `${at}.level`, l?.level, MAX_SHORT, true);
    });
  }

  return issues;
}

/** Validates the CSS override (empty means "use default", always valid). */
export function validateResumeCss(css: unknown): ResumeIssue[] {
  if (css === undefined || css === null || css === '') return [];
  if (typeof css !== 'string') {
    return [{ path: 'css', message: 'Must be a string' }];
  }
  const bytes = new TextEncoder().encode(css).length;
  if (bytes > MAX_CSS_BYTES) {
    return [{ path: 'css', message: 'Stylesheet too large' }];
  }
  if (/<\s*script/i.test(css) || /<\/\s*style/i.test(css)) {
    return [{ path: 'css', message: 'Must not contain HTML markup' }];
  }
  return [];
}

export function isValidResumeLocaleData(
  locale: unknown,
  data: unknown
): data is ResumeData {
  return (
    isResumeLocale(locale) &&
    validateResumeData(data, String(locale)).length === 0
  );
}

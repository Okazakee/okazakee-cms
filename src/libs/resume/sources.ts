/**
 * Resume source persistence in Supabase Storage (server-only).
 *
 * Zero-migration design: the editable EN/IT documents plus the optional
 * CSS override live as three small JSON/text objects next to the generated
 * PDFs (`resumes/sources/`). The public artifacts stay exactly what they
 * are today — immutable PDFs referenced by `hero_section.resume_en/it`.
 * Sources are CMS-internal; only the service-role client touches them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResumeData } from './types';
import { validateResumeCss, validateResumeData } from './validation';

const SOURCE_PREFIX = 'resumes/sources';

export const RESUME_SOURCE_PATHS = {
  en: `${SOURCE_PREFIX}/resume_en.json`,
  it: `${SOURCE_PREFIX}/resume_it.json`,
  css: `${SOURCE_PREFIX}/template.css`,
} as const;

export type ResumeSources = {
  en: ResumeData | null;
  it: ResumeData | null;
  css: string | null;
};

async function downloadText(
  admin: SupabaseClient,
  bucket: string,
  path: string
): Promise<string | null> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) return null;
  try {
    return await data.text();
  } catch {
    return null;
  }
}

function parseSource(
  raw: string | null,
  locale: 'en' | 'it'
): ResumeData | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validateResumeData(parsed, locale).length > 0) return null;
    return parsed as ResumeData;
  } catch {
    return null;
  }
}

/** Loads saved sources; null fields mean "fall back to built-in seeds". */
export async function loadResumeSources(
  admin: SupabaseClient,
  bucket: string
): Promise<ResumeSources> {
  const [enRaw, itRaw, cssRaw] = await Promise.all([
    downloadText(admin, bucket, RESUME_SOURCE_PATHS.en),
    downloadText(admin, bucket, RESUME_SOURCE_PATHS.it),
    downloadText(admin, bucket, RESUME_SOURCE_PATHS.css),
  ]);
  return {
    en: parseSource(enRaw, 'en'),
    it: parseSource(itRaw, 'it'),
    css: cssRaw,
  };
}

async function uploadText(
  admin: SupabaseClient,
  bucket: string,
  path: string,
  text: string,
  contentType: string
): Promise<void> {
  const { error } = await admin.storage
    .from(bucket)
    .upload(path, new Blob([text], { type: contentType }), {
      cacheControl: '3600',
      contentType,
      upsert: true,
    });
  if (error) throw error;
}

/**
 * Persists validated sources. Throws on storage failure — callers decide
 * the surrounding commit order (sources first: a failed PDF/DB step after
 * this leaves the public site untouched and the next save reconciles).
 */
export async function saveResumeSources(
  admin: SupabaseClient,
  bucket: string,
  sources: { en: ResumeData; it: ResumeData; css: string }
): Promise<void> {
  const enIssues = validateResumeData(sources.en, 'en');
  const itIssues = validateResumeData(sources.it, 'it');
  const cssIssues = validateResumeCss(sources.css);
  if (enIssues.length > 0 || itIssues.length > 0 || cssIssues.length > 0) {
    const first = [...enIssues, ...itIssues, ...cssIssues][0];
    throw new Error(`Invalid resume data (${first.path})`);
  }
  await uploadText(
    admin,
    bucket,
    RESUME_SOURCE_PATHS.en,
    JSON.stringify(sources.en),
    'application/json'
  );
  await uploadText(
    admin,
    bucket,
    RESUME_SOURCE_PATHS.it,
    JSON.stringify(sources.it),
    'application/json'
  );
  await uploadText(
    admin,
    bucket,
    RESUME_SOURCE_PATHS.css,
    sources.css,
    'text/css'
  );
}

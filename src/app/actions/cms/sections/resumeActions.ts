'use server';

import {
  getAdminClient,
  removePublicFileIfDifferent,
  requireAdmin,
  uploadPdfBuffer,
} from '@/app/actions/cms/utils/fileHelpers';
import { errorMessage, type MutationResult } from '@/libs/cms/mutationResult';
import { getCmsStorageBucket } from '@/libs/cms/storage/bucket';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { DEFAULT_RESUME_CSS } from '@/libs/resume/defaultCss';
import { DEFAULT_EN, DEFAULT_IT } from '@/libs/resume/defaults';
import { renderResumePdfs } from '@/libs/resume/pdf';
import { loadResumeSources, saveResumeSources } from '@/libs/resume/sources';
import { renderResumeHtml } from '@/libs/resume/template';
import type { ResumeData } from '@/libs/resume/types';
import { normalizeResumeContacts } from '@/libs/resume/types';
import {
  validateResumeCss,
  validateResumeData,
} from '@/libs/resume/validation';

type ResumeOperation =
  | { type: 'GET' }
  | {
      type: 'PUBLISH';
      data: { en: ResumeData; it: ResumeData; css: string };
    };

export async function resumeActions(
  operation: ResumeOperation
): Promise<MutationResult> {
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Authentication required' };
  }

  try {
    switch (operation.type) {
      case 'GET':
        return await getResumeSources();
      case 'PUBLISH':
        return await publishResumes(operation.data);
      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Resume action error:', error);
    return {
      success: false,
      error: errorMessage(error, 'An unknown error occurred'),
    };
  }
}

async function getResumeSources(): Promise<MutationResult> {
  const admin = getAdminClient();
  const bucket = getCmsStorageBucket();
  const [sources, heroRow] = await Promise.all([
    loadResumeSources(admin, bucket),
    admin
      .from('hero_section')
      .select('resume_en, resume_it')
      .eq('id', 1)
      .maybeSingle(),
  ]);
  const en = sources.en ?? DEFAULT_EN;
  const it = sources.it ?? DEFAULT_IT;
  return {
    success: true,
    data: {
      // Stored sources predate the fixed header schema or were hand-edited:
      // project them back onto the exact rows before the editor sees them.
      en: {
        ...en,
        contacts: normalizeResumeContacts(en.contacts, DEFAULT_EN.contacts),
      },
      it: {
        ...it,
        contacts: normalizeResumeContacts(it.contacts, DEFAULT_IT.contacts),
      },
      css: sources.css ?? '',
      resume_en: heroRow.data?.resume_en ?? null,
      resume_it: heroRow.data?.resume_it ?? null,
    },
  };
}

async function publishResumes(data: {
  en: ResumeData;
  it: ResumeData;
  css: string;
}): Promise<MutationResult> {
  const css = data.css.trim();
  const enIssues = validateResumeData(data.en, 'en');
  const itIssues = validateResumeData(data.it, 'it');
  const cssIssues = validateResumeCss(data.css);
  const issues = [...enIssues, ...itIssues, ...cssIssues];
  if (issues.length > 0) {
    const first = issues[0];
    return {
      success: false,
      error: `Invalid resume content (${first.path}: ${first.message})`,
    };
  }

  const admin = getAdminClient();
  const bucket = getCmsStorageBucket();
  const effectiveCss = css === '' ? DEFAULT_RESUME_CSS : css;

  // 1. Render both documents (pure, no side effects).
  const htmlEn = renderResumeHtml(data.en, effectiveCss, {
    locale: 'en',
    docTitle: 'Resume – Cristian Di Carlo',
  });
  const htmlIt = renderResumeHtml(data.it, effectiveCss, {
    locale: 'it',
    docTitle: 'Curriculum – Cristian Di Carlo',
  });

  // 2. Headless-Chromium print (same engine as a manual browser print,
  //    real selectable text). Throws before anything is written.
  let pdfs: { en: Buffer; it: Buffer };
  try {
    pdfs = await renderResumePdfs(htmlEn, htmlIt);
  } catch (error) {
    console.error('Resume PDF render failed:', error);
    return { success: false, error: 'Failed to render resume PDFs' };
  }

  // 3. Persist editable sources first (CMS-internal, invisible publicly):
  //    a later failure leaves the public site untouched and the next save
  //    reconciles.
  try {
    await saveResumeSources(admin, bucket, {
      en: data.en,
      it: data.it,
      css: data.css,
    });
  } catch (error) {
    console.error('Resume sources save failed:', error);
    return { success: false, error: 'Failed to save resume sources' };
  }

  // 4. Stage both PDFs on immutable paths. Any failure from here removes
  //    what was staged and commits nothing.
  const staged: Array<{ path: string; field: 'resume_en' | 'resume_it' }> = [];
  try {
    const uploadEn = await uploadPdfBuffer(
      admin,
      bucket,
      'resumes',
      'resume_en',
      pdfs.en
    );
    staged.push({ path: uploadEn.path, field: 'resume_en' });
    const uploadIt = await uploadPdfBuffer(
      admin,
      bucket,
      'resumes',
      'resume_it',
      pdfs.it
    );
    staged.push({ path: uploadIt.path, field: 'resume_it' });

    // 5. Trusted previous values, then the single public commit.
    const { data: currentRow, error: fetchError } = await admin
      .from('hero_section')
      .select('resume_en, resume_it')
      .eq('id', 1)
      .single();
    if (fetchError || !currentRow) {
      throw fetchError ?? new Error('Hero row not found');
    }

    const { error: updateError } = await admin
      .from('hero_section')
      .update({
        resume_en: uploadEn.publicUrl,
        resume_it: uploadIt.publicUrl,
      })
      .eq('id', 1)
      .select('id')
      .single();
    if (updateError) throw updateError;

    // 6. Commit succeeded: remove the previous PDFs (never the new ones).
    for (const object of staged) {
      await removePublicFileIfDifferent(
        admin,
        (currentRow[object.field] as string | null | undefined) ?? null,
        bucket,
        object.path
      );
    }

    const revalidation = await invalidatePublicContent({
      entity: 'resume',
      operation: 'asset-update',
    });

    return {
      success: true,
      data: {
        resume_en: uploadEn.publicUrl,
        resume_it: uploadIt.publicUrl,
      },
      revalidation,
    };
  } catch (error) {
    const { removeStorageObjectBestEffort } = await import(
      '@/app/actions/cms/utils/fileHelpers'
    );
    for (const object of staged) {
      await removeStorageObjectBestEffort(admin, bucket, object.path);
    }
    console.error('Resume publish failed:', error);
    return {
      success: false,
      error: errorMessage(error, 'Failed to publish resumes'),
    };
  }
}

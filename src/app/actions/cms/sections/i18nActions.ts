'use server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { refresh, updateTag } from 'next/cache';
import {
  getAdminClient,
  getCmsActionContext,
} from '@/app/actions/cms/utils/fileHelpers';
import type { ContentEntity } from '@/libs/cms/invalidation';
import { getLocalInvalidationTags } from '@/libs/cms/localInvalidation';
import type {
  MutationResult,
  RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { mergeTranslationDelta } from '@/libs/cms/translationDelta';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';

type I18nOperation =
  | { type: 'GET' }
  | {
      type: 'UPDATE_SECTION';
      locale: string;
      sectionKey: string;
      sectionData: Record<string, unknown>;
    }
  | {
      type: 'UPDATE_SECTIONS';
      sectionKey: string;
      sections: Record<string, Record<string, unknown>>;
    }
  | { type: 'UPDATE_PRIVACY'; locale: string; markdown: string };

type I18nResult = MutationResult;

/** Per-locale outcome of a multi-locale section write. */
type LocaleCommitEvidence = {
  locale: string;
  committed: boolean;
  translations?: Record<string, unknown>;
  error?: string;
};

type SectionCasOutcome =
  | { ok: true; translations: Record<string, unknown> }
  | { ok: false; error: string; conflict: boolean };

const VALID_LOCALES = ['en', 'it'] as const;
const CAS_MAX_ATTEMPTS = 2;
const CONFLICT_ERROR =
  'Conflict: translations changed concurrently. Please reload and try again.';

/**
 * Invalidates the CMS's OWN cached reads after a committed mutation.
 *
 * `updateTag` is the immediate Server-Action mechanism for `'use cache'`
 * entries. `refresh` re-renders the current route so the editor sees their own
 * write without a manual reload. Remote public-site invalidation is handled
 * separately by `invalidatePublicContent`.
 */
function invalidateLocalCache(entity: ContentEntity): void {
  for (const tag of getLocalInvalidationTags(entity)) {
    updateTag(tag);
  }
  refresh();
}

/**
 * CAS + delta + prototype-safe section merge.
 *
 * The section payload is treated as a DELTA merged with `mergeTranslationDelta`
 * (nested objects merge recursively, arrays merge by index, `__proto__` and
 * friends are dropped). The write is guarded by a compare-and-swap on the
 * previously read `translations` snapshot, so a concurrent edit to an unrelated
 * key is preserved: the snapshot read-modify-write is retried once against the
 * fresh value, then reports an explicit conflict rather than clobbering.
 */
async function casMergeSection(
  admin: ReturnType<typeof getAdminClient>,
  locale: string,
  sectionKey: string,
  sectionData: Record<string, unknown>
): Promise<SectionCasOutcome> {
  let lastError = CONFLICT_ERROR;

  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    const { data: currentData, error: fetchError } = await admin
      .from('i18n_translations')
      .select('translations')
      .eq('language', locale)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return {
          ok: false,
          error: `No translations row for locale "${locale}"`,
          conflict: false,
        };
      }
      return { ok: false, error: fetchError.message, conflict: false };
    }

    const currentTranslations =
      (currentData?.translations as Record<string, unknown>) || {};

    const mergedTranslations = mergeTranslationDelta(
      currentTranslations,
      sectionKey ? { [sectionKey]: sectionData } : sectionData
    ) as Record<string, unknown>;

    const { data, error } = await admin
      .from('i18n_translations')
      .update({ translations: mergedTranslations })
      .eq('language', locale)
      .filter('translations', 'eq', JSON.stringify(currentTranslations))
      .select()
      .single();

    if (!error && data) {
      return { ok: true, translations: mergedTranslations };
    }

    // PGRST116 / empty data means the snapshot no longer matches (another
    // writer committed between the read and the write). Retry against fresh
    // state; a real error aborts immediately.
    if (error && error.code !== 'PGRST116') {
      return { ok: false, error: error.message, conflict: false };
    }
    lastError = CONFLICT_ERROR;
  }

  return { ok: false, error: lastError, conflict: true };
}

export async function i18nActions(
  operation: I18nOperation
): Promise<I18nResult> {
  let supabase: Awaited<ReturnType<typeof getCmsActionContext>>['supabase'];
  try {
    const context = await getCmsActionContext('admin');
    supabase = context.supabase;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unauthorized',
    };
  }

  if (
    (operation.type === 'UPDATE_SECTION' ||
      operation.type === 'UPDATE_SECTIONS') &&
    operation.sectionKey !== 'hero-section' &&
    operation.sectionKey !== 'request-form'
  ) {
    return {
      success: false,
      error: 'This translation namespace is owned by the public website',
    };
  }

  try {
    switch (operation.type) {
      case 'GET':
        return await getI18nData(supabase);

      case 'UPDATE_SECTION':
        return await updateSectionTranslations(
          operation.locale,
          operation.sectionKey,
          operation.sectionData
        );

      case 'UPDATE_SECTIONS':
        return await updateSectionTranslationsForLocales(
          operation.sectionKey,
          operation.sections
        );

      case 'UPDATE_PRIVACY':
        return await updatePrivacyPolicy(operation.locale, operation.markdown);

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('I18n action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function updateSectionTranslationsForLocales(
  sectionKey: string,
  sections: Record<string, Record<string, unknown>>
): Promise<I18nResult> {
  const locales = Object.keys(sections);
  const invalidLocale = locales.find(
    (locale) =>
      !VALID_LOCALES.includes(locale as (typeof VALID_LOCALES)[number])
  );
  if (invalidLocale) {
    return {
      success: false,
      error: `Invalid locale. Must be one of: ${VALID_LOCALES.join(', ')}`,
    };
  }

  const admin = getAdminClient();
  const localeEvidence: LocaleCommitEvidence[] = [];
  const failed: Array<{ locale: string; error: string }> = [];
  let committedAny = false;

  for (const locale of locales) {
    const outcome = await casMergeSection(
      admin,
      locale,
      sectionKey,
      sections[locale]
    );

    if (outcome.ok) {
      committedAny = true;
      localeEvidence.push({
        locale,
        committed: true,
        translations: outcome.translations,
      });
    } else {
      localeEvidence.push({
        locale,
        committed: false,
        error: outcome.error,
      });
      failed.push({ locale, error: outcome.error });
    }
  }

  // Partial commits are a valid database outcome: invalidate whenever at least
  // one locale committed, and report `success:false` when any locale failed.
  let revalidation: RevalidationStatus | undefined;
  if (committedAny) {
    revalidation = await invalidatePublicContent({
      entity: 'translations',
      operation: 'update',
    });
    invalidateLocalCache('translations');
  }

  return {
    success: failed.length === 0,
    data: { locales: localeEvidence, failed },
    error:
      failed.length > 0
        ? failed.map((entry) => `${entry.locale}: ${entry.error}`).join('\n')
        : undefined,
    revalidation,
  };
}

async function getI18nData(supabase: SupabaseClient): Promise<I18nResult> {
  try {
    const { data, error } = await supabase
      .from('i18n_translations')
      .select('*')
      .order('language', { ascending: true });

    if (error) throw error;

    return { success: true, data };
  } catch (error) {
    console.error('Error fetching i18n data:', error);
    return {
      success: false,
      error: 'Failed to fetch i18n data',
    };
  }
}

async function updateSectionTranslations(
  locale: string,
  sectionKey: string,
  sectionData: Record<string, unknown>
): Promise<I18nResult> {
  if (!VALID_LOCALES.includes(locale as (typeof VALID_LOCALES)[number])) {
    return {
      success: false,
      error: `Invalid locale. Must be one of: ${VALID_LOCALES.join(', ')}`,
    };
  }

  const admin = getAdminClient();
  const outcome = await casMergeSection(admin, locale, sectionKey, sectionData);

  if (!outcome.ok) {
    return { success: false, error: outcome.error };
  }

  const revalidation = await invalidatePublicContent({
    entity: 'translations',
    operation: 'update',
  });
  invalidateLocalCache('translations');

  return {
    success: true,
    data: { translations: outcome.translations },
    revalidation,
  };
}

async function updatePrivacyPolicy(
  locale: string,
  markdown: string
): Promise<I18nResult> {
  try {
    if (!VALID_LOCALES.includes(locale as (typeof VALID_LOCALES)[number])) {
      return {
        success: false,
        error: `Invalid locale. Must be one of: ${VALID_LOCALES.join(', ')}`,
      };
    }

    if (typeof markdown !== 'string' || markdown.length > 50000) {
      return {
        success: false,
        error: 'Privacy policy content is too long (max 50,000 characters)',
      };
    }

    const admin = getAdminClient();
    // Column-only write: the public site reads the top-level privacy_policy
    // column. The translations JSON is deliberately NOT read or written here,
    // so this action can never clobber a concurrent translations edit.
    const { data, error } = await admin
      .from('i18n_translations')
      .update({ privacy_policy: markdown })
      .eq('language', locale)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return {
          success: false,
          error: `No translations row for locale "${locale}"`,
        };
      }
      throw error;
    }

    const revalidation = await invalidatePublicContent({
      entity: 'privacy',
      operation: 'update',
    });
    invalidateLocalCache('privacy');

    return { success: true, data, revalidation };
  } catch (error) {
    console.error('Error updating privacy policy:', error);
    return {
      success: false,
      error: 'Failed to update privacy policy',
    };
  }
}

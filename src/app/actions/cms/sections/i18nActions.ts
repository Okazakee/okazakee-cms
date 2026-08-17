'use server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  getCmsActionContext,
} from '@/app/actions/cms/utils/fileHelpers';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { getContentInvalidation } from '@/libs/cms/invalidation';

type I18nOperation =
  | { type: 'GET' }
  | { type: 'UPDATE'; locale: string; data: UpdateI18nData }
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

type UpdateI18nData = {
  translations: Record<string, unknown>;
  privacy_policy?: string;
};

type I18nResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

// Validation functions
function validateI18nData(
  locale: string,
  data: UpdateI18nData
): { isValid: boolean; error?: string } {
  // Locale validation
  const validLocales = ['en', 'it'];
  if (!validLocales.includes(locale)) {
    return {
      isValid: false,
      error: `Invalid locale. Must be one of: ${validLocales.join(', ')}`,
    };
  }

  // Translations validation
  if (!data.translations || typeof data.translations !== 'object') {
    return { isValid: false, error: 'Translations must be a valid object' };
  }

  // Check that translations object is not empty
  if (Object.keys(data.translations).length === 0) {
    return { isValid: false, error: 'Translations object cannot be empty' };
  }

  // Privacy policy validation (if provided)
  if (data.privacy_policy !== undefined && data.privacy_policy !== null) {
    if (typeof data.privacy_policy !== 'string') {
      return { isValid: false, error: 'Privacy policy must be a string' };
    }
    if (data.privacy_policy.length > 50000) {
      return {
        isValid: false,
        error: 'Privacy policy content is too long (max 50,000 characters)',
      };
    }
  }

  return { isValid: true };
}

// Helper function to deep merge objects
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const output = { ...target };

  for (const key in source) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      output[key] = deepMerge(
        (target[key] as Record<string, unknown>) || {},
        source[key] as Record<string, unknown>
      );
    } else {
      output[key] = source[key];
    }
  }

  return output;
}

// Helper function to merge section translations
function mergeSectionTranslations(
  currentTranslations: Record<string, unknown>,
  sectionKey: string,
  newSectionData: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...currentTranslations };
  merged[sectionKey] = deepMerge(
    (currentTranslations[sectionKey] as Record<string, unknown>) || {},
    newSectionData
  );
  return merged;
}

export async function i18nActions(
  operation: I18nOperation
): Promise<I18nResult> {
  // Admin check - only admins can manage i18n
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

  try {
    switch (operation.type) {
      case 'GET':
        return await getI18nData(supabase);

      case 'UPDATE':
        return await updateI18nData(supabase, operation.locale, operation.data);

      case 'UPDATE_SECTION':
        return await updateSectionTranslations(
          supabase,
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
  try {
    const validLocales = ['en', 'it'];
    const locales = Object.keys(sections);
    const invalidLocale = locales.find(
      (locale) => !validLocales.includes(locale)
    );
    if (invalidLocale) {
      return {
        success: false,
        error: `Invalid locale. Must be one of: ${validLocales.join(', ')}`,
      };
    }

    const admin = getAdminClient();
    const updated: unknown[] = [];

    for (const locale of locales) {
      const { data: currentData, error: fetchError } = await admin
        .from('i18n_translations')
        .select('translations, privacy_policy')
        .eq('language', locale)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      const currentTranslations =
        (currentData?.translations as Record<string, unknown>) || {};
      const mergedTranslations = mergeSectionTranslations(
        currentTranslations,
        sectionKey,
        sections[locale]
      );

      const { data, error } = await admin
        .from('i18n_translations')
        .upsert({
          language: locale,
          translations: mergedTranslations,
          privacy_policy: currentData?.privacy_policy || null,
        })
        .select()
        .single();

      if (error) throw error;
      updated.push(data);
    }

    await invalidatePublicContent({ entity: 'translations', operation: 'update' });

    return { success: true, data: updated };
  } catch (error) {
    console.error('Error updating section translations for locales:', error);
    return {
      success: false,
      error: 'Failed to update section translations',
    };
  }
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

async function updateI18nData(
  supabase: SupabaseClient,
  locale: string,
  updateData: UpdateI18nData
): Promise<I18nResult> {
  try {
    // Validate input data
    const validation = validateI18nData(locale, updateData);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const { data, error } = await supabase
      .from('i18n_translations')
      .upsert({
        language: locale,
        translations: updateData.translations,
        privacy_policy: updateData.privacy_policy,
      })
      .select()
      .single();

    if (error) throw error;

    // Invalidate cache
    await invalidatePublicContent({
      entity: 'translations',
      operation: 'update',
      extraTags: getContentInvalidation({
        entity: 'privacy',
        operation: 'update',
      }),
    });

    return { success: true, data };
  } catch (error) {
    console.error('Error updating i18n data:', error);
    return {
      success: false,
      error: 'Failed to update i18n data',
    };
  }
}

async function updateSectionTranslations(
  _supabase: SupabaseClient,
  locale: string,
  sectionKey: string,
  sectionData: Record<string, unknown>
): Promise<I18nResult> {
  try {
    const validLocales = ['en', 'it'];
    if (!validLocales.includes(locale)) {
      return {
        success: false,
        error: `Invalid locale. Must be one of: ${validLocales.join(', ')}`,
      };
    }

    const admin = getAdminClient();
    const { data: currentData, error: fetchError } = await admin
      .from('i18n_translations')
      .select('translations, privacy_policy')
      .eq('language', locale)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    const currentTranslations =
      (currentData?.translations as Record<string, unknown>) || {};

    const mergedTranslations = mergeSectionTranslations(
      currentTranslations,
      sectionKey,
      sectionData
    );

    const { data, error } = await admin
      .from('i18n_translations')
      .upsert({
        language: locale,
        translations: mergedTranslations,
        privacy_policy: currentData?.privacy_policy || null,
      })
      .select()
      .single();

    if (error) throw error;

    await invalidatePublicContent({ entity: 'translations', operation: 'update' });

    return { success: true, data };
  } catch (error) {
    console.error('Error updating section translations:', error);
    return {
      success: false,
      error: 'Failed to update section translations',
    };
  }
}

async function updatePrivacyPolicy(
  locale: string,
  markdown: string
): Promise<I18nResult> {
  try {
    const validLocales = ['en', 'it'];
    if (!validLocales.includes(locale)) {
      return {
        success: false,
        error: `Invalid locale. Must be one of: ${validLocales.join(', ')}`,
      };
    }

    if (typeof markdown !== 'string' || markdown.length > 50000) {
      return {
        success: false,
        error: 'Privacy policy content is too long (max 50,000 characters)',
      };
    }

    const admin = getAdminClient();
    const { data: currentData, error: fetchError } = await admin
      .from('i18n_translations')
      .select('translations, privacy_policy')
      .eq('language', locale)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    // Write the TOP-LEVEL privacy_policy column (what the public site reads)
    // while preserving the translations JSON untouched.
    const { data, error } = await admin
      .from('i18n_translations')
      .upsert({
        language: locale,
        translations:
          (currentData?.translations as Record<string, unknown>) || {},
        privacy_policy: markdown,
      })
      .select()
      .single();

    if (error) throw error;

    await invalidatePublicContent({ entity: 'privacy', operation: 'update' });

    return { success: true, data };
  } catch (error) {
    console.error('Error updating privacy policy:', error);
    return {
      success: false,
      error: 'Failed to update privacy policy',
    };
  }
}

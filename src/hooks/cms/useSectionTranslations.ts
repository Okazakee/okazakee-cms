'use client';

import { useCallback, useEffect, useState } from 'react';
import { i18nActions } from '@/app/actions/cms/sections/i18nActions';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import {
  demoHeroTranslations,
  demoRequestFormTranslations,
} from '@/libs/demo/fixtures';
import {
  computeTranslationDelta,
  isEmptyDelta,
} from '@/libs/cms/translationDelta';
import { useCmsStore } from '@/store/cmsStore';

export type FlatTranslations = Record<string, string>;
export type CmsLocale = 'en' | 'it';
export type LocaleFlat = Record<CmsLocale, FlatTranslations>;

function flatten(obj: Record<string, unknown>, prefix = ''): FlatTranslations {
  const result: FlatTranslations = {};

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      result[path] = '';
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string') {
          result[`${path}.${i}`] = value[i] as string;
        } else if (typeof value[i] === 'object' && value[i] !== null) {
          Object.assign(
            result,
            flatten(value[i] as Record<string, unknown>, `${path}.${i}`)
          );
        } else {
          result[`${path}.${i}`] = String(value[i] ?? '');
        }
      }
    } else if (typeof value === 'object') {
      Object.assign(result, flatten(value as Record<string, unknown>, path));
    } else {
      result[path] = String(value);
    }
  }

  return result;
}

/**
 * Unflattens dotted paths into nested objects. Numeric path segments become
 * object keys with numeric string names — never arrays. The backend treats an
 * object whose keys are all numeric as a partial array map and merges it per
 * index, which is what the DELTA contract requires (arrays would replace the
 * whole array in a JSON merge patch).
 */
export function unflattenDelta(
  flat: FlatTranslations
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split('.');
    let current = result;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (
        !(seg in current) ||
        typeof current[seg] !== 'object' ||
        current[seg] === null ||
        Array.isArray(current[seg])
      ) {
        current[seg] = {};
      }
      current = current[seg] as Record<string, unknown>;
    }

    current[segments[segments.length - 1]] = value;
  }

  return result;
}

function hasKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0;
}

/**
 * Drops nested empty objects the shared delta builder emits for unchanged
 * branches, so the payload contains only changed fields.
 */
function pruneEmptyDelta(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = pruneEmptyDelta(entry);
    if (next !== undefined) pruned[key] = next;
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

/**
 * Builds a nested DELTA containing only the fields whose value changed. When
 * nothing changed the result is an empty object (the locale is skipped).
 */
export function buildTranslationDelta(
  original: FlatTranslations,
  current: FlatTranslations
): Record<string, unknown> {
  // The shared delta builder emits only changed leaves. Feeding it the
  // object-map (never array) nested form keeps numeric array elements as
  // sparse index maps, which the backend merges per index.
  const delta = pruneEmptyDelta(
    computeTranslationDelta(unflattenDelta(original), unflattenDelta(current))
  );
  return isEmptyDelta(delta) ? {} : (delta as Record<string, unknown>);
}

/**
 * Builds the `UPDATE_SECTIONS` payload: one nested DELTA per locale that has
 * changed fields. The dispatcher deep-merges each section delta into the
 * current row under an optimistic read-snapshot CAS, so unchanged fields (and
 * concurrent edits to unrelated keys) are preserved.
 */
export function buildTranslationSections(
  originals: LocaleFlat,
  currents: LocaleFlat
): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {};

  for (const locale of ['en', 'it'] as const) {
    const original = originals[locale] ?? {};
    const current = currents[locale] ?? {};
    const patch = buildTranslationDelta(original, current);
    if (hasKeys(patch)) sections[locale] = patch;
  }

  return sections;
}

interface UseSectionTranslationsReturn {
  translations: LocaleFlat;
  isDirty: boolean;
  isLoading: boolean;
  error: string | null;
  /** Admins own the admin-only i18n GET; editors get controls hidden. */
  canEditTranslations: boolean;
  getField: (locale: CmsLocale, path: string) => string;
  setField: (locale: CmsLocale, path: string, value: string) => void;
  deleteField: (locale: CmsLocale, path: string) => void;
  saveTranslations: () => Promise<string[]>;
  revertTranslations: () => void;
  clearError: () => void;
}

const EMPTY_LOCALE_FLAT: LocaleFlat = { en: {}, it: {} };

/** Offline showcase slices keyed by translation section. */
const DEMO_SECTIONS: Record<string, LocaleFlat> = {
  'hero-section': {
    en: { ...demoHeroTranslations.en },
    it: { ...demoHeroTranslations.it },
  },
  'request-form': {
    en: { ...demoRequestFormTranslations.en },
    it: { ...demoRequestFormTranslations.it },
  },
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useSectionTranslations(
  sectionKey: string
): UseSectionTranslationsReturn {
  const canEditTranslations = useCmsStore(
    (state) => state.user?.role === 'admin'
  );
  const demoMode = useCmsStore((state) => state.demoMode);
  const [translations, setTranslations] =
    useState<LocaleFlat>(EMPTY_LOCALE_FLAT);
  const [original, setOriginal] = useState<LocaleFlat>(EMPTY_LOCALE_FLAT);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const beginLoad = useLatestRequest();

  const isDirty = !deepEqual(translations, original);

  useEffect(() => {
    // Offline showcase: fixture slice, no server round-trip.
    if (demoMode) {
      const fixture = DEMO_SECTIONS[sectionKey] ?? EMPTY_LOCALE_FLAT;
      const next: LocaleFlat = {
        en: { ...fixture.en },
        it: { ...fixture.it },
      };
      setTranslations(JSON.parse(JSON.stringify(next)));
      setOriginal(JSON.parse(JSON.stringify(next)));
      setIsLoading(false);
      setError(null);
      return;
    }
    // The i18n GET is admin-only; do not trigger an unauthorized request for
    // editors (their translation controls are hidden anyway).
    if (!canEditTranslations) {
      setIsLoading(false);
      setError(null);
      return;
    }

    // Stale translation loads must never overwrite newer drafts: only the
    // latest mounted request may replace editor state or clear its spinner.
    const current = beginLoad();
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    i18nActions({ type: 'GET' })
      .then((result) => {
        if (cancelled || !current()) return;
        if (!result.success) {
          setError(result.error || 'translations: failed to load');
          return;
        }

        const i18nData = result.data as Array<{
          language: string;
          translations: Record<string, unknown>;
        }>;

        const enData = i18nData.find((d) => d.language === 'en');
        const itData = i18nData.find((d) => d.language === 'it');

        const enSectionRaw = (
          sectionKey ? enData?.translations?.[sectionKey] : enData?.translations
        ) as Record<string, unknown> | undefined;
        const itSectionRaw = (
          sectionKey ? itData?.translations?.[sectionKey] : itData?.translations
        ) as Record<string, unknown> | undefined;

        const enFlat = enSectionRaw ? flatten(enSectionRaw) : {};
        const itFlat = itSectionRaw ? flatten(itSectionRaw) : {};

        const next: LocaleFlat = { en: enFlat, it: itFlat };
        setTranslations(JSON.parse(JSON.stringify(next)));
        setOriginal(JSON.parse(JSON.stringify(next)));
      })
      .catch((err) => {
        if (!cancelled && current()) {
          setError(
            err instanceof Error ? err.message : 'translations: failed to load'
          );
        }
      })
      .finally(() => {
        if (!cancelled && current()) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sectionKey, canEditTranslations, beginLoad, demoMode]);

  const getField = useCallback(
    (locale: CmsLocale, path: string): string => {
      const fields = translations[locale];
      return Object.hasOwn(fields, path) ? fields[path] : '';
    },
    [translations]
  );

  const setField = useCallback(
    (locale: CmsLocale, path: string, value: string) => {
      setTranslations((prev) => ({
        ...prev,
        [locale]: { ...prev[locale], [path]: value },
      }));
    },
    []
  );

  const deleteField = useCallback((locale: CmsLocale, path: string) => {
    setTranslations((prev) => {
      const localeFields = prev[locale];
      if (!(path in localeFields)) return prev;
      const next = { ...localeFields };
      delete next[path];
      return { ...prev, [locale]: next };
    });
  }, []);

  const saveTranslations = useCallback(async (): Promise<string[]> => {
    const sections = buildTranslationSections(original, translations);
    if (Object.keys(sections).length === 0) return [];

    // Offline showcase: commit locally with a beat for realism.
    if (useCmsStore.getState().demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      setOriginal(JSON.parse(JSON.stringify(translations)));
      return [];
    }

    let result: Awaited<ReturnType<typeof i18nActions>>;
    try {
      result = await i18nActions({
        type: 'UPDATE_SECTIONS',
        sectionKey,
        sections,
      });
    } catch (err) {
      // Never drop the drafts on a transport failure.
      return [
        err instanceof Error ? err.message : 'translations: request failed',
      ];
    }

    const data = result.data as
      | {
          locales?: Array<{ locale: string; committed?: boolean }>;
          failed?: Array<{ locale: string; error?: string }>;
        }
      | undefined;

    // Committed evidence is returned even on partial failure, so a single
    // locale that failed never keeps another locale's successful draft dirty.
    if (!Array.isArray(data?.locales)) {
      // Without a per-locale commit report we cannot know what to clear, so
      // keep every draft and surface the contract violation.
      return [
        result.error ??
          'translations: incomplete response (no locales reported)',
      ];
    }

    const committed = data.locales
      .filter(
        (entry) => entry.committed === true && typeof entry.locale === 'string'
      )
      .map((entry) => entry.locale);

    // Clear only the committed locales; failed locales keep their drafts.
    setOriginal((prev) => {
      const next: LocaleFlat = { ...prev };
      for (const locale of committed) {
        if (locale === 'en' || locale === 'it') {
          next[locale] = { ...(translations[locale] ?? {}) };
        }
      }
      return next;
    });

    const errors: string[] = [];
    for (const failure of data.failed ?? []) {
      if (failure && typeof failure.locale === 'string') {
        errors.push(
          `translations ${failure.locale}: ${failure.error ?? 'failed'}`
        );
      }
    }
    if (!result.success && errors.length === 0) {
      errors.push(result.error || 'translations: failed');
    }

    // A revalidation warning is informational: the writes committed and the
    // drafts were already cleared, so it must never be treated as a failure.
    const warning = revalidationWarning(result);
    if (warning) useCmsStore.getState().setWarning(warning);

    return errors;
  }, [sectionKey, translations, original]);

  const revertTranslations = useCallback(() => {
    setTranslations(JSON.parse(JSON.stringify(original)));
  }, [original]);

  const clearError = useCallback(() => setError(null), []);

  return {
    translations,
    isDirty,
    isLoading,
    error,
    canEditTranslations,
    getField,
    setField,
    deleteField,
    saveTranslations,
    revertTranslations,
    clearError,
  };
}

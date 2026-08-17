'use client';

import { useCallback, useEffect, useState } from 'react';
import { i18nActions } from '@/app/actions/cms/sections/i18nActions';

type FlatTranslations = Record<string, string>;
type NestedTranslations = Record<string, unknown>;

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
          Object.assign(result, flatten(value[i] as Record<string, unknown>, `${path}.${i}`));
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

function unflatten(flat: FlatTranslations): NestedTranslations {
  const result: NestedTranslations = {};

  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split('.');
    let current = result;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!(seg in current) || typeof current[seg] !== 'object' || current[seg] === null) {
        const nextSeg = segments[i + 1];
        current[seg] = /^\d+$/.test(nextSeg) ? [] : {};
      }
      current = current[seg] as Record<string, unknown>;
    }

    const lastKey = segments[segments.length - 1];
    (current as Record<string, unknown>)[lastKey] = value;
  }

  const convertArrays = (obj: unknown): unknown => {
    if (Array.isArray(obj)) {
      return obj.map(convertArrays);
    }
    if (obj && typeof obj === 'object') {
      const keys = Object.keys(obj as Record<string, unknown>);
      const allNumeric = keys.every((k) => /^\d+$/.test(k));
      if (allNumeric && keys.length > 0) {
        const arr: unknown[] = [];
        const numericKeys = keys.map(Number).sort((a, b) => a - b);
        for (const nk of numericKeys) {
          const val = (obj as Record<string, unknown>)[String(nk)];
          // If the element is still a nested object, recursively convert arrays within
          arr[nk] = (typeof val === 'object' && val !== null)
            ? convertArrays(val)
            : val;
        }
        return arr;
      }
      const converted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        converted[k] = convertArrays(v);
      }
      return converted;
    }
    return obj;
  };

  return convertArrays(result) as NestedTranslations;
}

interface UseSectionTranslationsReturn {
  translations: { en: FlatTranslations; it: FlatTranslations };
  isDirty: boolean;
  isLoading: boolean;
  getField: (locale: 'en' | 'it', path: string) => string;
  setField: (locale: 'en' | 'it', path: string, value: string) => void;
  saveTranslations: () => Promise<string[]>;
  revertTranslations: () => void;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useSectionTranslations(
  sectionKey: string
): UseSectionTranslationsReturn {
  const [translations, setTranslations] = useState<{
    en: FlatTranslations;
    it: FlatTranslations;
  }>({ en: {}, it: {} });
  const [original, setOriginal] = useState<{
    en: FlatTranslations;
    it: FlatTranslations;
  }>({ en: {}, it: {} });
  const [isLoading, setIsLoading] = useState(true);

  const isDirty = !deepEqual(translations, original);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    i18nActions({ type: 'GET' })
      .then((result) => {
        if (cancelled || !result.success || !result.data) return;
        const i18nData = result.data as Array<{
          language: string;
          translations: Record<string, unknown>;
        }>;

        const enData = i18nData.find((d) => d.language === 'en');
        const itData = i18nData.find((d) => d.language === 'it');

        const enSectionRaw =
          (enData?.translations?.[sectionKey] as NestedTranslations) || {};
        const itSectionRaw =
          (itData?.translations?.[sectionKey] as NestedTranslations) || {};

        const enFlat = Object.keys(enSectionRaw).length > 0 ? flatten(enSectionRaw) : {};
        const itFlat = Object.keys(itSectionRaw).length > 0 ? flatten(itSectionRaw) : {};

        const next = { en: enFlat, it: itFlat };
        setTranslations(JSON.parse(JSON.stringify(next)));
        setOriginal(JSON.parse(JSON.stringify(next)));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sectionKey]);

  const getField = useCallback(
    (locale: 'en' | 'it', path: string): string => {
      return translations[locale]?.[path] ?? '';
    },
    [translations]
  );

  const setField = useCallback(
    (locale: 'en' | 'it', path: string, value: string) => {
      setTranslations((prev) => ({
        ...prev,
        [locale]: { ...prev[locale], [path]: value },
      }));
    },
    []
  );

  const saveTranslations = useCallback(async (): Promise<string[]> => {
    const result = await i18nActions({
      type: 'UPDATE_SECTIONS',
      sectionKey,
      sections: {
        en: unflatten(translations.en),
        it: unflatten(translations.it),
      },
    });

    if (result.success) {
      setOriginal(JSON.parse(JSON.stringify(translations)));
      return [];
    }

    return [result.error || 'translations: failed'];
  }, [sectionKey, translations]);

  const revertTranslations = useCallback(() => {
    setTranslations(JSON.parse(JSON.stringify(original)));
  }, [original]);

  return {
    translations,
    isDirty,
    isLoading,
    getField,
    setField,
    saveTranslations,
    revertTranslations,
  };
}

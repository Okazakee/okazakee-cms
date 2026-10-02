'use client';

import {
  type AbstractIntlMessages,
  NextIntlClientProvider,
  useMessages,
} from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { i18nActions } from '@/app/actions/cms/sections/i18nActions';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { unflattenDelta } from '@/hooks/cms/useSectionTranslations';
import { mergeTranslationDelta } from '@/libs/cms/translationDelta';

interface PreviewTranslationsProps {
  locale: 'en' | 'it';
  namespace: string;
  drafts: Record<'en' | 'it', Record<string, string>>;
  children: ReactNode;
}

// Mounted only inside an open preview. Public copy is readable by editors;
// admin-only write controls still use their separate authorization boundary.
export function PreviewTranslations({
  locale,
  namespace,
  drafts,
  children,
}: PreviewTranslationsProps) {
  const currentMessages = useMessages();
  const [messages, setMessages] = useState<Record<
    string,
    AbstractIntlMessages
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void i18nActions({ type: 'GET_PUBLIC' })
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !Array.isArray(result.data))
          throw new Error(result.error || 'Failed to load preview copy');
        const rows = result.data as Array<{
          language: string;
          translations: AbstractIntlMessages;
        }>;
        setMessages(
          Object.fromEntries(
            rows.map((row) => [row.language, row.translations])
          )
        );
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load preview copy'
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (error) return <ErrorBanner message={error} />;
  if (!messages)
    return (
      <p role="status" className="text-center text-text-muted">
        Loading preview…
      </p>
    );
  const delta = unflattenDelta(drafts[locale]);
  const merged = mergeTranslationDelta(
    messages[locale] || {},
    namespace ? { [namespace]: delta } : delta
  ) as AbstractIntlMessages;
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={{ ...currentMessages, ...merged }}
    >
      {children}
    </NextIntlClientProvider>
  );
}

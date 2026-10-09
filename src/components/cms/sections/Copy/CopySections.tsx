'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import {
  EditorGroup,
  EditorToolbar,
  editorInputClass,
} from '@/components/cms/shared/EditorBody';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';

const requestFields = [
  'eyebrow',
  'title',
  'subtitle',
  'name',
  'namePlaceholder',
  'email',
  'emailPlaceholder',
  'company',
  'companyPlaceholder',
  'website',
  'websitePlaceholder',
  'type',
  'typeOptions.0',
  'budget',
  'budgetOptions.0',
  'timeline',
  'timelineOptions.0',
  'request',
  'requestPlaceholder',
  'consent',
  'submit',
  'comingSoon',
];

const GROUP_BY_KEY: Record<string, 'intro' | 'submission'> = {
  eyebrow: 'intro',
  title: 'intro',
  subtitle: 'intro',
  consent: 'submission',
  submit: 'submission',
  comingSoon: 'submission',
};

const requestLabelKeys: Record<string, string> = {
  name: 'hero.nameLabel',
  email: 'account.emailLabel',
  company: 'career.companyLabel',
  website: 'career.websiteUrlLabel',
  eyebrow: 'copy.requestForm.eyebrowLabel',
  title: 'copy.requestForm.titleLabel',
  subtitle: 'copy.requestForm.subtitleLabel',
  namePlaceholder: 'copy.requestForm.namePlaceholderLabel',
  emailPlaceholder: 'copy.requestForm.emailPlaceholderLabel',
  companyPlaceholder: 'copy.requestForm.companyPlaceholderLabel',
  websitePlaceholder: 'copy.requestForm.websitePlaceholderLabel',
  type: 'copy.requestForm.typeLabel',
  typeOptions: 'copy.requestForm.typeOptionsLabel',
  budget: 'copy.requestForm.budgetLabel',
  budgetOptions: 'copy.requestForm.budgetOptionsLabel',
  timeline: 'copy.requestForm.timelineLabel',
  timelineOptions: 'copy.requestForm.timelineOptionsLabel',
  request: 'copy.requestForm.requestLabel',
  requestPlaceholder: 'copy.requestForm.requestPlaceholderLabel',
  consent: 'copy.requestForm.consentLabel',
  submit: 'copy.requestForm.submitLabel',
  comingSoon: 'copy.requestForm.comingSoonLabel',
};

export function CopyEditor({
  namespace,
  sectionKey,
  fields,
  showAll = false,
  labelKeys = {},
}: {
  namespace: string;
  sectionKey: string;
  fields: string[];
  showAll?: boolean;
  labelKeys?: Record<string, string>;
}) {
  const t = useTranslations('cms');
  const tr = useSectionTranslations(namespace);
  const [locale, setLocale] = useState<'en' | 'it'>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSectionDirty(sectionKey, tr.isDirty);

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const errors = await tr.saveTranslations();
      if (errors.length) throw new Error(errors.join('\n'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.saveFailed'));
      throw err;
    } finally {
      setBusy(false);
    }
  }, [tr, t]);
  const revert = () => {
    tr.revertTranslations();
    setError(null);
  };
  useSectionCallbacks(sectionKey, publish, revert);

  const keys = useMemo(
    () =>
      Array.from(
        new Set([
          ...fields,
          ...(showAll
            ? [
                ...Object.keys(tr.translations.en),
                ...Object.keys(tr.translations.it),
              ]
            : fields.flatMap((field) =>
                [
                  ...Object.keys(tr.translations.en),
                  ...Object.keys(tr.translations.it),
                ].filter((key) => key.startsWith(`${field.split('.')[0]}.`))
              )),
        ])
      ).sort(),
    [fields, showAll, tr.translations]
  );

  const grouped = useMemo(() => {
    const groups: Record<
      'intro' | 'formFields' | 'submission' | 'other',
      string[]
    > = { intro: [], formFields: [], submission: [], other: [] };
    const knownRoots = new Set<string>();
    for (const field of fields) knownRoots.add(field.split('.')[0]);
    for (const key of keys) {
      const fixedGroup = Object.hasOwn(GROUP_BY_KEY, key)
        ? GROUP_BY_KEY[key]
        : undefined;
      groups[
        fixedGroup ??
          (knownRoots.has(key.split('.')[0]) ? 'formFields' : 'other')
      ].push(key);
    }
    return groups;
  }, [fields, keys]);

  const renderGroup = (groupKeys: string[]) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {groupKeys.map((key) => {
        const rootKey = key.split('.')[0];
        const labelKey = Object.hasOwn(labelKeys, rootKey)
          ? labelKeys[rootKey]
          : undefined;
        const label =
          labelKey && t.has(labelKey)
            ? t(labelKey)
            : key
                .split('.')
                .map((segment) =>
                  segment
                    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                    .replace(/[_-]+/g, ' ')
                )
                .join(' › ');
        return (
          <label key={key} className="block min-w-0 space-y-1.5">
            <span className="block text-sm font-medium capitalize text-text-main">
              {label}
            </span>
            <span className="block font-mono text-[11px] break-words text-text-dim">
              {namespace || 'common'}.{key}
            </span>
            <textarea
              aria-label={`${namespace || 'common'}.${key} (${locale.toUpperCase()})`}
              value={tr.getField(locale, key)}
              onChange={(e) => tr.setField(locale, key, e.target.value)}
              rows={/subtitle|Text|description|consent/.test(key) ? 3 : 1}
              className={`${editorInputClass} min-h-11 resize-y`}
            />
          </label>
        );
      })}
    </div>
  );

  return (
    <fieldset
      disabled={busy || tr.isLoading}
      className="m-0 min-w-0 space-y-6 border-0 p-0"
    >
      <ErrorBanner
        message={error || tr.error}
        onDismiss={() => setError(null)}
      />
      <EditorToolbar
        title={t(`copy.namespaces.${namespace || 'common'}`)}
        actions={<LocaleToggle activeLocale={locale} onChange={setLocale} />}
      />
      {grouped.intro.length > 0 && (
        <EditorGroup title={t('editor.groups.intro')}>
          {renderGroup(grouped.intro)}
        </EditorGroup>
      )}
      {grouped.formFields.length > 0 && (
        <EditorGroup title={t('editor.groups.formFields')}>
          {renderGroup(grouped.formFields)}
        </EditorGroup>
      )}
      {grouped.submission.length > 0 && (
        <EditorGroup title={t('editor.groups.submission')}>
          {renderGroup(grouped.submission)}
        </EditorGroup>
      )}
      {grouped.other.length > 0 && (
        <EditorGroup title={t('editor.groups.other')}>
          {renderGroup(grouped.other)}
        </EditorGroup>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <SectionActions
          isDirty={tr.isDirty}
          busy={busy || tr.isLoading}
          onPublish={publish}
          onRevert={revert}
        />
      </div>
    </fieldset>
  );
}

export function RequestCopySection() {
  const t = useTranslations('cms');
  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('copy.requestTitle')}
        description={t('copy.requestDescription')}
      />
      <CopyEditor
        namespace="request-form"
        sectionKey="request-form"
        fields={requestFields}
        showAll
        labelKeys={requestLabelKeys}
      />
    </div>
  );
}

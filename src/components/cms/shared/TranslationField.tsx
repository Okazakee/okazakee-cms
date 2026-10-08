'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { ValidationMessage } from './ValidationMessage';

interface TranslationFieldProps {
  label: string;
  enValue: string;
  itValue: string;
  onChangeEn: (value: string) => void;
  onChangeIt: (value: string) => void;
  type?: 'text' | 'textarea' | 'url' | 'date' | 'number';
  rows?: number;
  enError?: string | null;
  itError?: string | null;
  enPlaceholder?: string;
  itPlaceholder?: string;
  required?: boolean;
  activeLocale?: 'en' | 'it';
}

export function TranslationField({
  label,
  enValue,
  itValue,
  onChangeEn,
  onChangeIt,
  type = 'text',
  rows = 3,
  enError,
  itError,
  enPlaceholder,
  itPlaceholder,
  required,
  activeLocale,
}: TranslationFieldProps) {
  const t = useTranslations('cms');
  const fieldId = useId();
  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none';

  if (activeLocale) {
    const value = activeLocale === 'en' ? enValue : itValue;
    const onChange = activeLocale === 'en' ? onChangeEn : onChangeIt;
    const error = activeLocale === 'en' ? enError : itError;
    const otherError = activeLocale === 'en' ? itError : enError;
    const placeholder = activeLocale === 'en' ? enPlaceholder : itPlaceholder;
    const id = `${fieldId}-${activeLocale}`;

    return (
      <div>
        <label
          htmlFor={id}
          className="block text-sm font-medium text-text-main mb-2"
        >
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <div className="flex items-center gap-1 mb-1">
          <span className="text-xs font-medium text-text-dim uppercase">
            {activeLocale === 'en' ? t('common.english') : t('common.italian')}
          </span>
        </div>
        {type === 'textarea' ? (
          <textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
            rows={rows}
            placeholder={placeholder}
          />
        ) : (
          <input
            id={id}
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
            placeholder={placeholder}
          />
        )}
        <ValidationMessage message={error} show />
        {otherError && (
          <ValidationMessage
            message={`${t('editor.otherLocaleError')} ${otherError}`}
            show
          />
        )}
      </div>
    );
  }

  const idEn = `${fieldId}-en`;
  const idIt = `${fieldId}-it`;

  return (
    <div>
      <p className="block text-sm font-medium text-text-main mb-2">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label htmlFor={idEn} className="flex items-center gap-1 mb-1">
            <span className="text-xs font-medium text-text-dim uppercase">
              {label} — {t('common.english')}
            </span>
          </label>
          {type === 'textarea' ? (
            <textarea
              id={idEn}
              value={enValue}
              onChange={(e) => onChangeEn(e.target.value)}
              className={inputClass}
              rows={rows}
              placeholder={enPlaceholder}
            />
          ) : (
            <input
              id={idEn}
              type={type}
              value={enValue}
              onChange={(e) => onChangeEn(e.target.value)}
              className={inputClass}
              placeholder={enPlaceholder}
            />
          )}
          <ValidationMessage message={enError} show />
        </div>
        <div>
          <label htmlFor={idIt} className="flex items-center gap-1 mb-1">
            <span className="text-xs font-medium text-text-dim uppercase">
              {label} — {t('common.italian')}
            </span>
          </label>
          {type === 'textarea' ? (
            <textarea
              id={idIt}
              value={itValue}
              onChange={(e) => onChangeIt(e.target.value)}
              className={inputClass}
              rows={rows}
              placeholder={itPlaceholder}
            />
          ) : (
            <input
              id={idIt}
              type={type}
              value={itValue}
              onChange={(e) => onChangeIt(e.target.value)}
              className={inputClass}
              placeholder={itPlaceholder}
            />
          )}
          <ValidationMessage message={itError} show />
        </div>
      </div>
    </div>
  );
}

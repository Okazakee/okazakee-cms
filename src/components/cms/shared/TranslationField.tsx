'use client';

import { useTranslations } from 'next-intl';
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
  const inputClass =
    'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none';

  if (activeLocale) {
    const value = activeLocale === 'en' ? enValue : itValue;
    const onChange = activeLocale === 'en' ? onChangeEn : onChangeIt;
    const error = activeLocale === 'en' ? enError : itError;
    const placeholder = activeLocale === 'en' ? enPlaceholder : itPlaceholder;
    const id = `tf-${label.replace(/\s+/g, '-').toLowerCase()}-${activeLocale}`;

    return (
      <div>
        <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-2">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <div className="flex items-center gap-1 mb-1">
          <span className="text-xs font-medium text-gray-400 uppercase">
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
      </div>
    );
  }

  const idEn = `tf-en-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const idIt = `tf-it-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div>
      <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-2">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1 mb-1">
            <span className="text-xs font-medium text-gray-400 uppercase">
              {t('common.english')}
            </span>
          </div>
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
          <div className="flex items-center gap-1 mb-1">
            <span className="text-xs font-medium text-gray-400 uppercase">
              {t('common.italian')}
            </span>
          </div>
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

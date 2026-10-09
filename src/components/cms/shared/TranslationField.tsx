'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { MarkerEditor } from './MarkerEditor';
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
  /**
   * Shows the `****` violet-highlight runs as violet spans (markers
   * hidden) in a visual editor instead of a raw textarea/input.
   */
  markerHighlight?: boolean;
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
  markerHighlight = false,
}: TranslationFieldProps) {
  const t = useTranslations('cms');
  const fieldId = useId();
  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none';

  const renderField = (
    id: string,
    value: string,
    onChange: (v: string) => void,
    placeholder?: string
  ) => {
    if (markerHighlight && (type === 'text' || type === 'textarea')) {
      return (
        <MarkerEditor
          id={id}
          value={value}
          onChange={onChange}
          multiline={type === 'textarea'}
          minHeight={type === 'textarea' ? rows * 22 : 42}
          placeholder={placeholder}
        />
      );
    }
    return type === 'textarea' ? (
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
    );
  };

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
        {renderField(id, value, onChange, placeholder)}
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
          {renderField(idEn, enValue, onChangeEn, enPlaceholder)}
          <ValidationMessage message={enError} show />
        </div>
        <div>
          <label htmlFor={idIt} className="flex items-center gap-1 mb-1">
            <span className="text-xs font-medium text-text-dim uppercase">
              {label} — {t('common.italian')}
            </span>
          </label>
          {renderField(idIt, itValue, onChangeIt, itPlaceholder)}
          <ValidationMessage message={itError} show />
        </div>
      </div>
    </div>
  );
}

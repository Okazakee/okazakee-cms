'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef } from 'react';
import type { Ref, RefObject } from 'react';
import { HighlightToolbar } from './HighlightToolbar';
import { ValidationMessage } from './ValidationMessage';

type HighlightableRef = RefObject<
  HTMLTextAreaElement | HTMLInputElement | null
>;

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
  /** Shows the `****` violet-highlight toolbar above the field(s). */
  highlightable?: boolean;
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
  highlightable = false,
}: TranslationFieldProps) {
  const t = useTranslations('cms');
  const fieldId = useId();
  const enRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const itRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none';

  const renderToolbar = (targetRef: HighlightableRef, onChange: (v: string) => void) =>
    highlightable ? (
      <HighlightToolbar targetRef={targetRef} onChange={onChange} />
    ) : null;

  if (activeLocale) {
    const value = activeLocale === 'en' ? enValue : itValue;
    const onChange = activeLocale === 'en' ? onChangeEn : onChangeIt;
    const error = activeLocale === 'en' ? enError : itError;
    const otherError = activeLocale === 'en' ? itError : enError;
    const placeholder = activeLocale === 'en' ? enPlaceholder : itPlaceholder;
    const id = `${fieldId}-${activeLocale}`;
    const fieldRef = activeLocale === 'en' ? enRef : itRef;

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
        {renderToolbar(fieldRef, onChange)}
        {type === 'textarea' ? (
          <textarea
            id={id}
            ref={fieldRef as Ref<HTMLTextAreaElement>}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
            rows={rows}
            placeholder={placeholder}
          />
        ) : (
          <input
            id={id}
            ref={fieldRef as Ref<HTMLInputElement>}
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
          {renderToolbar(enRef, onChangeEn)}
          {type === 'textarea' ? (
            <textarea
              id={idEn}
              ref={enRef as Ref<HTMLTextAreaElement>}
              value={enValue}
              onChange={(e) => onChangeEn(e.target.value)}
              className={inputClass}
              rows={rows}
              placeholder={enPlaceholder}
            />
          ) : (
            <input
              id={idEn}
              ref={enRef as Ref<HTMLInputElement>}
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
          {renderToolbar(itRef, onChangeIt)}
          {type === 'textarea' ? (
            <textarea
              id={idIt}
              ref={itRef as Ref<HTMLTextAreaElement>}
              value={itValue}
              onChange={(e) => onChangeIt(e.target.value)}
              className={inputClass}
              rows={rows}
              placeholder={itPlaceholder}
            />
          ) : (
            <input
              id={idIt}
              ref={itRef as Ref<HTMLInputElement>}
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

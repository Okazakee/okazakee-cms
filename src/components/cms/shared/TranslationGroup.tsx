'use client';

import { useTranslations } from 'next-intl';

interface TranslationGroupField {
  path: string;
  label: string;
  type?: 'text' | 'textarea';
  rows?: number;
  placeholder?: string;
}

interface TranslationGroupProps {
  enData: Record<string, string>;
  itData: Record<string, string>;
  onChange: (locale: 'en' | 'it', path: string, value: string) => void;
  fields: TranslationGroupField[];
  title?: string;
}

export function TranslationGroup({
  enData,
  itData,
  onChange,
  fields,
  title,
}: TranslationGroupProps) {
  const t = useTranslations('cms');
  const inputClass =
    'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none text-sm';

  return (
    <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
      {title && (
        <h2 className="text-lg md:text-xl font-bold text-main mb-4 flex items-center gap-2">
          {title}
        </h2>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 dark:border-darkgray">
              <th className="text-left py-2 pr-4 text-sm font-medium text-darktext dark:text-lighttext whitespace-nowrap">
                Field
              </th>
              <th className="text-left py-2 px-4 text-sm font-medium text-darktext dark:text-lighttext">
                {t('common.english')}
              </th>
              <th className="text-left py-2 pl-4 text-sm font-medium text-darktext dark:text-lighttext">
                {t('common.italian')}
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr
                key={field.path}
                className="border-b border-gray-100 dark:border-darkgray/50"
              >
                <td className="py-3 pr-4 text-sm font-medium text-darktext dark:text-lighttext whitespace-nowrap">
                  {field.label}
                </td>
                <td className="py-3 px-2">
                  {field.type === 'textarea' ? (
                    <textarea
                      value={enData[field.path] ?? ''}
                      onChange={(e) =>
                        onChange('en', field.path, e.target.value)
                      }
                      className={inputClass}
                      rows={field.rows ?? 2}
                      placeholder={field.placeholder}
                    />
                  ) : (
                    <input
                      type="text"
                      value={enData[field.path] ?? ''}
                      onChange={(e) =>
                        onChange('en', field.path, e.target.value)
                      }
                      className={inputClass}
                      placeholder={field.placeholder}
                    />
                  )}
                </td>
                <td className="py-3 pl-2">
                  {field.type === 'textarea' ? (
                    <textarea
                      value={itData[field.path] ?? ''}
                      onChange={(e) =>
                        onChange('it', field.path, e.target.value)
                      }
                      className={inputClass}
                      rows={field.rows ?? 2}
                      placeholder={field.placeholder}
                    />
                  ) : (
                    <input
                      type="text"
                      value={itData[field.path] ?? ''}
                      onChange={(e) =>
                        onChange('it', field.path, e.target.value)
                      }
                      className={inputClass}
                      placeholder={field.placeholder}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

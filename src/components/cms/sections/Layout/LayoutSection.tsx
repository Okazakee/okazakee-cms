'use client';

import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';

export default function LayoutSection() {
  const t = useTranslations('cms');
  const [error, setError] = useState<string | null>(null);
  const [_isUpdating, setIsUpdating] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');

  const headerTr = useSectionTranslations('header');
  const footerTr = useSectionTranslations('footer');

  const isDirty = headerTr.isDirty || footerTr.isDirty;
  useSectionDirty('layout', isDirty);

  const inputClass = 'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none text-sm';

  const localeBtns = <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />;

  const renderField = (
    label: string,
    path: string,
    tr: ReturnType<typeof useSectionTranslations>
  ) => (
    <div>
      <label className="block text-xs font-medium text-gray-500 dark:text-lighttext2 mb-1">{label}</label>
      <input
        type="text"
        value={tr.getField(activeLocale, path)}
        onChange={(e) => tr.setField(activeLocale, path, e.target.value)}
        className={inputClass}
      />
    </div>
  );

  const renderButtonsList = () => {
    const tr = headerTr;
    // Collect existing button indices from flat keys
    const buttonIndices: number[] = [];
    for (const key of Object.keys(tr.translations[activeLocale])) {
      const m = key.match(/^buttons\.(\d+)$/);
      if (m) buttonIndices.push(parseInt(m[1], 10));
    }
    buttonIndices.sort((a, b) => a - b);

    const addButton = () => {
      const nextIdx = buttonIndices.length > 0 ? Math.max(...buttonIndices) + 1 : 0;
      for (const loc of ['en', 'it'] as const) {
        tr.setField(loc, `buttons.${nextIdx}`, '');
      }
    };

    const removeButton = (idx: number) => {
      for (const loc of ['en', 'it'] as const) {
        tr.setField(loc, `buttons.${idx}`, '');
      }
    };

    return (
      <div className="space-y-2">
        {buttonIndices.map((idx) => {
          const val = tr.getField(activeLocale, `buttons.${idx}`);
          if (val === undefined) return null;
          return (
            <div key={idx} className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-6">{idx + 1}</span>
              <input
                type="text"
                value={val}
                onChange={(e) => tr.setField(activeLocale, `buttons.${idx}`, e.target.value)}
                className={`flex-1 ${inputClass}`}
                placeholder={t('layout.headerButtonPlaceholder', { index: idx + 1 })}
              />
              <button type="button" onClick={() => removeButton(idx)} className="p-1.5 text-red-400 hover:text-red-300"><X className="w-3 h-3" /></button>
            </div>
          );
        })}
        <button type="button" onClick={addButton} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-main hover:bg-secondary text-white rounded-lg transition-colors">
          <Plus className="w-3 h-3" />{t('common.add')}
        </button>
      </div>
    );
  };

  const handlePublish = useCallback(async () => {
    setIsUpdating(true); setError(null);
    const errors: string[] = [];
    if (headerTr.isDirty) { const e = await headerTr.saveTranslations(); errors.push(...e); }
    if (footerTr.isDirty) { const e = await footerTr.saveTranslations(); errors.push(...e); }
    setIsUpdating(false);
    if (errors.length > 0) setError(errors.join('\n'));
  }, [headerTr, footerTr]);

  const handleRevert = useCallback(() => {
    setShowConfirmRevert(false);
    headerTr.revertTranslations();
    footerTr.revertTranslations();
    setError(null);
  }, [headerTr, footerTr]);

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const loading = headerTr.isLoading || footerTr.isLoading;

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader title={t('layout.title')} description={t('layout.subtitle')} />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" /></div>
      ) : (
        <>
          {/* Sticky locale toggle */}
          <div className="sticky top-0 z-10 bg-bglight/90 dark:bg-bgdark/90 backdrop-blur-sm py-2 -mx-2 px-2 rounded-lg">
            <div className="flex items-center justify-end">
              {localeBtns}
            </div>
          </div>

          {/* Header */}
          <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 border-l-4 border-main">
            <h2 className="text-lg md:text-xl font-bold text-main mb-4">{t('layout.headerTranslationsTitle')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              {renderField(t('layout.headerThemeLabel'), 'theme', headerTr)}
              {renderField(t('layout.headerLanguageLabel'), 'language', headerTr)}
              {renderField(t('layout.headerSettingsLabel'), 'settings', headerTr)}
            </div>
            <div className="pt-4 border-t border-gray-200 dark:border-darkgray/50">
              <h3 className="text-sm font-semibold text-darktext dark:text-lighttext mb-3">{t('layout.headerNavButtonsLabel')}</h3>
              {renderButtonsList()}
            </div>
          </div>

          {/* Footer */}
          <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 border-l-4 border-secondary">
            <h2 className="text-lg md:text-xl font-bold text-main mb-4">{t('layout.footerTranslationsTitle')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {renderField(t('layout.footerLeftLabel'), 'left', footerTr)}
              {renderField(t('layout.footerMiddleLabel'), 'middle', footerTr)}
              {renderField(t('layout.footerRightLabel'), 'right', footerTr)}
              {renderField(t('layout.footerSourceLabel'), 'source', footerTr)}
              {renderField(t('layout.footerButtonTitleLabel'), 'buttonTitle', footerTr)}
              {renderField(t('layout.footerPrivacyPolicyLabel'), 'privacyPolicy', footerTr)}
              {renderField(t('layout.footerDarkModeLabel'), 'darkmode', footerTr)}
              {renderField(t('layout.footerLightModeLabel'), 'lightmode', footerTr)}
            </div>
          </div>
        </>
      )}

      <ConfirmDialog isOpen={showConfirmRevert} title={t('common.revertAll')} message={t('common.confirmRevertAll')} confirmLabel={t('common.revert')} confirmVariant="primary" onConfirm={handleRevert} onCancel={() => setShowConfirmRevert(false)} />
    </div>
  );
}

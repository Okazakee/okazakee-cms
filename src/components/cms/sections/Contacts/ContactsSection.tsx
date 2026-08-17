'use client';

import { ExternalLink, Plus, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import { contactsActions } from '@/app/actions/cms/sections/contactsActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { IconPicker } from '@/components/cms/shared/IconPicker';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useCmsStore } from '@/store/cmsStore';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { ContactsPreview } from '@/components/common/cms/previews/ContactsPreview';
import type { Contact } from '@/types/fetchedData.types';

export default function ContactsSection() {
  const t = useTranslations('cms');
  const { heroSection, setHeroSection } = useCmsStore();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_isUpdating, setIsUpdating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);

  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newContacts, setNewContacts] = useState<Contact[]>([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [orderChanged, setOrderChanged] = useState(false);

  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState({ label: '', icon: 'Link', link: '', bg_color: '#000000' });
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');

  const resumeEnUpload = useFileUpload({ accept: '.pdf', maxSizeMB: 10 });
  const resumeItUpload = useFileUpload({ accept: '.pdf', maxSizeMB: 10 });
  const resumeInitRef = useRef(false);

  const {
    isDirty: transDirty, isLoading: transLoading,
    getField, setField, saveTranslations, revertTranslations,
  } = useSectionTranslations('contacts-section');

  const isDirty = modifiedIds.size > 0 || newContacts.length > 0 || deletedIds.size > 0 || orderChanged || transDirty || resumeEnUpload.file !== null || resumeItUpload.file !== null;
  useSectionDirty('contacts', isDirty);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const r = await contactsActions({ type: 'GET' });
      if (!r.success) throw new Error(r.error || 'Failed');
      setContacts(r.data as Contact[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally { setIsLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!heroSection || resumeInitRef.current) return;
    resumeInitRef.current = true;
    if (heroSection.resume_en) resumeEnUpload.setFileFromUrl(heroSection.resume_en);
    if (heroSection.resume_it) resumeItUpload.setFileFromUrl(heroSection.resume_it);
  }, [heroSection, resumeEnUpload, resumeItUpload]);

  const handleAdd = () => {
    if (!newForm.label || !newForm.icon || !newForm.link) { setError('Label, icon, and link are required'); return; }
    const temp: Contact = { id: -Date.now(), position: contacts.length, ...newForm };
    setContacts((prev) => [...prev, temp]);
    setNewContacts((prev) => [...prev, temp]);
    setNewForm({ label: '', icon: 'Link', link: '', bg_color: '#000000' });
    setIsAdding(false);
  };

  const handleChange = (id: number, field: keyof Contact, value: string | number) => {
    setContacts((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    setModifiedIds((prev) => new Set(prev).add(id));
  };

  const handleDelete = (id: number) => {
    const isNew = newContacts.some((n) => n.id === id);
    if (isNew) setNewContacts((prev) => prev.filter((n) => n.id !== id));
    else setDeletedIds((prev) => new Set(prev).add(id));
    setContacts((prev) => prev.filter((c) => c.id !== id));
  };

  const move = (id: number, dir: -1 | 1) => {
    const idx = contacts.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= contacts.length) return;
    const next = [...contacts];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setContacts(next.map((c, i) => ({ ...c, position: i })));
    setOrderChanged(true);
  };

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    setIsUpdating(true); setError(null);

    // Resume uploads via hero actions
    if (resumeEnUpload.file || resumeItUpload.file) {
      const result = await heroActions({
        type: 'UPDATE_WITH_FILES',
        files: {
          ...(resumeEnUpload.file ? { resume_en: resumeEnUpload.file } : {}),
          ...(resumeItUpload.file ? { resume_it: resumeItUpload.file } : {}),
        },
        currentData: {
          mainImage: heroSection?.mainImage || '',
          resume_en: heroSection?.resume_en || '',
          resume_it: heroSection?.resume_it || '',
        },
      });
      if (!result.success) {
        errors.push(result.error || t('hero.errorUpdateHero'));
      } else {
        const data = result.data as { resume_en?: string; resume_it?: string };
        setHeroSection({
          mainImage: heroSection?.mainImage || null,
          blurhashURL: heroSection?.blurhashURL || null,
          resume_en: data.resume_en || heroSection?.resume_en || null,
          resume_it: data.resume_it || heroSection?.resume_it || null,
        });
        resumeEnUpload.clearFile();
        resumeItUpload.clearFile();
      }
    }

    const batch = await contactsActions({
      type: 'BATCH_PUBLISH',
      creates: newContacts.map((c, i) => ({
        label: c.label,
        icon: c.icon,
        link: c.link,
        bg_color: c.bg_color,
        position: c.position ?? i,
      })),
      updates: Array.from(modifiedIds).flatMap((id) => {
        const c = contacts.find((cc) => cc.id === id);
        if (!c || id < 0) return [];
        return [{
          id,
          data: {
            label: c.label,
            icon: c.icon,
            link: c.link,
            bg_color: c.bg_color,
            position: c.position,
          },
        }];
      }),
      deletes: Array.from(deletedIds),
      reorder: orderChanged
        ? contacts.filter((c) => c.id > 0).map((c, i) => ({ id: c.id, position: i }))
        : [],
    });
    if (!batch.success && batch.error) errors.push(batch.error);
    if (transDirty) { const tErrs = await saveTranslations(); errors.push(...tErrs); }
    await fetchData();
    setModifiedIds(new Set()); setNewContacts([]); setDeletedIds(new Set()); setOrderChanged(false); setIsUpdating(false);
    if (errors.length > 0) setError(errors.join('\n'));
  }, [contacts, newContacts, deletedIds, modifiedIds, orderChanged, transDirty, saveTranslations, fetchData, resumeEnUpload, resumeItUpload, heroSection, setHeroSection, t]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    fetchData();
    setModifiedIds(new Set());
    setNewContacts([]);
    setDeletedIds(new Set());
    setOrderChanged(false);
    resumeEnUpload.clearFile();
    resumeItUpload.clearFile();
    if (heroSection?.resume_en) resumeEnUpload.setFileFromUrl(heroSection.resume_en);
    if (heroSection?.resume_it) resumeItUpload.setFileFromUrl(heroSection.resume_it);
    revertTranslations();
    setError(null);
  };

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const inputClass = 'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none text-sm';

  if (isLoading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" /></div>;

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader title={t('contacts.title')} description={t('contacts.subtitle')} />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Translations */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-main">{t('common.translations')}</h2>
          <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
        </div>
        {transLoading ? <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-main" /></div> : (
          <div className="space-y-4">
            <TranslationField label={t('contacts.translationTitleLabel')} enValue={getField('en', 'title')} itValue={getField('it', 'title')} onChangeEn={(v) => setField('en', 'title', v)} onChangeIt={(v) => setField('it', 'title', v)} activeLocale={activeLocale} />
            <TranslationField label={t('contacts.translationSubtitleLabel')} enValue={getField('en', 'subtitle')} itValue={getField('it', 'subtitle')} onChangeEn={(v) => setField('en', 'subtitle', v)} onChangeIt={(v) => setField('it', 'subtitle', v)} type="textarea" rows={3} activeLocale={activeLocale} />
          </div>
        )}
      </div>

      {/* Contact Links */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-darktext dark:text-lighttext">{t('contacts.title')}</h2>
        {!isAdding && (
          <button type="button" onClick={() => setIsAdding(true)} className="flex items-center gap-2 px-4 py-2 bg-main hover:bg-secondary text-white rounded-lg"><Plus className="w-4 h-4" />{t('contacts.addNewContact')}</button>
        )}
      </div>

      {isAdding && (
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-3">
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('contacts.iconNameLabel')}</label>
            <IconPicker value={newForm.icon} onChange={(v) => setNewForm((p) => ({ ...p, icon: v }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('contacts.labelFieldLabel')}</label>
            <input type="text" value={newForm.label} onChange={(e) => setNewForm((p) => ({ ...p, label: e.target.value }))} className={inputClass} placeholder={t('contacts.labelPlaceholder')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('contacts.linkLabel')}</label>
            <input type="url" value={newForm.link} onChange={(e) => setNewForm((p) => ({ ...p, link: e.target.value }))} className={inputClass} placeholder={t('contacts.linkPlaceholder')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('common.color')}</label>
            <div className="flex items-center gap-2">
              <input type="color" value={newForm.bg_color} onChange={(e) => setNewForm((p) => ({ ...p, bg_color: e.target.value }))} className="w-10 h-10 rounded cursor-pointer border-0" />
              <input type="text" value={newForm.bg_color} onChange={(e) => setNewForm((p) => ({ ...p, bg_color: e.target.value }))} className={`flex-1 ${inputClass}`} placeholder="#000000" />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={handleAdd} className="px-4 py-2 min-h-[44px] bg-green-600 hover:bg-green-700 text-white rounded-lg">{t('common.add')}</button>
            <button type="button" onClick={() => { setIsAdding(false); setNewForm({ label: '', icon: 'Link', link: '', bg_color: '#000000' }); }} className="px-4 py-2 min-h-[44px] bg-gray-600 hover:bg-gray-700 text-white rounded-lg"><X className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyState message={t('contacts.title')} />
      ) : (
        <div className="space-y-3">
          {contacts.map((c, idx) => (
            <div key={c.id} className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <CardToolbar
                  showReorder
                  onMoveUp={() => move(c.id, -1)}
                  onMoveDown={() => move(c.id, 1)}
                  isFirst={idx === 0}
                  isLast={idx === contacts.length - 1}
                />
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-white font-bold text-sm"
                  style={{ backgroundColor: c.bg_color }}
                >
                  {c.label.charAt(0)}
                </div>
                <input
                  type="text"
                  value={c.label}
                  onChange={(e) => handleChange(c.id, 'label', e.target.value)}
                  className={`flex-1 ${inputClass}`}
                  placeholder={t('contacts.labelPlaceholder')}
                />
                <button
                  type="button"
                  onClick={() => handleDelete(c.id)}
                  className="p-2 text-red-400 hover:text-red-300 flex-shrink-0"
                  title={t('common.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                <input
                  type="url"
                  value={c.link}
                  onChange={(e) => handleChange(c.id, 'link', e.target.value)}
                  className={`flex-1 ${inputClass}`}
                  placeholder={t('contacts.linkPlaceholder')}
                />
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input
                    type="color"
                    value={c.bg_color}
                    onChange={(e) => handleChange(c.id, 'bg_color', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer border-0 flex-shrink-0"
                  />
                  <div className="w-full sm:w-44">
                    <IconPicker value={c.icon} onChange={(v) => handleChange(c.id, 'icon', v)} />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Resume PDFs */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <h2 className="text-lg md:text-xl font-bold text-main mb-4">{t('hero.resumeLinksTitle')}</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-darktext dark:text-lighttext mb-2">{t('hero.uploadResumeItalian')}</h3>
            <FileDropzone
              previewUrl={resumeItUpload.previewUrl}
              isDragging={resumeItUpload.isDragging}
              isProcessing={resumeItUpload.isProcessing}
              error={resumeItUpload.error}
              currentUrl={heroSection?.resume_it ?? undefined}
              dropzoneProps={{
                onDragOver: resumeItUpload.dropzoneProps.onDragOver,
                onDragLeave: resumeItUpload.dropzoneProps.onDragLeave,
                onDrop: resumeItUpload.dropzoneProps.onDrop,
              }}
              fileInputProps={{
                ...resumeItUpload.fileInputProps,
                accept: '.pdf',
              }}
              fileInputRef={resumeItUpload.fileInputRef}
              onClear={resumeItUpload.clearFile}
              onBrowse={resumeItUpload.openFileDialog}
              compact
            />
            {heroSection?.resume_it && !resumeItUpload.file && (
              <div className="flex flex-wrap gap-2 mt-2">
                <a
                  href={heroSection.resume_it}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-sm bg-white dark:bg-darkestgray text-darktext dark:text-lighttext rounded-lg hover:bg-gray-100 dark:hover:bg-darkgray transition-colors inline-flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('contacts.openResume')}
                </a>
              </div>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium text-darktext dark:text-lighttext mb-2">{t('hero.uploadResumeEnglish')}</h3>
            <FileDropzone
              previewUrl={resumeEnUpload.previewUrl}
              isDragging={resumeEnUpload.isDragging}
              isProcessing={resumeEnUpload.isProcessing}
              error={resumeEnUpload.error}
              currentUrl={heroSection?.resume_en ?? undefined}
              dropzoneProps={{
                onDragOver: resumeEnUpload.dropzoneProps.onDragOver,
                onDragLeave: resumeEnUpload.dropzoneProps.onDragLeave,
                onDrop: resumeEnUpload.dropzoneProps.onDrop,
              }}
              fileInputProps={{
                ...resumeEnUpload.fileInputProps,
                accept: '.pdf',
              }}
              fileInputRef={resumeEnUpload.fileInputRef}
              onClear={resumeEnUpload.clearFile}
              onBrowse={resumeEnUpload.openFileDialog}
              compact
            />
            {heroSection?.resume_en && !resumeEnUpload.file && (
              <div className="flex flex-wrap gap-2 mt-2">
                <a
                  href={heroSection.resume_en}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-sm bg-white dark:bg-darkestgray text-darktext dark:text-lighttext rounded-lg hover:bg-gray-100 dark:hover:bg-darkgray transition-colors inline-flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('contacts.openResume')}
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog isOpen={showConfirmRevert} title={t('common.revertAll')} message={t('common.confirmRevertAll')} confirmLabel={t('common.revert')} confirmVariant="primary" onConfirm={handleRevert} onCancel={() => setShowConfirmRevert(false)} />
      <PreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} title={t('contacts.previewTitle')}><ContactsPreview contacts={contacts} /></PreviewModal>
    </div>
  );
}

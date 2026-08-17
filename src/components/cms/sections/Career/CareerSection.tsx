'use client';

import { Calendar, Globe, MapPin, Plus, X } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { careerActions } from '@/app/actions/cms/sections/careerActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { CareerPreview } from '@/components/common/cms/previews/CareerPreview';
import type { CareerEntry, RemoteType } from '@/types/fetchedData.types';

type FormMode = 'list' | 'create' | 'edit';
type EditableCareerEntry = CareerEntry & { _new?: boolean; logo_file?: File | null };

interface CareerFormData {
  title: string;
  company: string;
  website_url: string;
  location_en: string;
  location_it: string;
  remote: RemoteType;
  startDate: string;
  endDate: string;
  description_en: string;
  description_it: string;
  company_description_en: string;
  company_description_it: string;
  skills: string;
}

const emptyForm: CareerFormData = {
  title: '', company: '', website_url: '', location_en: '', location_it: '',
  remote: 'onSite', startDate: '', endDate: '', description_en: '', description_it: '',
  company_description_en: '', company_description_it: '', skills: '',
};

const remoteBadgeClass: Record<RemoteType, string> = {
  full: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  hybrid: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  onSite: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};

export default function CareerSection() {
  const t = useTranslations('cms');
  const [entries, setEntries] = useState<EditableCareerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_isUpdating, setIsUpdating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [mode, setMode] = useState<FormMode>('list');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<CareerFormData>(emptyForm);
  const [isCurrentPosition, setIsCurrentPosition] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');
  const [formLocale, setFormLocale] = useState<'en' | 'it'>('en');
  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newEntries, setNewEntries] = useState<Array<EditableCareerEntry & { imageFile: File | null }>>([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  const logoUpload = useFileUpload({ accept: 'image/*', maxSizeMB: 5, imageProcessing: { maxWidth: 256, maxHeight: 256, quality: 0.85 }, generateBlurhash: true });

  const { isDirty: transDirty, isLoading: transLoading, getField, setField, saveTranslations, revertTranslations } = useSectionTranslations('career-section');

  const isDirty = modifiedIds.size > 0 || newEntries.length > 0 || deletedIds.size > 0 || transDirty;
  useSectionDirty('career', isDirty);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const r = await careerActions({ type: 'GET' });
      if (!r.success) throw new Error(r.error || 'Failed to fetch');
      setEntries(r.data as CareerEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally { setIsLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openCreate = () => { setFormData(emptyForm); setIsCurrentPosition(false); logoUpload.clearFile(); setEditingId(null); setFormLocale(activeLocale); setMode('create'); };
  const openEdit = (entry: CareerEntry) => {
    setFormData({
      title: entry.title, company: entry.company, website_url: entry.website_url ?? '',
      location_en: entry.location_en ?? '', location_it: entry.location_it ?? '',
      remote: entry.remote, startDate: entry.startDate, endDate: entry.endDate ?? '',
      description_en: entry.description_en ?? '', description_it: entry.description_it ?? '',
      company_description_en: entry.company_description_en ?? '', company_description_it: entry.company_description_it ?? '',
      skills: entry.skills ?? '',
    });
    setIsCurrentPosition(!entry.endDate);
    setEditingId(entry.id);
    setFormLocale(activeLocale);
    setMode('edit');
    if (entry.logo) logoUpload.setFileFromUrl(entry.logo);
  };
  const closeForm = () => { setMode('list'); logoUpload.clearFile(); setEditingId(null); };

  const handleCreate = () => {
    if (!formData.title || !formData.company || !formData.startDate) { setError('Title, company, and start date are required'); return; }
    const tempId = -Date.now();
    const entry: EditableCareerEntry = {
      id: tempId, _new: true,
      title: formData.title, company: formData.company, website_url: formData.website_url,
      logo: '', blurhashURL: logoUpload.blurhash || '', logo_file: logoUpload.file, location_en: formData.location_en, location_it: formData.location_it,
      remote: formData.remote, startDate: formData.startDate, endDate: isCurrentPosition ? null : formData.endDate,
      description_en: formData.description_en, description_it: formData.description_it,
      skills: formData.skills, company_description_en: formData.company_description_en, company_description_it: formData.company_description_it,
      created_at: new Date().toISOString(),
    };
    setEntries((prev) => [...prev, entry]);
    setNewEntries((prev) => [...prev, { ...entry, imageFile: logoUpload.file }]);
    closeForm();
  };

  const handleUpdate = () => {
    if (!editingId || !formData.title) return;
    setEntries((prev) => prev.map((e) => e.id === editingId ? {
      ...e, title: formData.title, company: formData.company, website_url: formData.website_url,
      location_en: formData.location_en, location_it: formData.location_it, remote: formData.remote,
      startDate: formData.startDate, endDate: isCurrentPosition ? null : formData.endDate,
      description_en: formData.description_en, description_it: formData.description_it,
      skills: formData.skills, company_description_en: formData.company_description_en, company_description_it: formData.company_description_it,
      logo_file: logoUpload.file || e.logo_file || null,
      blurhashURL: logoUpload.blurhash || e.blurhashURL || '',
    } : e));
    setModifiedIds((prev) => new Set(prev).add(editingId));
    closeForm();
  };

  const handleDelete = (id: number) => {
    const isNew = newEntries.some((n) => n.id === id);
    if (isNew) { setNewEntries((prev) => prev.filter((n) => n.id !== id)); }
    else { setDeletedIds((prev) => new Set(prev).add(id)); }
    setModifiedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    setIsUpdating(true); setError(null);

    const batch = await careerActions({
      type: 'BATCH_PUBLISH',
      creates: newEntries.map((entry) => ({
        file: entry.imageFile,
        blurhashURL: entry.blurhashURL || undefined,
        data: {
          title: entry.title,
          company: entry.company,
          website_url: entry.website_url || '',
          logo: entry.logo || '',
          blurhashURL: entry.blurhashURL || '',
          location_en: entry.location_en || '',
          location_it: entry.location_it || '',
          remote: entry.remote,
          startDate: entry.startDate,
          endDate: entry.endDate,
          description_en: entry.description_en || '',
          description_it: entry.description_it || '',
          skills: entry.skills || '',
          company_description_en: entry.company_description_en || '',
          company_description_it: entry.company_description_it || '',
        },
      })),
      updates: Array.from(modifiedIds).flatMap((id) => {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return [];
        return [{
          id,
          file: entry.logo_file || null,
          currentLogoUrl: entry.logo,
          blurhashURL: entry.blurhashURL || undefined,
          data: {
            title: entry.title,
            company: entry.company,
            website_url: entry.website_url || '',
            logo: entry.logo || '',
            blurhashURL: entry.blurhashURL || '',
            location_en: entry.location_en || '',
            location_it: entry.location_it || '',
            remote: entry.remote,
            startDate: entry.startDate,
            endDate: entry.endDate,
            description_en: entry.description_en || '',
            description_it: entry.description_it || '',
            skills: entry.skills || '',
            company_description_en: entry.company_description_en || '',
            company_description_it: entry.company_description_it || '',
          },
        }];
      }),
      deletes: Array.from(deletedIds),
    });
    if (!batch.success && batch.error) errors.push(batch.error);

    if (transDirty) { const tErrs = await saveTranslations(); errors.push(...tErrs); }
    await fetchData();
    setModifiedIds(new Set()); setNewEntries([]); setDeletedIds(new Set()); setIsUpdating(false);
    if (errors.length > 0) setError(errors.join('\n'));
  }, [
    entries,
    newEntries,
    deletedIds,
    modifiedIds,
    transDirty,
    saveTranslations,
    fetchData,
  ]);

  const handleRevert = () => { setShowConfirmRevert(false); fetchData(); setModifiedIds(new Set()); setNewEntries([]); setDeletedIds(new Set()); revertTranslations(); setError(null); };

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const inputClass = 'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none text-sm';

  if (isLoading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" /></div>;

  if (mode === 'create' || mode === 'edit') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-darktext dark:text-lighttext">{mode === 'create' ? t('career.createNewEntry') : t('career.editEntry')}</h2>
          <div className="flex items-center gap-3">
            <LocaleToggle activeLocale={formLocale} onChange={setFormLocale} />
            <button type="button" onClick={closeForm} className="flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-darkergray rounded-lg hover:bg-gray-300 text-darktext dark:text-lighttext"><X className="w-4 h-4" />{t('common.cancel')}</button>
          </div>
        </div>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        {/* Role & Company */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('career.jobTitleLabel')} & {t('career.companyLabel')}</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('career.jobTitleLabel')} <span className="text-red-500">*</span></label>
              <input type="text" value={formData.title} onChange={(e) => setFormData((p) => ({ ...p, title: e.target.value }))} className={inputClass} placeholder={t('career.jobTitlePlaceholder')} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('career.companyLabel')} <span className="text-red-500">*</span></label>
              <input type="text" value={formData.company} onChange={(e) => setFormData((p) => ({ ...p, company: e.target.value }))} className={inputClass} placeholder={t('career.companyPlaceholder')} required />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('career.websiteUrlLabel')}</label>
            <input type="url" value={formData.website_url} onChange={(e) => setFormData((p) => ({ ...p, website_url: e.target.value }))} className={inputClass} placeholder={t('career.websiteUrlPlaceholder')} />
          </div>
          <FileDropzone
            label={t('career.selectLogo')}
            previewUrl={logoUpload.previewUrl}
            blurhash={logoUpload.blurhash}
            isDragging={logoUpload.isDragging}
            isProcessing={logoUpload.isProcessing}
            error={logoUpload.error}
            dropzoneProps={{ onDragOver: logoUpload.dropzoneProps.onDragOver, onDragLeave: logoUpload.dropzoneProps.onDragLeave, onDrop: logoUpload.dropzoneProps.onDrop }}
            fileInputProps={logoUpload.fileInputProps}
            fileInputRef={logoUpload.fileInputRef}
            onClear={logoUpload.clearFile}
            onBrowse={logoUpload.openFileDialog}
            compact
          />
        </div>

        {/* Time & Location */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('career.startDateLabel')} & {t('career.locationEnLabel')}</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('career.startDateLabel')} <span className="text-red-500">*</span></label>
              <input type="date" value={formData.startDate} onChange={(e) => setFormData((p) => ({ ...p, startDate: e.target.value }))} className={inputClass} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('career.endDateLabel')}</label>
              <input type="date" value={formData.endDate} onChange={(e) => setFormData((p) => ({ ...p, endDate: e.target.value }))} className={inputClass} disabled={isCurrentPosition} />
              <label className="flex items-center gap-2 mt-2 text-sm text-gray-500 dark:text-lighttext2">
                <input type="checkbox" checked={isCurrentPosition} onChange={(e) => { setIsCurrentPosition(e.target.checked); if (e.target.checked) setFormData((p) => ({ ...p, endDate: '' })); }} className="rounded" />
                {t('career.presentLabel')}
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">{t('career.remoteTypeLabel')}</label>
            <select value={formData.remote} onChange={(e) => setFormData((p) => ({ ...p, remote: e.target.value as RemoteType }))} className={inputClass}>
              <option value="full">{t('career.remoteFullOption')}</option>
              <option value="hybrid">{t('career.remoteHybridOption')}</option>
              <option value="onSite">{t('career.remoteOnSiteOption')}</option>
            </select>
          </div>
          <TranslationField label={t('career.locationEnLabel')} enValue={formData.location_en} itValue={formData.location_it} onChangeEn={(v) => setFormData((p) => ({ ...p, location_en: v }))} onChangeIt={(v) => setFormData((p) => ({ ...p, location_it: v }))} activeLocale={formLocale} />
        </div>

        {/* Content */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">{t('career.descriptionEnLabel')}</h3>
          <TranslationField label={t('career.descriptionEnLabel')} enValue={formData.description_en} itValue={formData.description_it} onChangeEn={(v) => setFormData((p) => ({ ...p, description_en: v }))} onChangeIt={(v) => setFormData((p) => ({ ...p, description_it: v }))} type="textarea" rows={4} activeLocale={formLocale} />
          <TranslationField label={t('career.companyDescEnLabel')} enValue={formData.company_description_en} itValue={formData.company_description_it} onChangeEn={(v) => setFormData((p) => ({ ...p, company_description_en: v }))} onChangeIt={(v) => setFormData((p) => ({ ...p, company_description_it: v }))} type="textarea" rows={3} activeLocale={formLocale} />
        </div>

        {/* Details */}
        <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 space-y-4">
          <h3 className="text-lg font-bold text-main">Skills</h3>
          <div>
            <label className="block text-sm font-medium text-darktext dark:text-lighttext mb-1">Skills</label>
            <input type="text" value={formData.skills} onChange={(e) => setFormData((p) => ({ ...p, skills: e.target.value }))} className={inputClass} placeholder={t('career.skillsPlaceholder')} />
            <p className="text-xs text-gray-500 dark:text-lighttext2 mt-1">Comma-separated list of skills</p>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={closeForm} className="px-4 py-2 min-h-[44px] bg-gray-600 hover:bg-gray-700 text-white rounded-lg">{t('common.cancel')}</button>
          <button type="button" onClick={mode === 'create' ? handleCreate : handleUpdate} className="px-4 py-2 min-h-[44px] bg-main hover:bg-secondary text-white rounded-lg">{mode === 'create' ? t('common.add') : t('common.done')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader title={t('career.title')} description={t('career.subtitle')} />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Translations */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-main">{t('common.translations')}</h2>
          <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
        </div>
        {transLoading ? <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-main" /></div> : (
          <div className="space-y-4">
            <TranslationField label={t('career.translationTitleLabel')} enValue={getField('en', 'title')} itValue={getField('it', 'title')} onChangeEn={(v) => setField('en', 'title', v)} onChangeIt={(v) => setField('it', 'title', v)} activeLocale={activeLocale} />
            <TranslationField label={t('career.translationSubtitleLabel')} enValue={getField('en', 'subtitle')} itValue={getField('it', 'subtitle')} onChangeEn={(v) => setField('en', 'subtitle', v)} onChangeIt={(v) => setField('it', 'subtitle', v)} type="textarea" rows={3} activeLocale={activeLocale} />
          </div>
        )}
      </div>

      {/* Entries */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-darktext dark:text-lighttext">{t('career.careerEntriesTitle')}</h2>
        <button type="button" onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-main hover:bg-secondary text-white rounded-lg"><Plus className="w-4 h-4" />{t('career.addCareerEntry')}</button>
      </div>

      {entries.length === 0 ? (
        <EmptyState message={t('career.noCareerEntries')} />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6 flex items-start gap-4">
              {entry.logo ? (
                <Image src={entry.logo} width={48} height={48} className="rounded-lg flex-shrink-0" alt={entry.company}
                  placeholder={entry.blurhashURL ? 'blur' : 'empty'} blurDataURL={entry.blurhashURL ?? undefined} />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-gray-200 dark:bg-darkgray flex-shrink-0 flex items-center justify-center text-gray-400"><Globe className="w-5 h-5" /></div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-darktext dark:text-lighttext">{entry.title}</h3>
                  <span className="text-gray-400 dark:text-lighttext2">·</span>
                  <span className="font-medium text-darktext dark:text-lighttext">{entry.company}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${remoteBadgeClass[entry.remote]}`}>
                    {entry.remote === 'full' ? t('career.remoteFullOption') : entry.remote === 'hybrid' ? t('career.remoteHybridOption') : t('career.remoteOnSiteOption')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-lighttext2 mt-1">
                  <span><Calendar className="w-3 h-3 inline mr-1" />{new Date(entry.startDate).toLocaleDateString()} – {entry.endDate ? new Date(entry.endDate).toLocaleDateString() : t('career.presentLabel')}</span>
                  <span><MapPin className="w-3 h-3 inline mr-1" />{entry.location_en}</span>
                </div>
              </div>
              <CardToolbar onEdit={() => openEdit(entry)} onDelete={() => handleDelete(entry.id)} />
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog isOpen={showConfirmRevert} title={t('common.revertAll')} message={t('common.confirmRevertAll')} confirmLabel={t('common.revert')} confirmVariant="primary" onConfirm={handleRevert} onCancel={() => setShowConfirmRevert(false)} />
      <PreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} title={t('career.previewTitle')}><CareerPreview entries={entries} /></PreviewModal>
    </div>
  );
}

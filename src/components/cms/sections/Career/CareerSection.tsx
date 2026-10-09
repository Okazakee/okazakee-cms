'use client';

import { Calendar, Globe, MapPin, Plus } from 'lucide-react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { careerActions } from '@/app/actions/cms/sections/careerActions';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { Dropdown } from '@/components/cms/shared/Dropdown';
import {
  EditorGroup,
  EditorToolbar,
  editorInputClass,
  editorLabelClass,
  editorPrimaryButtonClass,
  editorRowClass,
  editorSecondaryButtonClass,
} from '@/components/cms/shared/EditorBody';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { FileDropzone } from '@/components/cms/shared/FileDropzone';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import {
  mergeServerWithDrafts,
  readBatchEvidence,
  reconcileDrafts,
} from '@/hooks/cms/batchDrafts';
import { useFileUpload } from '@/hooks/cms/useFileUpload';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { demoCareer } from '@/libs/demo/fixtures';
import { useCmsStore } from '@/store/cmsStore';
import type { CareerEntry, RemoteType } from '@/types/fetchedData.types';

type FormMode = 'list' | 'create' | 'edit';
type EditableCareerEntry = CareerEntry & {
  _new?: boolean;
  logo_file?: File | null;
};

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
  skills: string;
}

const emptyForm: CareerFormData = {
  title: '',
  company: '',
  website_url: '',
  location_en: '',
  location_it: '',
  remote: 'onSite',
  startDate: '',
  endDate: '',
  description_en: '',
  description_it: '',
  skills: '',
};

const remoteBadgeClass: Record<RemoteType, string> = {
  full: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  hybrid:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  onSite: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};

export default function CareerSection() {
  const t = useTranslations('cms');
  const [entries, setEntries] = useState<EditableCareerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [mode, setMode] = useState<FormMode>('list');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<CareerFormData>(emptyForm);
  const [isCurrentPosition, setIsCurrentPosition] = useState(false);
  const activeLocale = useLocale() === 'it' ? 'it' : 'en';
  const [formLocale, setFormLocale] = useState<'en' | 'it'>('en');
  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newEntries, setNewEntries] = useState<
    Array<EditableCareerEntry & { imageFile: File | null }>
  >([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  const logoUpload = useFileUpload({
    accept: 'image/*',
    maxSizeMB: 5,
    imageProcessing: { maxWidth: 256, maxHeight: 256, quality: 0.85 },
    generateBlurhash: true,
  });

  const isDirty =
    modifiedIds.size > 0 || newEntries.length > 0 || deletedIds.size > 0;
  useSectionDirty('career', isDirty);

  const beginLoad = useLatestRequest();
  const fetchData = useCallback(
    async (drafts?: {
      creates: EditableCareerEntry[];
      modified: ReadonlyMap<number, EditableCareerEntry>;
      deletedIds: ReadonlySet<number>;
    }) => {
      const current = beginLoad();
      setIsLoading(true);
      // Offline showcase: fixture entries, no server round-trip.
      if (useCmsStore.getState().demoMode) {
        if (!current()) return;
        setEntries(JSON.parse(JSON.stringify(demoCareer)));
        setError(null);
        setIsLoading(false);
        return;
      }
      try {
        const r = await careerActions({ type: 'GET' });
        if (!current()) return;
        if (!r.success) throw new Error(r.error || 'Failed to fetch');
        const server = r.data as CareerEntry[];
        setEntries(drafts ? mergeServerWithDrafts(server, drafts) : server);
      } catch (err) {
        if (current())
          setError(err instanceof Error ? err.message : 'Failed to fetch');
      } finally {
        if (current()) setIsLoading(false);
      }
    },
    [beginLoad]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreate = () => {
    setFormData(emptyForm);
    setIsCurrentPosition(false);
    logoUpload.clearFile();
    setEditingId(null);
    setFormLocale(activeLocale);
    setMode('create');
  };
  const openEdit = (entry: CareerEntry) => {
    setFormData({
      title: entry.title,
      company: entry.company,
      website_url: entry.website_url ?? '',
      location_en: entry.location_en ?? '',
      location_it: entry.location_it ?? '',
      remote: entry.remote,
      startDate: entry.startDate,
      endDate: entry.endDate ?? '',
      description_en: entry.description_en ?? '',
      description_it: entry.description_it ?? '',
      skills: entry.skills ?? '',
    });
    setIsCurrentPosition(!entry.endDate);
    setEditingId(entry.id);
    setFormLocale(activeLocale);
    setMode('edit');
    if (entry.logo) logoUpload.setFileFromUrl(entry.logo);
  };
  const closeForm = () => {
    setMode('list');
    logoUpload.clearFile();
    setEditingId(null);
  };

  const handleCreate = () => {
    if (!formData.title || !formData.company || !formData.startDate) {
      setError('Title, company, and start date are required');
      return;
    }
    const tempId = -Date.now();
    const entry: EditableCareerEntry = {
      id: tempId,
      _new: true,
      title: formData.title,
      company: formData.company,
      website_url: formData.website_url,
      logo: '',
      blurhashURL: logoUpload.blurhash || '',
      logo_file: logoUpload.file,
      location_en: formData.location_en,
      location_it: formData.location_it,
      remote: formData.remote,
      startDate: formData.startDate,
      endDate: isCurrentPosition ? null : formData.endDate,
      description_en: formData.description_en,
      description_it: formData.description_it,
      skills: formData.skills,
      created_at: new Date().toISOString(),
    };
    setEntries((prev) => [...prev, entry]);
    setNewEntries((prev) => [
      ...prev,
      { ...entry, imageFile: logoUpload.file },
    ]);
    closeForm();
  };

  const handleUpdate = () => {
    if (!editingId || !formData.title) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.id === editingId
          ? {
              ...e,
              title: formData.title,
              company: formData.company,
              website_url: formData.website_url,
              location_en: formData.location_en,
              location_it: formData.location_it,
              remote: formData.remote,
              startDate: formData.startDate,
              endDate: isCurrentPosition ? null : formData.endDate,
              description_en: formData.description_en,
              description_it: formData.description_it,
              skills: formData.skills,
              logo_file: logoUpload.file || e.logo_file || null,
              blurhashURL: logoUpload.blurhash || e.blurhashURL || '',
            }
          : e
      )
    );
    setModifiedIds((prev) => new Set(prev).add(editingId));
    closeForm();
  };

  const handleDelete = (id: number) => {
    const isNew = newEntries.some((n) => n.id === id);
    if (isNew) {
      setNewEntries((prev) => prev.filter((n) => n.id !== id));
    } else {
      setDeletedIds((prev) => new Set(prev).add(id));
    }
    setModifiedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    setIsUpdating(true);
    setError(null);

    // Offline showcase: remap temp ids, materialize staged logos as object
    // URLs, drop deletes, and clear every draft set.
    if (useCmsStore.getState().demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      let nextFakeId =
        Math.max(0, ...entries.map((e) => e.id)) + 1;
      const next = entries
        .filter((e) => !deletedIds.has(e.id))
        .map((e) => ({
          ...e,
          id: e.id < 0 ? nextFakeId++ : e.id,
          logo: e.logo_file ? URL.createObjectURL(e.logo_file) : e.logo,
          logo_file: null,
        }));
      setEntries(next);
      setModifiedIds(new Set());
      setNewEntries([]);
      setDeletedIds(new Set());
      setIsUpdating(false);
      return;
    }

    // Pending creates may have been edited after creation: always derive the
    // payload from the latest `entries` entry, never the stale newEntries copy.
    const createTempIds = newEntries.map((entry) => String(entry.id));
    const creates = newEntries.flatMap((item) => {
      const entry = entries.find((e) => e.id === item.id) ?? item;
      const file = entry.logo_file ?? item.imageFile;
      return [
        {
          tempId: String(item.id),
          file,
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
          },
        },
      ];
    });
    // Negative ids are pending creates, not updates.
    const updateIds = Array.from(modifiedIds).filter((id) => id > 0);
    const updates = updateIds.flatMap((id) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return [];
      return [
        {
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
          },
        },
      ];
    });
    const deleteIds = Array.from(deletedIds);

    try {
      let retainedCreates = createTempIds;
      let retainedUpdates = updateIds;
      let retainedDeletes = deleteIds;

      const batch = await careerActions({
        type: 'BATCH_PUBLISH',
        creates,
        updates,
        deletes: deleteIds,
      });

      const evidence = readBatchEvidence(batch.data);
      if (!batch.success) {
        errors.push(batch.error || 'Failed to publish');
      }
      if (!evidence) {
        errors.push('Publish response was incomplete; drafts were kept');
      } else {
        const reconcile = reconcileDrafts({
          evidence,
          createTempIds,
          updateIds,
          deleteIds,
        });
        retainedCreates = reconcile.retainedCreates;
        retainedUpdates = reconcile.retainedUpdates as number[];
        retainedDeletes = reconcile.retainedDeletes as number[];
        errors.push(...reconcile.failureMessages);

        const retainedCreateSet = new Set(retainedCreates);
        const retainedModifiedSet = new Set(retainedUpdates);
        const draftCreates = entries.filter((e) =>
          retainedCreateSet.has(String(e.id))
        );
        const draftModified = new Map(
          entries
            .filter((e) => retainedModifiedSet.has(e.id))
            .map((e) => [e.id, e])
        );
        await fetchData({
          creates: draftCreates,
          modified: draftModified,
          deletedIds: new Set(retainedDeletes),
        });

        setNewEntries((prev) =>
          prev.filter((entry) => retainedCreateSet.has(String(entry.id)))
        );
        setModifiedIds(new Set(retainedUpdates));
        setDeletedIds(new Set(retainedDeletes));
      }

      const revalidationMessage = revalidationWarning(batch);
      if (revalidationMessage)
        useCmsStore.getState().setWarning(revalidationMessage);

      const remaining =
        retainedCreates.length +
        retainedUpdates.length +
        retainedDeletes.length;
      if (!batch.success || remaining > 0 || errors.length > 0) {
        const message = errors.join('\n') || 'Publish did not fully succeed';
        setError(message);
        useCmsStore.getState().setError(message);
      } else {
        useCmsStore.getState().setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to publish';
      setError(message);
      useCmsStore.getState().setError(message);
    } finally {
      setIsUpdating(false);
    }
  }, [entries, newEntries, deletedIds, modifiedIds, fetchData]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    // Offline showcase: restore the fixture snapshot locally.
    if (useCmsStore.getState().demoMode) {
      setEntries(JSON.parse(JSON.stringify(demoCareer)));
    } else {
      fetchData();
    }
    setModifiedIds(new Set());
    setNewEntries([]);
    setDeletedIds(new Set());
    setError(null);
  };

  useSectionCallbacks('career', handlePublish, handleRevert);

  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );

  if (mode === 'create' || mode === 'edit') {
    return (
      <div className="space-y-6">
        <EditorToolbar
          title={
            mode === 'create'
              ? t('career.createNewEntry')
              : t('career.editEntry')
          }
          actions={
            <LocaleToggle activeLocale={formLocale} onChange={setFormLocale} />
          }
        />
        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        <EditorGroup title={t('editor.groups.company')}>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="career-title" className={editorLabelClass}>
                {t('career.jobTitleLabel')}{' '}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="career-title"
                type="text"
                value={formData.title}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, title: e.target.value }))
                }
                className={editorInputClass}
                placeholder={t('career.jobTitlePlaceholder')}
                required
              />
            </div>
            <div>
              <label htmlFor="career-company" className={editorLabelClass}>
                {t('career.companyLabel')}{' '}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="career-company"
                type="text"
                value={formData.company}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, company: e.target.value }))
                }
                className={editorInputClass}
                placeholder={t('career.companyPlaceholder')}
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="career-website" className={editorLabelClass}>
              {t('career.websiteUrlLabel')}
            </label>
            <input
              id="career-website"
              type="url"
              value={formData.website_url}
              onChange={(e) =>
                setFormData((p) => ({ ...p, website_url: e.target.value }))
              }
              className={editorInputClass}
              placeholder={t('career.websiteUrlPlaceholder')}
            />
          </div>
        </EditorGroup>

        <EditorGroup title={t('editor.groups.datesLocation')}>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="career-start" className={editorLabelClass}>
                {t('career.startDateLabel')}{' '}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="career-start"
                type="date"
                value={formData.startDate}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, startDate: e.target.value }))
                }
                className={editorInputClass}
                required
              />
            </div>
            <div>
              <label htmlFor="career-end" className={editorLabelClass}>
                {t('career.endDateLabel')}
              </label>
              <input
                id="career-end"
                type="date"
                value={formData.endDate}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, endDate: e.target.value }))
                }
                className={editorInputClass}
                disabled={isCurrentPosition}
              />
              <label className="flex items-center gap-2 mt-2 text-sm text-text-muted ">
                <input
                  type="checkbox"
                  checked={isCurrentPosition}
                  onChange={(e) => {
                    setIsCurrentPosition(e.target.checked);
                    if (e.target.checked)
                      setFormData((p) => ({ ...p, endDate: '' }));
                  }}
                  className="rounded"
                />
                {t('career.presentLabel')}
              </label>
            </div>
          </div>
          <div>
            <label htmlFor="career-remote" className={editorLabelClass}>
              {t('career.remoteTypeLabel')}
            </label>
            <Dropdown
              id="career-remote"
              value={formData.remote}
              onChange={(value) =>
                setFormData((p) => ({ ...p, remote: value as RemoteType }))
              }
              triggerClassName={editorInputClass}
              options={[
                { value: 'full', label: t('career.remoteFullOption') },
                { value: 'hybrid', label: t('career.remoteHybridOption') },
                { value: 'onSite', label: t('career.remoteOnSiteOption') },
              ]}
            />
          </div>
          <TranslationField
            label={t('editor.fields.location')}
            enValue={formData.location_en}
            itValue={formData.location_it}
            onChangeEn={(v) => setFormData((p) => ({ ...p, location_en: v }))}
            onChangeIt={(v) => setFormData((p) => ({ ...p, location_it: v }))}
            activeLocale={formLocale}
          />
        </EditorGroup>

        <EditorGroup title={t('editor.groups.details')}>
          <TranslationField
            label={t('editor.fields.description')}
            enValue={formData.description_en}
            itValue={formData.description_it}
            onChangeEn={(v) =>
              setFormData((p) => ({ ...p, description_en: v }))
            }
            onChangeIt={(v) =>
              setFormData((p) => ({ ...p, description_it: v }))
            }
            type="textarea"
            rows={4}
            activeLocale={formLocale}
          />
          <div>
            <label htmlFor="career-skills" className={editorLabelClass}>
              {t('career.skillsLabel')}
            </label>
            <input
              id="career-skills"
              type="text"
              value={formData.skills}
              onChange={(e) =>
                setFormData((p) => ({ ...p, skills: e.target.value }))
              }
              className={editorInputClass}
              placeholder={t('career.skillsPlaceholder')}
            />
            <p className="text-xs text-text-muted mt-1">
              {t('career.skillsHint')}
            </p>
          </div>
        </EditorGroup>

        <EditorGroup title={t('career.logoGroupTitle')}>
          <FileDropzone
            label={t('career.selectLogo')}
            previewUrl={logoUpload.previewUrl}
            blurhash={logoUpload.blurhash}
            isDragging={logoUpload.isDragging}
            isProcessing={logoUpload.isProcessing}
            hasPendingFile={Boolean(logoUpload.file)}
            error={logoUpload.error}
            dropzoneProps={{
              onDragOver: logoUpload.dropzoneProps.onDragOver,
              onDragLeave: logoUpload.dropzoneProps.onDragLeave,
              onDrop: logoUpload.dropzoneProps.onDrop,
            }}
            fileInputProps={logoUpload.fileInputProps}
            fileInputRef={logoUpload.fileInputRef}
            onClear={logoUpload.clearFile}
            onBrowse={logoUpload.openFileDialog}
            compact
          />
        </EditorGroup>

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={closeForm}
            className={editorSecondaryButtonClass}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={mode === 'create' ? handleCreate : handleUpdate}
            className={editorPrimaryButtonClass}
          >
            {mode === 'create' ? t('editor.addDraft') : t('editor.applyDraft')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <fieldset
      disabled={isUpdating}
      className="space-y-6 md:space-y-8 border-0 p-0 m-0 min-w-0"
    >
      <SectionHeader
        title={t('career.title')}
        description={t('career.subtitle')}
        actions={
          <SectionActions
            isDirty={isDirty}
            busy={isUpdating}
            onPublish={handlePublish}
            onRevert={() => setShowConfirmRevert(true)}
          />
        }
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Entries */}
      <EditorToolbar
        title={t('career.careerEntriesTitle')}
        count={entries.length}
        actions={
          <button
            type="button"
            onClick={openCreate}
            className={editorPrimaryButtonClass}
          >
            <Plus className="w-4 h-4" />
            {t('career.addCareerEntry')}
          </button>
        }
      />

      {entries.length === 0 ? (
        <EmptyState message={t('career.noCareerEntries')} />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`${editorRowClass} flex items-start gap-4`}
            >
              {entry.logo ? (
                <Image
                  src={entry.logo}
                  width={48}
                  height={48}
                  className="rounded-lg flex-shrink-0"
                  alt={entry.company}
                  placeholder={entry.blurhashURL ? 'blur' : 'empty'}
                  blurDataURL={entry.blurhashURL ?? undefined}
                />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-surface-raised flex-shrink-0 flex items-center justify-center text-text-dim">
                  <Globe className="w-5 h-5" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-text-main ">
                    {entry.title}
                  </h3>
                  <span className="text-text-dim ">·</span>
                  <span className="font-medium text-text-main ">
                    {entry.company}
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${remoteBadgeClass[entry.remote]}`}
                  >
                    {entry.remote === 'full'
                      ? t('career.remoteFullOption')
                      : entry.remote === 'hybrid'
                        ? t('career.remoteHybridOption')
                        : t('career.remoteOnSiteOption')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted mt-1">
                  <span>
                    <Calendar className="w-3 h-3 inline mr-1" />
                    {new Date(entry.startDate).toLocaleDateString()} –{' '}
                    {entry.endDate
                      ? new Date(entry.endDate).toLocaleDateString()
                      : t('career.presentLabel')}
                  </span>
                  <span>
                    <MapPin className="w-3 h-3 inline mr-1" />
                    {activeLocale === 'it'
                      ? entry.location_it || entry.location_en
                      : entry.location_en}
                  </span>
                </div>
              </div>
              <CardToolbar
                onEdit={() => openEdit(entry)}
                onDelete={() => handleDelete(entry.id)}
              />
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={showConfirmRevert}
        title={t('common.revertAll')}
        message={t('common.confirmRevertAll')}
        confirmLabel={t('common.revert')}
        confirmVariant="primary"
        onConfirm={handleRevert}
        onCancel={() => setShowConfirmRevert(false)}
      />
    </fieldset>
  );
}

'use client';

import { Plus, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { contactsActions } from '@/app/actions/cms/sections/contactsActions';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import {
  mergeServerWithDrafts,
  readBatchEvidence,
  reconcileDrafts,
} from '@/hooks/cms/batchDrafts';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
import type { Contact } from '@/types/fetchedData.types';
import { isValidHttpUrl } from '@/utils/cms/validation';

export default function ContactsSection() {
  const t = useTranslations('cms');

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);

  const [modifiedIds, setModifiedIds] = useState<Set<number>>(new Set());
  const [newContacts, setNewContacts] = useState<Contact[]>([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [orderChanged, setOrderChanged] = useState(false);

  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState({
    label: '',
    icon: '',
    link: '',
    bg_color: '#000000',
  });

  const isDirty =
    modifiedIds.size > 0 ||
    newContacts.length > 0 ||
    deletedIds.size > 0 ||
    orderChanged;
  useSectionDirty('contacts', isDirty);

  const beginLoad = useLatestRequest();
  const fetchData = useCallback(
    async (drafts?: {
      creates: Contact[];
      modified: ReadonlyMap<number, Contact>;
      deletedIds: ReadonlySet<number>;
    }) => {
      const current = beginLoad();
      setIsLoading(true);
      try {
        const r = await contactsActions({ type: 'GET' });
        if (!current()) return;
        if (!r.success) throw new Error(r.error || 'Failed');
        const server = r.data as Contact[];
        const merged = drafts ? mergeServerWithDrafts(server, drafts) : server;
        setContacts(
          merged.sort(
            (a, b) =>
              (a.position ?? Number.MAX_SAFE_INTEGER) -
                (b.position ?? Number.MAX_SAFE_INTEGER) || a.id - b.id
          )
        );
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

  const handleAdd = () => {
    if (!newForm.label || !newForm.icon || !newForm.link) {
      setError('Label, icon, and link are required');
      return;
    }
    const temp: Contact = {
      id: -Date.now(),
      position: contacts.length,
      ...newForm,
    };
    setContacts((prev) => [...prev, temp]);
    setNewContacts((prev) => [...prev, temp]);
    setNewForm({ label: '', icon: '', link: '', bg_color: '#000000' });
    setIsAdding(false);
  };

  const handleChange = (
    id: number,
    field: keyof Contact,
    value: string | number
  ) => {
    setContacts((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    );
    setModifiedIds((prev) => new Set(prev).add(id));
  };

  const handleDelete = (id: number) => {
    const isNew = newContacts.some((n) => n.id === id);
    if (isNew) {
      setNewContacts((prev) => prev.filter((n) => n.id !== id));
    } else {
      setDeletedIds((prev) => new Set(prev).add(id));
    }
    // A deleted row must not survive as a pending modification.
    setModifiedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setOrderChanged(true);
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
    setIsUpdating(true);
    setError(null);

    // Absolute positions from the current full-list order, so newly added
    // contacts interleave correctly instead of being re-indexed from zero.
    const positions = new Map(contacts.map((c, i) => [c.id, i]));

    try {
      // Pending creates always use the latest edited contact, never the stale
      // newContacts snapshot.
      const createTempIds = newContacts.map((c) => String(c.id));
      const creates = newContacts.flatMap((item) => {
        const c = contacts.find((entry) => entry.id === item.id) ?? item;
        return [
          {
            tempId: String(item.id),
            label: c.label,
            icon: c.icon,
            link: c.link,
            bg_color: c.bg_color,
            position: positions.get(item.id) ?? c.position ?? 0,
          },
        ];
      });
      const updateIds = Array.from(modifiedIds).filter((id) => id > 0);
      const updates = updateIds.flatMap((id) => {
        const c = contacts.find((entry) => entry.id === id);
        if (!c) return [];
        return [
          {
            id,
            data: {
              label: c.label,
              icon: c.icon,
              link: c.link,
              bg_color: c.bg_color,
              position: positions.get(id) ?? c.position,
            },
          },
        ];
      });
      const deleteIds = Array.from(deletedIds);
      const reorderIds = orderChanged
        ? contacts
            .filter((c) => c.id > 0)
            .map((c) => ({ id: c.id, position: positions.get(c.id) ?? 0 }))
        : [];

      let retainedCreates = createTempIds;
      let retainedUpdates = updateIds;
      let retainedDeletes = deleteIds;
      let retainedOrder = orderChanged;

      const batch = await contactsActions({
        type: 'BATCH_PUBLISH',
        creates,
        updates,
        deletes: deleteIds,
        reorder: reorderIds,
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

        // Keep the reorder flag until every sent position committed.
        const reordered = new Set(evidence.reordered.map(String));
        retainedOrder =
          reorderIds.some((item) => !reordered.has(String(item.id))) ||
          retainedCreates.length > 0 ||
          retainedDeletes.length > 0 ||
          evidence.failed.some((failure) => failure.kind === 'reorder');

        const retainedCreateSet = new Set(retainedCreates);
        const retainedModifiedSet = new Set(retainedUpdates.map(String));
        const draftCreates = contacts.filter((c) =>
          retainedCreateSet.has(String(c.id))
        );
        const draftModified = new Map(
          contacts
            .filter(
              (c) => retainedModifiedSet.has(String(c.id)) || retainedOrder
            )
            .map((c): [number, Contact] => {
              const id = Number(evidence.createdIds[String(c.id)] ?? c.id);
              return [id, { ...c, id, position: positions.get(c.id) ?? 0 }];
            })
        );
        await fetchData({
          creates: draftCreates,
          modified: draftModified,
          deletedIds: new Set(retainedDeletes),
        });

        setNewContacts((prev) =>
          prev.filter((c) => retainedCreateSet.has(String(c.id)))
        );
        setModifiedIds(new Set(retainedUpdates));
        setDeletedIds(new Set(retainedDeletes));
        setOrderChanged(retainedOrder);
      }

      const batchWarning = revalidationWarning(batch);
      if (batchWarning) useCmsStore.getState().setWarning(batchWarning);

      const remaining =
        retainedCreates.length +
        retainedUpdates.length +
        retainedDeletes.length +
        (retainedOrder ? 1 : 0);
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
  }, [
    contacts,
    newContacts,
    deletedIds,
    modifiedIds,
    orderChanged,
    fetchData,
    t,
  ]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    fetchData();
    setModifiedIds(new Set());
    setNewContacts([]);
    setDeletedIds(new Set());
    setOrderChanged(false);
    setError(null);
  };

  useSectionCallbacks('contacts', handlePublish, handleRevert);

  const inputClass =
    'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-text-main focus:border-accent-violet focus:outline-none text-sm';

  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );

  return (
    <fieldset
      disabled={isUpdating}
      className="space-y-6 md:space-y-8 border-0 p-0 m-0 min-w-0"
    >
      <SectionHeader
        title={t('contacts.title')}
        description={t('contacts.subtitle')}
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

      {/* Contact Links */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-main ">
          {t('contacts.title')}
        </h2>
        {!isAdding && (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-2 px-4 py-2 bg-accent-violet-deep hover:bg-accent-violet text-white rounded-lg"
          >
            <Plus className="w-4 h-4" />
            {t('contacts.addNewContact')}
          </button>
        )}
      </div>

      {isAdding && (
        <div className="bg-surface-card rounded-xl p-4 md:p-6 space-y-3">
          <div>
            <label className="block text-sm font-medium text-text-main mb-1">
              {t('contacts.iconUrlLabel')}
            </label>
            <input
              type="url"
              value={newForm.icon}
              onChange={(e) =>
                setNewForm((p) => ({ ...p, icon: e.target.value }))
              }
              className={inputClass}
              placeholder={t('contacts.iconUrlPlaceholder')}
            />
            {newForm.icon.trim() && isValidHttpUrl(newForm.icon) && (
              // biome-ignore lint/performance/noImgElement: SVG URLs are supplied by editors.
              <img
                src={newForm.icon.trim()}
                alt=""
                className="mt-2 h-8 w-8 object-contain"
              />
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main mb-1">
              {t('contacts.labelFieldLabel')}
            </label>
            <input
              type="text"
              value={newForm.label}
              onChange={(e) =>
                setNewForm((p) => ({ ...p, label: e.target.value }))
              }
              className={inputClass}
              placeholder={t('contacts.labelPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main mb-1">
              {t('contacts.linkLabel')}
            </label>
            <input
              type="url"
              value={newForm.link}
              onChange={(e) =>
                setNewForm((p) => ({ ...p, link: e.target.value }))
              }
              className={inputClass}
              placeholder={t('contacts.linkPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main mb-1">
              {t('common.color')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={newForm.bg_color}
                onChange={(e) =>
                  setNewForm((p) => ({ ...p, bg_color: e.target.value }))
                }
                className="w-10 h-10 rounded cursor-pointer border-0"
              />
              <input
                type="text"
                value={newForm.bg_color}
                onChange={(e) =>
                  setNewForm((p) => ({ ...p, bg_color: e.target.value }))
                }
                className={`flex-1 ${inputClass}`}
                placeholder="#000000"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              className="px-4 py-2 min-h-[44px] bg-green-600 hover:bg-green-700 text-white rounded-lg"
            >
              {t('common.add')}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsAdding(false);
                setNewForm({
                  label: '',
                  icon: '',
                  link: '',
                  bg_color: '#000000',
                });
              }}
              className="px-4 py-2 min-h-[44px] bg-surface-raised hover:bg-surface-raised text-white rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyState message={t('contacts.title')} />
      ) : (
        <div className="space-y-3">
          {contacts.map((c, idx) => (
            <div
              key={c.id}
              className="bg-surface-card rounded-xl p-4 space-y-3"
            >
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
                  {c.icon.trim() && isValidHttpUrl(c.icon) && (
                    // biome-ignore lint/performance/noImgElement: SVG URLs are supplied by editors.
                    <img
                      src={c.icon.trim()}
                      alt=""
                      className="h-6 w-6 object-contain"
                    />
                  )}
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
                    onChange={(e) =>
                      handleChange(c.id, 'bg_color', e.target.value)
                    }
                    className="w-10 h-10 rounded cursor-pointer border-0 flex-shrink-0"
                  />
                  <div className="w-full sm:w-44">
                    <input
                      type="url"
                      aria-label={t('contacts.iconUrlLabel')}
                      value={c.icon}
                      onChange={(e) =>
                        handleChange(c.id, 'icon', e.target.value)
                      }
                      className={inputClass}
                      placeholder={t('contacts.iconUrlPlaceholder')}
                    />
                  </div>
                </div>
              </div>
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

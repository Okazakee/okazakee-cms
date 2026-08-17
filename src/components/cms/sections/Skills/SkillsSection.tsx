'use client';

import {
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { skillsActions } from '@/app/actions/cms/sections/skillsActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { TranslationField } from '@/components/cms/shared/TranslationField';
import { LocaleToggle } from '@/components/cms/shared/LocaleToggle';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { useSectionTranslations } from '@/hooks/cms/useSectionTranslations';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { PreviewModal } from '@/components/common/cms/PreviewModal';
import { SkillsPreview } from '@/components/common/cms/previews/SkillsPreview';
import type { Skill, SkillsCategory } from '@/types/fetchedData.types';

type EditableSkill = Skill & { isEditing?: boolean };
type EditableCategory = Omit<SkillsCategory, 'skills'> & { skills: EditableSkill[]; isEditing?: boolean; newSkill?: Partial<EditableSkill> };

export default function SkillsSection() {
  const t = useTranslations('cms');

  const [categories, setCategories] = useState<EditableCategory[]>([]);
  const [originalCategories, setOriginalCategories] = useState<EditableCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_isUpdating, setIsUpdating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [activeLocale, setActiveLocale] = useState<'en' | 'it'>('en');

  const [modifiedSkills, setModifiedSkills] = useState<Set<string>>(new Set());
  const [newSkills, setNewSkills] = useState<Array<{ categoryId: number; skill: EditableSkill }>>([]);
  const [deletedSkills, setDeletedSkills] = useState<Set<number>>(new Set());
  const [modifiedCategories, setModifiedCategories] = useState<Set<number>>(new Set());
  const [newCategories, setNewCategories] = useState<Array<{ name: string; tempId: number }>>([]);
  const [deletedCategories, setDeletedCategories] = useState<Set<number>>(new Set());
  const [categoryOrderChanged, setCategoryOrderChanged] = useState(false);

  const {
    isDirty: transDirty,
    isLoading: transLoading,
    getField,
    setField,
    saveTranslations,
    revertTranslations,
  } = useSectionTranslations('skills-section');

  const hasDataChanges =
    modifiedSkills.size > 0 ||
    newSkills.length > 0 ||
    deletedSkills.size > 0 ||
    modifiedCategories.size > 0 ||
    newCategories.length > 0 ||
    deletedCategories.size > 0 ||
    categoryOrderChanged;

  const isDirty = hasDataChanges || transDirty;

  useSectionDirty('skills', isDirty);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await skillsActions({ type: 'GET' });
      if (!result.success) throw new Error(result.error || 'Failed to fetch');
      const loaded = (result.data as SkillsCategory[]).map((cat) => ({
        ...cat,
        skills: cat.skills.map((s) => ({ ...s, isEditing: false })),
      }));
      setCategories(loaded);
      setOriginalCategories(JSON.parse(JSON.stringify(loaded)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    setIsUpdating(true);
    setError(null);

    const batch = await skillsActions({
      type: 'BATCH_PUBLISH',
      newCategories,
      newSkills: newSkills.map(({ categoryId, skill }) => ({
        categoryId,
        data: {
          title: skill.title,
          icon: skill.icon,
          invert: skill.invert,
          category_id: categoryId,
          blurhashURL: skill.blurhashURL || '',
        },
      })),
      deleteSkills: Array.from(deletedSkills),
      deleteCategories: Array.from(deletedCategories),
      categoryOrder: categoryOrderChanged
        ? categories.map((cat, i) => ({ id: cat.id, position: i }))
        : [],
      updateCategories: Array.from(modifiedCategories).flatMap((catId) => {
        const cat = categories.find((c) => c.id === catId);
        return cat ? [{ id: catId, data: { name: cat.name } }] : [];
      }),
      updateSkills: Array.from(modifiedSkills).flatMap((key) => {
        const [catStr, skillStr] = key.split('-');
        const catId = parseInt(catStr, 10);
        const skillId = parseInt(skillStr, 10);
        const cat = categories.find((c) => c.id === catId);
        const skill = cat?.skills.find((s) => s.id === skillId);
        return skill
          ? [{ id: skillId, data: { title: skill.title, icon: skill.icon, invert: skill.invert } }]
          : [];
      }),
    });
    if (!batch.success && batch.error) errors.push(batch.error);
    const revalidationMessage = revalidationWarning(batch);
    if (revalidationMessage) errors.push(revalidationMessage);

    if (transDirty) {
      const tErrs = await saveTranslations();
      errors.push(...tErrs);
    }

    await fetchData();
    setModifiedSkills(new Set());
    setNewSkills([]);
    setDeletedSkills(new Set());
    setModifiedCategories(new Set());
    setNewCategories([]);
    setDeletedCategories(new Set());
    setCategoryOrderChanged(false);
    setIsUpdating(false);

    if (errors.length > 0) setError(errors.join('\n'));
  }, [
    categories, newCategories, newSkills, deletedSkills, deletedCategories,
    modifiedCategories, modifiedSkills, categoryOrderChanged, transDirty,
    saveTranslations, fetchData,
  ]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    fetchData();
    setModifiedSkills(new Set());
    setNewSkills([]);
    setDeletedSkills(new Set());
    setModifiedCategories(new Set());
    setNewCategories([]);
    setDeletedCategories(new Set());
    setCategoryOrderChanged(false);
    revertTranslations();
    setError(null);
  };

  useSectionCallbacks(handlePublish, () => setShowConfirmRevert(true));

  const addNewSkill = (catId: number) => {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? { ...c, newSkill: { title: '', icon: '', invert: false, category_id: catId, blurhashURL: '', isEditing: true } }
          : c
      )
    );
  };

  const saveNewSkill = (catId: number) => {
    const cat = categories.find((c) => c.id === catId);
    const ns = cat?.newSkill;
    if (!ns?.title || !ns.icon?.trim()) {
      setError(t('skills.errorRequiredFields'));
      return;
    }
    const tempId = Date.now();
    const skill: EditableSkill = {
      id: tempId, title: ns.title, icon: ns.icon.trim(), invert: ns.invert || false,
      category_id: catId, blurhashURL: ns.blurhashURL || '', isEditing: false,
    };
    setCategories((prev) => prev.map((c) => (c.id === catId ? { ...c, skills: [...c.skills, skill], newSkill: undefined } : c)));
    setNewSkills((prev) => [...prev, { categoryId: catId, skill }]);
  };

  const toggleEditSkill = (catId: number, skillId: number) => {
    setCategories((prev) => prev.map((c) =>
      c.id === catId ? { ...c, skills: c.skills.map((s) => (s.id === skillId ? { ...s, isEditing: !s.isEditing } : s)) } : c));
  };

  const handleSkillChange = (catId: number, skillId: number, field: string, value: string | boolean) => {
    setCategories((prev) => prev.map((c) =>
      c.id === catId ? { ...c, skills: c.skills.map((s) => (s.id === skillId ? { ...s, [field]: value } : s)) } : c));
    setModifiedSkills((prev) => new Set(prev).add(`${catId}-${skillId}`));
  };

  const cancelSkillEdit = (catId: number, skillId: number) => {
    const origCat = originalCategories.find((c) => c.id === catId);
    const origSkill = origCat?.skills.find((s) => s.id === skillId);
    if (origSkill) {
      setCategories((prev) => prev.map((c) =>
        c.id === catId ? { ...c, skills: c.skills.map((s) => (s.id === skillId ? { ...origSkill, isEditing: false } : s)) } : c));
      setModifiedSkills((prev) => { const n = new Set(prev); n.delete(`${catId}-${skillId}`); return n; });
    }
  };

  const saveSkillChanges = (catId: number, skillId: number) => {
    setCategories((prev) => prev.map((c) =>
      c.id === catId ? { ...c, skills: c.skills.map((s) => (s.id === skillId ? { ...s, isEditing: false } : s)) } : c));
  };

  const deleteSkill = (catId: number, skillId: number) => {
    const isNew = newSkills.some((n) => n.skill.id === skillId);
    if (isNew) {
      setNewSkills((prev) => prev.filter((n) => n.skill.id !== skillId));
    } else {
      setDeletedSkills((prev) => new Set(prev).add(skillId));
    }
    setModifiedSkills((prev) => { const n = new Set(prev); n.delete(`${catId}-${skillId}`); return n; });
    setCategories((prev) => prev.map((c) => (c.id === catId ? { ...c, skills: c.skills.filter((s) => s.id !== skillId) } : c)));
  };

  const createCategory = () => {
    if (!newCategoryName.trim()) return;
    const tempId = Date.now();
    setCategories((prev) => [...prev, { id: tempId, name: newCategoryName.trim(), position: prev.length, skills: [] }]);
    setNewCategories((prev) => [...prev, { name: newCategoryName.trim(), tempId }]);
    setNewCategoryName('');
    setIsCreatingCategory(false);
  };

  const deleteCategory = (catId: number) => {
    const isNew = newCategories.some((n) => n.tempId === catId);
    if (isNew) {
      setNewCategories((prev) => prev.filter((n) => n.tempId !== catId));
    } else {
      setDeletedCategories((prev) => new Set(prev).add(catId));
    }
    setCategories((prev) => prev.filter((c) => c.id !== catId));
  };

  const moveCategory = (catId: number, dir: -1 | 1) => {
    const idx = categories.findIndex((c) => c.id === catId);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= categories.length) return;
    const next = [...categories];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setCategories(next);
    setCategoryOrderChanged(true);
  };

  const inputClass = 'w-full px-3 py-2 bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext focus:border-main focus:outline-none';

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-main" /></div>;
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <SectionHeader title={t('skills.title')} description={t('skills.subtitle')} />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Translations */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-main">{t('common.translations')}</h2>
          <LocaleToggle activeLocale={activeLocale} onChange={setActiveLocale} />
        </div>
        {transLoading ? (
          <div className="flex items-center justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-main" /></div>
        ) : (
          <div className="space-y-4">
            <TranslationField
              label={t('skills.translationTitleLabel')}
              enValue={getField('en', 'title')}
              itValue={getField('it', 'title')}
              onChangeEn={(v) => setField('en', 'title', v)}
              onChangeIt={(v) => setField('it', 'title', v)}
              activeLocale={activeLocale}
            />
            <TranslationField
              label={t('skills.translationSubtitleLabel')}
              enValue={getField('en', 'subtitle')}
              itValue={getField('it', 'subtitle')}
              onChangeEn={(v) => setField('en', 'subtitle', v)}
              onChangeIt={(v) => setField('it', 'subtitle', v)}
              type="textarea"
              rows={3}
              activeLocale={activeLocale}
            />
          </div>
        )}
      </div>

      {/* Category Management */}
      <div className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg md:text-xl font-bold text-main">{t('skills.manageCategoriesTitle')}</h2>
          {!isCreatingCategory && (
            <button type="button" onClick={() => setIsCreatingCategory(true)} className="flex items-center gap-2 px-4 py-2 min-h-[44px] bg-main hover:bg-secondary text-white font-medium rounded-lg transition-colors">
              <Plus className="w-4 h-4" />{t('skills.addCategory')}
            </button>
          )}
        </div>
        {isCreatingCategory && (
          <div className="flex items-center gap-3 mb-4">
            <input type="text" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} className={`flex-1 ${inputClass}`} placeholder={t('skills.categoryNamePlaceholder')} />
            <button type="button" onClick={createCategory} className="px-4 py-2 min-h-[44px] bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors">{t('common.add')}</button>
            <button type="button" onClick={() => { setIsCreatingCategory(false); setNewCategoryName(''); }} className="px-4 py-2 min-h-[44px] bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"><X className="w-4 h-4" /></button>
          </div>
        )}

        {categories.length === 0 && (
          <EmptyState message={t('skills.errorCategoryName')} />
        )}
      </div>

      {/* Categories & Skills */}
      <div className="space-y-4">
        {categories.map((cat, idx) => (
          <div key={cat.id} className="bg-gray-100 dark:bg-darkergray rounded-xl p-4 md:p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-main">{cat.name}</h2>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => moveCategory(cat.id, -1)} disabled={idx === 0} className="p-2 min-h-[44px] text-gray-500 dark:text-lighttext2 hover:text-main disabled:opacity-30" title={t('common.moveUp')}><ArrowUp className="w-4 h-4" /></button>
                <button type="button" onClick={() => moveCategory(cat.id, 1)} disabled={idx === categories.length - 1} className="p-2 min-h-[44px] text-gray-500 dark:text-lighttext2 hover:text-main disabled:opacity-30" title={t('common.moveDown')}><ArrowDown className="w-4 h-4" /></button>
                <div className="w-px h-6 bg-gray-300 dark:border-lighttext2/30 mx-1" />
                <button type="button" onClick={() => deleteCategory(cat.id)} className="p-2 min-h-[44px] text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {cat.skills.map((skill) => (
                <div
                  key={skill.id}
                  className={`rounded-lg p-4 text-center transition-colors ${
                    skill.isEditing
                      ? 'bg-main/5 dark:bg-main/10 border border-main/20'
                      : 'bg-white dark:bg-darkestgray'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-semibold text-darktext dark:text-lighttext truncate pr-2">{skill.title}</h3>
                    <CardToolbar
                      onEdit={() => toggleEditSkill(cat.id, skill.id)}
                      onDelete={() => deleteSkill(cat.id, skill.id)}
                    />
                  </div>
                  {skill.icon && !skill.isEditing && (
                    <div className="mb-3">
                      <Image src={skill.icon} width={64} height={64} className={`mx-auto rounded-lg ${skill.invert ? 'dark:invert' : ''}`} alt={skill.title}
                        placeholder={skill.blurhashURL ? 'blur' : 'empty'}
                        blurDataURL={skill.blurhashURL ?? undefined} />
                    </div>
                  )}
                  {skill.isEditing ? (
                    <div className="space-y-3 text-left">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-lighttext2 mb-1">{t('skills.skillTitlePlaceholder')}</label>
                        <input type="text" value={skill.title} onChange={(e) => handleSkillChange(cat.id, skill.id, 'title', e.target.value)} className={`${inputClass} text-sm`} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-lighttext2 mb-1">Icon URL</label>
                        <input type="url" value={skill.icon} onChange={(e) => handleSkillChange(cat.id, skill.id, 'icon', e.target.value)} className={`${inputClass} text-xs`} placeholder="https://example.com/icon.svg" />
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-500 dark:text-lighttext2">
                        <input type="checkbox" checked={skill.invert} onChange={(e) => handleSkillChange(cat.id, skill.id, 'invert', e.target.checked)} className="rounded" />
                        {t('skills.invertLabel')}
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => cancelSkillEdit(cat.id, skill.id)} className="flex-1 py-1.5 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-700"><X className="w-3 h-3 inline mr-1" />{t('common.cancel')}</button>
                        <button type="button" onClick={() => saveSkillChanges(cat.id, skill.id)} className="flex-1 py-1.5 text-sm bg-main text-white rounded-lg hover:bg-secondary">{t('common.done')}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-2">
                      {skill.invert && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-main/10 text-main dark:bg-main/20">
                          {t('skills.invertLabel')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* New Skill Form */}
              {cat.newSkill && (
                <div className="bg-gray-50 dark:bg-darkestgray rounded-lg p-4 border-2 border-dashed border-main/40">
                  <h4 className="text-lg font-semibold text-main mb-3">{t('skills.newSkill')}</h4>
                  <div className="space-y-2">
                    <input type="text" value={cat.newSkill.title || ''} onChange={(e) => setCategories((prev) => prev.map((c) => c.id === cat.id ? { ...c, newSkill: { ...c.newSkill!, title: e.target.value } } : c))} className={`${inputClass} text-sm`} placeholder="Skill title" />
                    <div className="flex gap-2 items-start">
                      {cat.newSkill.icon && <Image src={cat.newSkill.icon} width={48} height={48} className="rounded flex-shrink-0" alt="" />}
                      <input type="url" value={cat.newSkill.icon || ''} onChange={(e) => setCategories((prev) => prev.map((c) => c.id === cat.id ? { ...c, newSkill: { ...c.newSkill!, icon: e.target.value } } : c))} className={`flex-1 ${inputClass} text-xs`} placeholder="https://example.com/icon.svg" />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-500 dark:text-lighttext2">
                      <input type="checkbox" checked={cat.newSkill.invert || false} onChange={(e) => setCategories((prev) => prev.map((c) => c.id === cat.id ? { ...c, newSkill: { ...c.newSkill!, invert: e.target.checked } } : c))} className="rounded" />
                      {t('skills.invertLabel')}
                    </label>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => saveNewSkill(cat.id)} className="flex-1 py-1 text-sm bg-main text-white rounded-lg hover:bg-secondary">{t('common.add')}</button>
                      <button type="button" onClick={() => setCategories((prev) => prev.map((c) => c.id === cat.id ? { ...c, newSkill: undefined } : c))} className="flex-1 py-1 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-700"><X className="w-3 h-3 inline mr-1" />{t('common.cancel')}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4">
              <button type="button" onClick={() => addNewSkill(cat.id)} className="flex items-center gap-2 px-4 py-2 min-h-[44px] bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors">
                <Plus className="w-4 h-4" />{t('skills.addSkill')}
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog isOpen={showConfirmRevert} title={t('common.revertAll')} message={t('common.confirmRevertAll')} confirmLabel={t('common.revert')} confirmVariant="primary" onConfirm={handleRevert} onCancel={() => setShowConfirmRevert(false)} />

      <PreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} title={t('skills.previewTitle')}>
        <SkillsPreview categories={categories.map((c) => ({ id: c.id, name: c.name, skills: c.skills.map((s) => ({ id: s.id, title: s.title, icon: s.icon, invert: s.invert, blurhashURL: s.blurhashURL })) }))} />
      </PreviewModal>
    </div>
  );
}

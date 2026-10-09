'use client';

import { Plus, X } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { skillsActions } from '@/app/actions/cms/sections/skillsActions';
import { CardToolbar } from '@/components/cms/shared/CardToolbar';
import { ConfirmDialog } from '@/components/cms/shared/ConfirmDialog';
import {
  EditorGroup,
  EditorToolbar,
  editorInputClass,
  editorLabelClass,
  editorPrimaryButtonClass,
  editorSecondaryButtonClass,
} from '@/components/cms/shared/EditorBody';
import { EmptyState } from '@/components/cms/shared/EmptyState';
import { ErrorBanner } from '@/components/cms/shared/ErrorBanner';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { readBatchEvidence, reconcileDrafts } from '@/hooks/cms/batchDrafts';
import { useLatestRequest } from '@/hooks/cms/useLatestRequest';
import { useSectionCallbacks } from '@/hooks/cms/useSectionCallbacks';
import { useSectionDirty } from '@/hooks/cms/useSectionDirty';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { demoSkills } from '@/libs/demo/fixtures';
import { useCmsStore } from '@/store/cmsStore';
import type { Skill, SkillsCategory } from '@/types/fetchedData.types';
import { isValidHttpUrl } from '@/utils/cms/validation';

type EditableSkill = Skill & { isEditing?: boolean };
type EditableCategory = Omit<SkillsCategory, 'skills'> & {
  skills: EditableSkill[];
  isEditing?: boolean;
  newSkill?: Partial<EditableSkill>;
};

export default function SkillsSection() {
  const t = useTranslations('cms');

  const [categories, setCategories] = useState<EditableCategory[]>([]);
  const [originalCategories, setOriginalCategories] = useState<
    EditableCategory[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showConfirmRevert, setShowConfirmRevert] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [renamingCategoryId, setRenamingCategoryId] = useState<number | null>(
    null
  );

  const [modifiedSkills, setModifiedSkills] = useState<Set<string>>(new Set());
  const [newSkills, setNewSkills] = useState<
    Array<{ categoryId: number; skill: EditableSkill }>
  >([]);
  const [deletedSkills, setDeletedSkills] = useState<Set<number>>(new Set());
  const [modifiedCategories, setModifiedCategories] = useState<Set<number>>(
    new Set()
  );
  const [newCategories, setNewCategories] = useState<
    Array<{ name: string; tempId: number }>
  >([]);
  const [deletedCategories, setDeletedCategories] = useState<Set<number>>(
    new Set()
  );
  const [categoryOrderChanged, setCategoryOrderChanged] = useState(false);
  const [skillOrderChanged, setSkillOrderChanged] = useState(false);

  const hasDataChanges =
    modifiedSkills.size > 0 ||
    newSkills.length > 0 ||
    deletedSkills.size > 0 ||
    modifiedCategories.size > 0 ||
    newCategories.length > 0 ||
    deletedCategories.size > 0 ||
    categoryOrderChanged ||
    skillOrderChanged;

  const isDirty = hasDataChanges;

  useSectionDirty('skills', isDirty);

  const beginLoad = useLatestRequest();
  const fetchData = useCallback(async () => {
    const current = beginLoad();
    setIsLoading(true);
    // Offline showcase: fixture categories, no server round-trip.
    if (useCmsStore.getState().demoMode) {
      if (!current()) return;
      const loaded = demoSkills.map((cat) => ({
        ...cat,
        skills: cat.skills.map((s) => ({ ...s, isEditing: false })),
      }));
      setCategories(loaded);
      setOriginalCategories(JSON.parse(JSON.stringify(loaded)));
      setError(null);
      setIsLoading(false);
      return;
    }
    try {
      const result = await skillsActions({ type: 'GET' });
      if (!current()) return;
      if (!result.success) throw new Error(result.error || 'Failed to fetch');
      const loaded = (result.data as SkillsCategory[]).map((cat) => ({
        ...cat,
        skills: cat.skills.map((s) => ({ ...s, isEditing: false })),
      }));
      setCategories(loaded);
      setOriginalCategories(JSON.parse(JSON.stringify(loaded)));
    } catch (err) {
      if (current())
        setError(
          err instanceof Error ? err.message : 'Failed to load skills data'
        );
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [beginLoad]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePublish = useCallback(async () => {
    const errors: string[] = [];
    setIsUpdating(true);
    setError(null);

    // Offline showcase: remap temp ids to fake committed ids, drop
    // deletes, persist the visible order, and clear every draft set.
    if (useCmsStore.getState().demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      let nextFakeId =
        Math.max(
          0,
          ...categories.map((c) => c.id),
          ...categories.flatMap((c) => c.skills.map((s) => s.id))
        ) + 1;
      const catIdMap = new Map<number, number>();
      for (const c of newCategories) catIdMap.set(c.tempId, nextFakeId++);
      const next = categories
        .filter((c) => !deletedCategories.has(c.id))
        .map((c, catIndex) => {
          const id = c.id < 0 ? (catIdMap.get(c.id) ?? c.id) : c.id;
          return {
            ...c,
            id,
            position: catIndex,
            skills: c.skills
              .filter((s) => !deletedSkills.has(s.id))
              .map((s, skillIndex) => ({
                ...s,
                id: s.id < 0 ? nextFakeId++ : s.id,
                category_id: id,
                position: skillIndex,
              })),
          };
        });
      setCategories(next);
      setOriginalCategories(JSON.parse(JSON.stringify(next)));
      setModifiedSkills(new Set());
      setNewSkills([]);
      setDeletedSkills(new Set());
      setModifiedCategories(new Set());
      setNewCategories([]);
      setDeletedCategories(new Set());
      setCategoryOrderChanged(false);
      setSkillOrderChanged(false);
      setIsUpdating(false);
      return;
    }

    const categoryTempIds = newCategories.map((c) => String(c.tempId));
    const categoryTempSet = new Set(categoryTempIds);

    // Categories are created first; skills referencing a temp category send
    // that tempId (string) so the backend can resolve it in the same batch.
    const creates = newCategories.map((c) => ({
      tempId: String(c.tempId),
      name: c.name,
    }));
    const skillCreates = newSkills.map(({ categoryId, skill }) => {
      const latest =
        categories
          .find((c) => c.id === categoryId)
          ?.skills.find((entry) => entry.id === skill.id) ?? skill;
      return {
        tempId: `skill:${skill.id}`,
        categoryId: categoryTempSet.has(String(categoryId))
          ? String(categoryId)
          : categoryId,
        data: {
          title: latest.title,
          icon: latest.icon,
          invert: latest.invert,
          category_id: latest.category_id,
          blurhashURL: latest.blurhashURL || '',
          link: latest.link ?? null,
          position: latest.position ?? null,
        },
      };
    });
    const skillTempIds = newSkills.map(({ skill }) => String(skill.id));
    const skillTempSet = new Set(skillTempIds);

    const updateSkillKeys = Array.from(modifiedSkills).filter((key) => {
      const [, skillStr] = key.split('-');
      return parseInt(skillStr, 10) > 0 && !skillTempIds.includes(skillStr);
    });
    const updateSkills = updateSkillKeys.flatMap((key) => {
      const [catStr, skillStr] = key.split('-');
      const catId = parseInt(catStr, 10);
      const skillId = parseInt(skillStr, 10);
      const cat = categories.find((c) => c.id === catId);
      const skill = cat?.skills.find((entry) => entry.id === skillId);
      return skill
        ? [
            {
              id: skillId,
              data: {
                title: skill.title,
                icon: skill.icon,
                invert: skill.invert,
                link: skill.link ?? null,
              },
            },
          ]
        : [];
    });
    const deleteSkillIds = Array.from(deletedSkills);
    const deleteCategoryIds = Array.from(deletedCategories);
    const updateCategories = Array.from(modifiedCategories)
      .filter((id) => !categoryTempSet.has(String(id)))
      .flatMap((catId) => {
        const cat = categories.find((c) => c.id === catId);
        return cat ? [{ id: catId, data: { name: cat.name } }] : [];
      });
    const categoryOrder = categoryOrderChanged
      ? categories.map((cat, i) => ({
          id: categoryTempSet.has(String(cat.id)) ? String(cat.id) : cat.id,
          position: i,
        }))
      : [];
    // Positions are dense per category and sent for every category, mirroring
    // categoryOrder: reordering one category backfills the others so the
    // public nulls-last ordering never splits a category in two groups.
    const skillOrder = skillOrderChanged
      ? categories.flatMap((cat) =>
          cat.skills.map((skill, index) => ({
            id: skillTempSet.has(String(skill.id))
              ? `skill:${skill.id}`
              : skill.id,
            position: index,
          }))
        )
      : [];

    try {
      let retainedCategories = categoryTempIds;
      let retainedSkills = skillTempIds;
      let retainedSkillUpdates = updateSkillKeys;
      let retainedCategoryUpdates = Array.from(modifiedCategories);
      let retainedSkillDeletes = deleteSkillIds;
      let retainedCategoryDeletes = deleteCategoryIds;
      let retainedOrder = categoryOrderChanged;
      let retainedSkillOrder = skillOrderChanged;
      // Committed-only view of the categories, kept in sync with setCategories
      // so the revert baseline never stores stale temp ids.
      let remappedCategories = categories;

      const batch = await skillsActions({
        type: 'BATCH_PUBLISH',
        newCategories: creates,
        newSkills: skillCreates,
        deleteSkills: deleteSkillIds,
        deleteCategories: deleteCategoryIds,
        categoryOrder,
        skillOrder,
        updateCategories,
        updateSkills,
      });

      const evidence = readBatchEvidence(batch.data);
      if (!batch.success) {
        errors.push(batch.error || 'Failed to publish');
      }
      if (!evidence) {
        errors.push('Publish response was incomplete; drafts were kept');
      } else {
        // Reconcile the id spaces separately: a skill id and a category id
        // can collide numerically, so mixing them would clear the wrong draft.
        const createReconcile = reconcileDrafts({
          evidence,
          createTempIds: [
            ...categoryTempIds,
            ...skillTempIds.map((id) => `skill:${id}`),
          ],
          updateIds: [],
          deleteIds: [],
        });
        const skillUpdateIds = updateSkillKeys.map((key) =>
          parseInt(key.split('-')[1], 10)
        );
        const skillReconcile = reconcileDrafts({
          evidence,
          createTempIds: [],
          updateIds: skillUpdateIds,
          deleteIds: deleteSkillIds,
        });
        const categoryReconcile = reconcileDrafts({
          evidence,
          createTempIds: [],
          updateIds: updateCategories.map((item) => `category:${item.id}`),
          deleteIds: deleteCategoryIds.map((id) => `category:${id}`),
        });
        const createdAt = new Set(createReconcile.committedCreates);
        retainedCategories = categoryTempIds.filter((id) => !createdAt.has(id));
        retainedSkills = skillTempIds.filter(
          (id) => !createdAt.has(`skill:${id}`)
        );
        const retainedSkillIds = new Set(
          skillReconcile.retainedUpdates.map(String)
        );
        retainedSkillUpdates = updateSkillKeys.filter((key) =>
          retainedSkillIds.has(key.split('-')[1])
        );
        retainedCategoryUpdates = categoryReconcile.retainedUpdates.map((id) =>
          Number(String(id).slice('category:'.length))
        );
        retainedSkillDeletes = skillReconcile.retainedDeletes.map(Number);
        retainedCategoryDeletes = categoryReconcile.retainedDeletes.map((id) =>
          Number(String(id).slice('category:'.length))
        );
        errors.push(...createReconcile.failureMessages);

        const retainedCreateSet = new Set(createReconcile.committedCreates);
        const categoryRemap = new Map<string, number>();
        for (const tempId of retainedCreateSet) {
          const real = evidence.createdIds[tempId];
          if (real !== undefined) categoryRemap.set(tempId, Number(real));
        }
        const skillRemap = new Map<string, number>();
        for (const tempId of skillTempIds) {
          const real = evidence.createdIds[`skill:${tempId}`];
          if (real !== undefined) skillRemap.set(tempId, Number(real));
        }

        // Remap committed temp category ids (and skill ids) locally so a
        // retry never re-creates them and never points a skill at a dead temp
        // category.
        remappedCategories = categories.map((cat) => {
          const mappedCat = categoryRemap.get(String(cat.id)) ?? cat.id;
          return {
            ...cat,
            id: mappedCat,
            skills: cat.skills.map((sk) => {
              const mappedSkill = skillRemap.get(String(sk.id)) ?? sk.id;
              const mappedCategory =
                categoryRemap.get(String(sk.category_id)) ?? sk.category_id;
              return {
                ...sk,
                id: mappedSkill,
                category_id: mappedCategory,
              };
            }),
          };
        });
        setCategories(remappedCategories);
        setNewCategories((prev) =>
          prev.filter((c) => retainedCategories.includes(String(c.tempId)))
        );
        setNewSkills((prev) =>
          prev
            .filter((n) => retainedSkills.includes(String(n.skill.id)))
            .map((n) => {
              const mappedCategory =
                categoryRemap.get(String(n.categoryId)) ?? n.categoryId;
              return {
                categoryId: mappedCategory,
                skill: {
                  ...n.skill,
                  category_id: mappedCategory,
                },
              };
            })
        );
        setModifiedSkills(new Set(retainedSkillUpdates));
        setModifiedCategories(new Set(retainedCategoryUpdates));
        setDeletedSkills(new Set(retainedSkillDeletes));
        setDeletedCategories(new Set(retainedCategoryDeletes));

        if (categoryOrderChanged) {
          const reordered = new Set(evidence.reordered.map(String));
          retainedOrder = categoryOrder.some(
            (item) =>
              !reordered.has(
                String(categoryRemap.get(String(item.id)) ?? item.id)
              )
          );
        }
        setCategoryOrderChanged(retainedOrder);

        if (skillOrderChanged) {
          // Skill reorder evidence is namespaced (`skill:<id>`) so a skill id
          // can never be mistaken for a reordered category id.
          const reordered = new Set(evidence.reordered.map(String));
          retainedSkillOrder = skillOrder.some((item) => {
            const resolved =
              typeof item.id === 'string'
                ? (skillRemap.get(item.id.replace('skill:', '')) ?? item.id)
                : item.id;
            return !reordered.has(`skill:${resolved}`);
          });
        }
        setSkillOrderChanged(retainedSkillOrder);
      }

      const revalidationMessage = revalidationWarning(batch);
      if (revalidationMessage)
        useCmsStore.getState().setWarning(revalidationMessage);

      const remaining =
        retainedCategories.length +
        retainedSkills.length +
        retainedSkillUpdates.length +
        retainedCategoryUpdates.length +
        retainedSkillDeletes.length +
        retainedCategoryDeletes.length +
        (retainedOrder ? 1 : 0) +
        (retainedSkillOrder ? 1 : 0);
      if (!batch.success || remaining > 0 || errors.length > 0) {
        const message = errors.join('\n') || 'Publish did not fully succeed';
        setError(message);
        useCmsStore.getState().setError(message);
      } else {
        // No drafts remain: refresh the revert baseline from the committed
        // in-memory state.
        setOriginalCategories(JSON.parse(JSON.stringify(remappedCategories)));
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
    categories,
    newCategories,
    newSkills,
    deletedSkills,
    deletedCategories,
    modifiedCategories,
    modifiedSkills,
    categoryOrderChanged,
    skillOrderChanged,
  ]);

  const handleRevert = () => {
    setShowConfirmRevert(false);
    // Offline showcase: restore the last committed snapshot locally.
    if (useCmsStore.getState().demoMode) {
      setCategories(JSON.parse(JSON.stringify(originalCategories)));
    } else {
      fetchData();
    }
    setModifiedSkills(new Set());
    setNewSkills([]);
    setDeletedSkills(new Set());
    setModifiedCategories(new Set());
    setNewCategories([]);
    setDeletedCategories(new Set());
    setCategoryOrderChanged(false);
    setSkillOrderChanged(false);
    setError(null);
  };

  useSectionCallbacks('skills', handlePublish, handleRevert);

  const addNewSkill = (catId: number) => {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? {
              ...c,
              newSkill: {
                title: '',
                icon: '',
                invert: false,
                category_id: catId,
                blurhashURL: '',
                isEditing: true,
              },
            }
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
    const link = ns.link?.trim() || '';
    if (!isValidHttpUrl(link)) {
      setError(t('skills.errorInvalidLink'));
      return;
    }
    const tempId = Date.now();
    const skill: EditableSkill = {
      id: tempId,
      title: ns.title,
      icon: ns.icon.trim(),
      invert: ns.invert || false,
      category_id: catId,
      blurhashURL: ns.blurhashURL || '',
      link: link === '' ? null : link,
      // New skills land last in their category; publishing makes that durable.
      position: cat ? cat.skills.length : 0,
      isEditing: false,
    };
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? { ...c, skills: [...c.skills, skill], newSkill: undefined }
          : c
      )
    );
    setNewSkills((prev) => [...prev, { categoryId: catId, skill }]);
    setSkillOrderChanged(true);
  };

  const toggleEditSkill = (catId: number, skillId: number) => {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? {
              ...c,
              skills: c.skills.map((s) =>
                s.id === skillId ? { ...s, isEditing: !s.isEditing } : s
              ),
            }
          : c
      )
    );
  };

  const handleSkillChange = (
    catId: number,
    skillId: number,
    field: string,
    value: string | boolean
  ) => {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? {
              ...c,
              skills: c.skills.map((s) =>
                s.id === skillId ? { ...s, [field]: value } : s
              ),
            }
          : c
      )
    );
    setModifiedSkills((prev) => new Set(prev).add(`${catId}-${skillId}`));
  };

  const cancelSkillEdit = (catId: number, skillId: number) => {
    const origCat = originalCategories.find((c) => c.id === catId);
    const origSkill = origCat?.skills.find((s) => s.id === skillId);
    if (origSkill) {
      setCategories((prev) =>
        prev.map((c) =>
          c.id === catId
            ? {
                ...c,
                skills: c.skills.map((s) =>
                  s.id === skillId ? { ...origSkill, isEditing: false } : s
                ),
              }
            : c
        )
      );
      setModifiedSkills((prev) => {
        const n = new Set(prev);
        n.delete(`${catId}-${skillId}`);
        return n;
      });
    }
  };

  const saveSkillChanges = (catId: number, skillId: number) => {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? {
              ...c,
              skills: c.skills.map((s) =>
                s.id === skillId ? { ...s, isEditing: false } : s
              ),
            }
          : c
      )
    );
  };

  const deleteSkill = (catId: number, skillId: number) => {
    const isNew = newSkills.some((n) => n.skill.id === skillId);
    if (isNew) {
      setNewSkills((prev) => prev.filter((n) => n.skill.id !== skillId));
    } else {
      setDeletedSkills((prev) => new Set(prev).add(skillId));
    }
    setModifiedSkills((prev) => {
      const n = new Set(prev);
      n.delete(`${catId}-${skillId}`);
      return n;
    });
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? {
              ...c,
              skills: c.skills
                .filter((s) => s.id !== skillId)
                .map((skill, position) => ({ ...skill, position })),
            }
          : c
      )
    );
    setSkillOrderChanged(true);
  };

  const createCategory = () => {
    if (!newCategoryName.trim()) return;
    const tempId = Date.now();
    setCategories((prev) => [
      ...prev,
      {
        id: tempId,
        name: newCategoryName.trim(),
        position: prev.length,
        skills: [],
      },
    ]);
    setNewCategories((prev) => [
      ...prev,
      { name: newCategoryName.trim(), tempId },
    ]);
    setCategoryOrderChanged(true);
    setNewCategoryName('');
    setIsCreatingCategory(false);
  };

  const renameCategory = (catId: number, name: string) => {
    setCategories((prev) =>
      prev.map((category) =>
        category.id === catId ? { ...category, name } : category
      )
    );
    if (newCategories.some((category) => category.tempId === catId)) {
      setNewCategories((prev) =>
        prev.map((category) =>
          category.tempId === catId ? { ...category, name } : category
        )
      );
    } else {
      setModifiedCategories((prev) => new Set(prev).add(catId));
    }
  };

  const deleteCategory = (catId: number) => {
    const isNew = newCategories.some((n) => n.tempId === catId);
    if (isNew) {
      setNewCategories((prev) => prev.filter((n) => n.tempId !== catId));
    } else {
      setDeletedCategories((prev) => new Set(prev).add(catId));
    }
    setNewSkills((prev) => prev.filter((n) => n.categoryId !== catId));
    setModifiedCategories(
      (prev) => new Set([...prev].filter((id) => id !== catId))
    );
    setModifiedSkills(
      (prev) => new Set([...prev].filter((key) => !key.startsWith(`${catId}-`)))
    );
    setDeletedSkills((prev) => {
      const next = new Set(prev);
      for (const skill of categories.find((cat) => cat.id === catId)?.skills ??
        []) {
        if (!newSkills.some((draft) => draft.skill.id === skill.id)) {
          next.add(skill.id);
        }
      }
      return next;
    });
    setCategories((prev) =>
      prev
        .filter((c) => c.id !== catId)
        .map((category, position) => ({ ...category, position }))
    );
    setCategoryOrderChanged(true);
  };

  const moveCategory = (catId: number, dir: -1 | 1) => {
    const idx = categories.findIndex((c) => c.id === catId);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= categories.length) return;
    const next = [...categories];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setCategories(
      next.map((category, position) => ({ ...category, position }))
    );
    setCategoryOrderChanged(true);
  };

  const moveSkill = (catId: number, skillId: number, dir: -1 | 1) => {
    const cat = categories.find((c) => c.id === catId);
    const idx = cat?.skills.findIndex((s) => s.id === skillId) ?? -1;
    if (!cat || idx < 0 || idx + dir < 0 || idx + dir >= cat.skills.length)
      return;

    setCategories((prev) =>
      prev.map((category) => {
        if (category.id !== catId) return category;
        const next = [...category.skills];
        [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
        // Positions are re-densified locally so the public site (which sorts
        // by position) matches the order shown in the editor, and publishing
        // persists exactly what the editor displays.
        return {
          ...category,
          skills: next.map((s, i) => ({ ...s, position: i })),
        };
      })
    );
    setSkillOrderChanged(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-violet" />
      </div>
    );
  }

  return (
    <fieldset
      disabled={isUpdating}
      className="space-y-6 md:space-y-8 border-0 p-0 m-0 min-w-0"
    >
      <SectionHeader
        title={t('skills.title')}
        description={t('skills.subtitle')}
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

      <EditorToolbar
        title={t('skills.manageCategoriesTitle')}
        count={categories.length}
        actions={
          !isCreatingCategory ? (
            <button
              type="button"
              onClick={() => setIsCreatingCategory(true)}
              className={editorPrimaryButtonClass}
            >
              <Plus className="w-4 h-4" />
              {t('skills.addCategory')}
            </button>
          ) : undefined
        }
      />
      {isCreatingCategory && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            className={`flex-1 ${editorInputClass}`}
            placeholder={t('skills.categoryNamePlaceholder')}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={createCategory}
              className={editorPrimaryButtonClass}
            >
              {t('editor.addDraft')}
            </button>
            <button
              type="button"
              aria-label={t('common.cancel')}
              onClick={() => {
                setIsCreatingCategory(false);
                setNewCategoryName('');
              }}
              className={editorSecondaryButtonClass}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      {categories.length === 0 && !isCreatingCategory && (
        <EmptyState message={t('skills.errorCategoryName')} />
      )}

      <div className="space-y-6">
        {categories.map((cat, idx) => (
          <EditorGroup
            key={cat.id}
            count={cat.skills.length}
            title={
              renamingCategoryId === cat.id ? (
                <input
                  aria-label={t('skills.categoryNamePlaceholder')}
                  className={editorInputClass}
                  value={cat.name}
                  onChange={(event) =>
                    renameCategory(cat.id, event.target.value)
                  }
                  onBlur={() => setRenamingCategoryId(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setRenamingCategoryId(null);
                  }}
                />
              ) : (
                cat.name
              )
            }
            actions={
              <CardToolbar
                showReorder
                isFirst={idx === 0}
                isLast={idx === categories.length - 1}
                onMoveUp={() => moveCategory(cat.id, -1)}
                onMoveDown={() => moveCategory(cat.id, 1)}
                onEdit={() => setRenamingCategoryId(cat.id)}
                onDelete={() => deleteCategory(cat.id)}
              />
            }
          >
            <div className="space-y-3">
              {cat.skills.map((skill, skillIdx) => (
                <article
                  key={skill.id}
                  aria-labelledby={`skill-heading-${cat.id}-${skill.id}`}
                  className={`rounded-xl border border-border-subtle bg-surface-base p-4 ${
                    skill.isEditing ? 'border-accent-violet/40' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    {skill.icon ? (
                      <Image
                        src={skill.icon}
                        width={32}
                        height={32}
                        className={`h-8 w-8 flex-shrink-0 rounded object-contain ${skill.invert ? 'dark:invert' : ''}`}
                        alt=""
                        placeholder={skill.blurhashURL ? 'blur' : 'empty'}
                        blurDataURL={skill.blurhashURL ?? undefined}
                      />
                    ) : (
                      <span className="h-8 w-8 flex-shrink-0 rounded bg-surface-raised" />
                    )}
                    <div className="min-w-0 flex-1">
                      <h3
                        id={`skill-heading-${cat.id}-${skill.id}`}
                        className="truncate font-semibold text-text-main"
                      >
                        {skill.title || t('skills.skillTitlePlaceholder')}
                      </h3>
                      <p className="truncate text-xs text-text-muted">
                        {skill.link
                          ? skill.link
                          : t('skills.skillLinkPlaceholder')}
                        {skill.invert ? ` · ${t('skills.invertLabel')}` : ''}
                      </p>
                    </div>
                    <div className="flex w-full justify-end sm:w-auto">
                      <CardToolbar
                        showReorder
                        isFirst={skillIdx === 0}
                        isLast={skillIdx === cat.skills.length - 1}
                        onMoveUp={() => moveSkill(cat.id, skill.id, -1)}
                        onMoveDown={() => moveSkill(cat.id, skill.id, 1)}
                        onEdit={() => toggleEditSkill(cat.id, skill.id)}
                        onDelete={() => deleteSkill(cat.id, skill.id)}
                      />
                    </div>
                  </div>
                  {skill.isEditing && (
                    <div className="mt-4 space-y-4 text-left">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label
                            htmlFor={`skill-title-${cat.id}-${skill.id}`}
                            className={editorLabelClass}
                          >
                            {t('skills.skillTitlePlaceholder')}
                          </label>
                          <input
                            id={`skill-title-${cat.id}-${skill.id}`}
                            type="text"
                            value={skill.title}
                            onChange={(e) =>
                              handleSkillChange(
                                cat.id,
                                skill.id,
                                'title',
                                e.target.value
                              )
                            }
                            className={editorInputClass}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`skill-icon-${cat.id}-${skill.id}`}
                            className={editorLabelClass}
                          >
                            {t('skills.iconUrlLabel')}
                          </label>
                          <input
                            id={`skill-icon-${cat.id}-${skill.id}`}
                            type="url"
                            value={skill.icon}
                            onChange={(e) =>
                              handleSkillChange(
                                cat.id,
                                skill.id,
                                'icon',
                                e.target.value
                              )
                            }
                            className={editorInputClass}
                            placeholder={t('skills.skillIconPlaceholder')}
                          />
                        </div>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label
                            htmlFor={`skill-link-${cat.id}-${skill.id}`}
                            className={editorLabelClass}
                          >
                            {t('skills.skillLinkLabel')}
                          </label>
                          <input
                            id={`skill-link-${cat.id}-${skill.id}`}
                            type="url"
                            value={skill.link ?? ''}
                            onChange={(e) =>
                              handleSkillChange(
                                cat.id,
                                skill.id,
                                'link',
                                e.target.value
                              )
                            }
                            className={editorInputClass}
                            placeholder={t('skills.skillLinkPlaceholder')}
                          />
                        </div>
                        <div className="flex items-end pb-2">
                          <label className="flex items-center gap-2 text-sm text-text-muted">
                            <input
                              type="checkbox"
                              checked={skill.invert}
                              onChange={(e) =>
                                handleSkillChange(
                                  cat.id,
                                  skill.id,
                                  'invert',
                                  e.target.checked
                                )
                              }
                              className="rounded"
                            />
                            {t('skills.invertLabel')}
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => cancelSkillEdit(cat.id, skill.id)}
                          className={`flex-1 ${editorSecondaryButtonClass}`}
                        >
                          <X className="w-3 h-3 inline mr-1" />
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => saveSkillChanges(cat.id, skill.id)}
                          className={`flex-1 ${editorPrimaryButtonClass}`}
                        >
                          {t('editor.applyDraft')}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}

              {cat.newSkill && (
                <div className="rounded-xl border border-dashed border-accent-violet/40 bg-surface-base p-4">
                  <EditorToolbar title={t('skills.newSkill')} />
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label
                          htmlFor={`new-skill-title-${cat.id}`}
                          className={editorLabelClass}
                        >
                          {t('skills.skillTitlePlaceholder')}
                        </label>
                        <input
                          id={`new-skill-title-${cat.id}`}
                          type="text"
                          value={cat.newSkill.title || ''}
                          onChange={(e) =>
                            setCategories((prev) =>
                              prev.map((c) =>
                                c.id === cat.id
                                  ? {
                                      ...c,
                                      newSkill: {
                                        ...c.newSkill!,
                                        title: e.target.value,
                                      },
                                    }
                                  : c
                              )
                            )
                          }
                          className={editorInputClass}
                          placeholder={t('skills.skillTitlePlaceholder')}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`new-skill-icon-${cat.id}`}
                          className={editorLabelClass}
                        >
                          {t('skills.iconUrlLabel')}
                        </label>
                        <div className="flex items-center gap-2">
                          {cat.newSkill.icon && (
                            <Image
                              src={cat.newSkill.icon}
                              width={32}
                              height={32}
                              className="h-8 w-8 flex-shrink-0 rounded object-contain"
                              alt=""
                            />
                          )}
                          <input
                            id={`new-skill-icon-${cat.id}`}
                            type="url"
                            value={cat.newSkill.icon || ''}
                            onChange={(e) =>
                              setCategories((prev) =>
                                prev.map((c) =>
                                  c.id === cat.id
                                    ? {
                                        ...c,
                                        newSkill: {
                                          ...c.newSkill!,
                                          icon: e.target.value,
                                        },
                                      }
                                    : c
                                )
                              )
                            }
                            className={editorInputClass}
                            placeholder={t('skills.skillIconPlaceholder')}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label
                          htmlFor={`new-skill-link-${cat.id}`}
                          className={editorLabelClass}
                        >
                          {t('skills.skillLinkLabel')}
                        </label>
                        <input
                          id={`new-skill-link-${cat.id}`}
                          type="url"
                          value={cat.newSkill.link || ''}
                          onChange={(e) =>
                            setCategories((prev) =>
                              prev.map((c) =>
                                c.id === cat.id
                                  ? {
                                      ...c,
                                      newSkill: {
                                        ...c.newSkill!,
                                        link: e.target.value,
                                      },
                                    }
                                  : c
                              )
                            )
                          }
                          className={editorInputClass}
                          placeholder={t('skills.skillLinkPlaceholder')}
                        />
                      </div>
                      <div className="flex items-end pb-2">
                        <label className="flex items-center gap-2 text-sm text-text-muted">
                          <input
                            type="checkbox"
                            checked={cat.newSkill.invert || false}
                            onChange={(e) =>
                              setCategories((prev) =>
                                prev.map((c) =>
                                  c.id === cat.id
                                    ? {
                                        ...c,
                                        newSkill: {
                                          ...c.newSkill!,
                                          invert: e.target.checked,
                                        },
                                      }
                                    : c
                                )
                              )
                            }
                            className="rounded"
                          />
                          {t('skills.invertLabel')}
                        </label>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setCategories((prev) =>
                            prev.map((c) =>
                              c.id === cat.id
                                ? { ...c, newSkill: undefined }
                                : c
                            )
                          )
                        }
                        className={`flex-1 ${editorSecondaryButtonClass}`}
                      >
                        <X className="w-3 h-3 inline mr-1" />
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => saveNewSkill(cat.id)}
                        className={`flex-1 ${editorPrimaryButtonClass}`}
                      >
                        {t('editor.addDraft')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {!cat.newSkill && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => addNewSkill(cat.id)}
                  className={editorSecondaryButtonClass}
                >
                  <Plus className="w-4 h-4" />
                  {t('skills.addSkill')}
                </button>
              </div>
            )}
          </EditorGroup>
        ))}
      </div>

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

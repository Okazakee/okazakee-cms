'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  getCmsActionContext,
  requireAdmin,
} from '@/app/actions/cms/utils/fileHelpers';
import {
  batchFailureSummary,
  batchHadCommits,
  batchSucceeded,
  emptyBatchEvidence,
  markCreated,
  markDeleted,
  markFailed,
  markReordered,
  markUpdated,
  normalizeTempId,
} from '@/libs/cms/batchEvidence';
import type {
  MutationResult,
  RevalidationStatus,
} from '@/libs/cms/mutationResult';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import { isValidHttpUrl } from '@/utils/cms/validation';
import { createClient } from '@/utils/supabase/server';

type SkillOperation =
  | { type: 'GET' }
  | { type: 'CREATE'; data: CreateSkillData }
  | { type: 'UPDATE'; id: number; data: UpdateSkillData }
  | { type: 'DELETE'; id: number }
  | { type: 'CREATE_CATEGORY'; data: CreateCategoryData }
  | { type: 'UPDATE_CATEGORY'; id: number; data: UpdateCategoryData }
  | { type: 'DELETE_CATEGORY'; id: number }
  | {
      type: 'BATCH_PUBLISH';
      newCategories: Array<{ name: string; tempId: string }>;
      newSkills: Array<{
        categoryId: number | string;
        tempId?: string;
        data: CreateSkillData;
      }>;
      updateSkills: Array<{ id: number; data: UpdateSkillData }>;
      deleteSkills: number[];
      updateCategories: Array<{
        id: number | string;
        data: UpdateCategoryData;
      }>;
      deleteCategories: number[];
      categoryOrder: Array<{ id: number | string; position: number }>;
      skillOrder: Array<{ id: number | string; position: number }>;
    };

type CreateSkillData = {
  title: string;
  icon: string;
  invert: boolean;
  category_id?: number;
  blurhashURL?: string;
  link?: string | null;
  position?: number | null;
};

type UpdateSkillData = {
  title?: string;
  category_id?: number;
  icon?: string;
  blurhashURL?: string;
  invert?: boolean;
  link?: string | null;
  position?: number | null;
};

type CreateCategoryData = {
  name: string;
};

type UpdateCategoryData = {
  name?: string;
  position?: number;
};

type SkillsResult = MutationResult;

// Validation functions
function validateSkillData(data: CreateSkillData | UpdateSkillData): {
  isValid: boolean;
  error?: string;
} {
  // Title validation (for CreateSkillData)
  if ('title' in data && data.title !== undefined) {
    if (!data.title || data.title.trim().length === 0) {
      return { isValid: false, error: 'Skill title is required' };
    }
    if (data.title.length > 100) {
      return {
        isValid: false,
        error: 'Skill title must be less than 100 characters',
      };
    }
  }

  // Category ID validation
  if (
    data.category_id !== undefined &&
    (data.category_id < 1 || !Number.isInteger(data.category_id))
  ) {
    return { isValid: false, error: 'Invalid category ID' };
  }

  // Link validation: optional, but must be an http(s) URL when present.
  if (
    data.link !== undefined &&
    data.link !== null &&
    !isValidHttpUrl(data.link)
  ) {
    return { isValid: false, error: 'Skill link must be a valid http(s) URL' };
  }

  return { isValid: true };
}

/** Empty/blank links are stored as NULL so "no link" has one representation. */
function normalizeSkillLink(link: string | null | undefined): string | null {
  const trimmed = link?.trim();
  return trimmed ? trimmed : null;
}

/** Normalizes link/position while leaving absent fields untouched. */
function withNormalizedSkillFields<T extends UpdateSkillData>(data: T): T {
  const next: UpdateSkillData = { ...data };
  if (data.link !== undefined) next.link = normalizeSkillLink(data.link);
  if (data.position !== undefined)
    next.position = Number.isInteger(data.position) ? data.position : null;
  return next as T;
}

export async function skillsActions(
  operation: SkillOperation
): Promise<SkillsResult> {
  if (operation.type === 'BATCH_PUBLISH') {
    return await batchPublishSkills(operation);
  }

  // Admin check - only admins can manage skills
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getSkills(supabase);

      case 'CREATE':
        return await createSkill(supabase, operation.data);

      case 'UPDATE':
        return await updateSkill(supabase, operation.id, operation.data);

      case 'DELETE':
        return await deleteSkill(supabase, operation.id);

      case 'CREATE_CATEGORY':
        return await createCategory(supabase, operation.data);

      case 'UPDATE_CATEGORY':
        return await updateCategory(supabase, operation.id, operation.data);

      case 'DELETE_CATEGORY':
        return await deleteCategory(supabase, operation.id);

      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Skills action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

async function batchPublishSkills(
  operation: Extract<SkillOperation, { type: 'BATCH_PUBLISH' }>
): Promise<SkillsResult> {
  const evidence = emptyBatchEvidence();
  const tempIdToRealId: Record<string, number> = {};
  try {
    await getCmsActionContext('admin');
    const admin = getAdminClient();

    for (const [index, category] of operation.newCategories.entries()) {
      const tempId = normalizeTempId(category.tempId, 'category', index);
      if (!category.name || category.name.trim().length === 0) {
        markFailed(evidence, {
          kind: 'category',
          tempId,
          error: 'Category name is required',
        });
        continue;
      }

      const { data, error } = await admin
        .from('skills_categories')
        .insert({ name: category.name.trim() })
        .select()
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'category',
          tempId,
          error: error.message,
        });
      } else {
        tempIdToRealId[tempId] = data.id as number;
        markCreated(evidence, tempId, data.id);
      }
    }

    for (const [index, item] of operation.newSkills.entries()) {
      const tempId = normalizeTempId(item.tempId, 'skill', index);
      const resolvedCategoryId =
        typeof item.categoryId === 'string'
          ? tempIdToRealId[item.categoryId]
          : item.categoryId;

      if (resolvedCategoryId === undefined) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: 'Unknown skill category',
        });
        continue;
      }

      const skillData = withNormalizedSkillFields({
        ...item.data,
        category_id: resolvedCategoryId,
      });
      const validation = validateSkillData(skillData);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'create',
          tempId,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const { data, error } = await admin
        .from('skills')
        .insert(skillData)
        .select()
        .single();

      if (error) {
        markFailed(evidence, { kind: 'create', tempId, error: error.message });
      } else {
        tempIdToRealId[tempId] = data.id as number;
        markCreated(evidence, tempId, data.id);
      }
    }

    if (operation.deleteSkills.length > 0) {
      const { data: existingRows, error: fetchError } = await admin
        .from('skills')
        .select('id')
        .in('id', operation.deleteSkills);

      if (fetchError) {
        markFailed(evidence, { kind: 'delete', error: fetchError.message });
      } else {
        // Returned-row evidence: unknown ids keep their drafts.
        const existingIds = new Set(
          (existingRows || []).map((row) => row.id as number)
        );
        for (const id of operation.deleteSkills) {
          if (!existingIds.has(id)) {
            markFailed(evidence, {
              kind: 'delete',
              id,
              error: 'Skill not found',
            });
          }
        }
        const deletable = operation.deleteSkills.filter((id) =>
          existingIds.has(id)
        );
        if (deletable.length > 0) {
          const { data: deletedRows, error } = await admin
            .from('skills')
            .delete()
            .in('id', deletable)
            .select('id');

          if (error) {
            markFailed(evidence, { kind: 'delete', error: error.message });
          } else {
            const deletedIds = new Set(
              (deletedRows || []).map((row) => row.id as number)
            );
            for (const id of deletable) {
              if (deletedIds.has(id)) markDeleted(evidence, id);
              else {
                markFailed(evidence, {
                  kind: 'delete',
                  id,
                  error: 'Skill was not deleted',
                });
              }
            }
          }
        }
      }
    }

    for (const categoryId of operation.deleteCategories) {
      const { data: skills, error: skillsError } = await admin
        .from('skills')
        .select('id')
        .eq('category_id', categoryId);

      if (skillsError) {
        markFailed(evidence, {
          kind: 'category',
          id: categoryId,
          error: skillsError.message,
        });
        continue;
      }

      if (skills && skills.length > 0) {
        markFailed(evidence, {
          kind: 'category',
          id: categoryId,
          error: `Cannot delete category with ${skills.length} skill(s). Remove all skills first.`,
        });
        continue;
      }

      const { data: deletedCategory, error } = await admin
        .from('skills_categories')
        .delete()
        .eq('id', categoryId)
        .select('id')
        .single();

      if (error || !deletedCategory) {
        markFailed(evidence, {
          kind: 'category',
          id: categoryId,
          error: error?.message ?? 'Category was not deleted',
        });
      } else {
        markDeleted(evidence, `category:${categoryId}`);
      }
    }

    for (const item of operation.updateCategories) {
      const resolvedId =
        typeof item.id === 'string' ? tempIdToRealId[item.id] : item.id;
      if (resolvedId === undefined) {
        markFailed(evidence, {
          kind: 'category',
          id: item.id,
          error: 'Unknown category',
        });
        continue;
      }

      const updateFields: UpdateCategoryData = {};
      if (item.data.name !== undefined) {
        updateFields.name = item.data.name.trim();
      }
      if (item.data.position !== undefined) {
        updateFields.position = item.data.position;
      }

      const { error } = await admin
        .from('skills_categories')
        .update(updateFields)
        .eq('id', resolvedId)
        .select('id')
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'category',
          id: resolvedId,
          error: error.message,
        });
      } else {
        markUpdated(evidence, `category:${resolvedId}`);
      }
    }

    for (const item of operation.categoryOrder) {
      const resolvedId =
        typeof item.id === 'string' ? tempIdToRealId[item.id] : item.id;
      if (resolvedId === undefined) {
        markFailed(evidence, {
          kind: 'reorder',
          id: item.id,
          error: 'Unknown category',
        });
        continue;
      }

      const { error } = await admin
        .from('skills_categories')
        .update({ position: item.position })
        .eq('id', resolvedId)
        .select('id')
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'reorder',
          id: resolvedId,
          error: error.message,
        });
      } else {
        markReordered(evidence, resolvedId);
      }
    }

    for (const item of operation.updateSkills) {
      const updateFields = withNormalizedSkillFields(item.data);
      const validation = validateSkillData(updateFields);
      if (!validation.isValid) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: validation.error ?? 'Invalid data',
        });
        continue;
      }

      const { error } = await admin
        .from('skills')
        .update(updateFields)
        .eq('id', item.id)
        .select('id')
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'update',
          id: item.id,
          error: error.message,
        });
      } else {
        markUpdated(evidence, item.id);
      }
    }

    // Runs last so a reorder always wins over the row updates above: the
    // position column is the source of truth for the order inside a category.
    // Evidence ids are namespaced (`skill:<id>`) because a skill id and a
    // category id can collide numerically.
    for (const item of operation.skillOrder) {
      const resolvedId =
        typeof item.id === 'string' ? tempIdToRealId[item.id] : item.id;
      if (resolvedId === undefined) {
        markFailed(evidence, {
          kind: 'reorder',
          id: `skill:${String(item.id).replace(/^skill:/, '')}`,
          error: 'Unknown skill',
        });
        continue;
      }
      const { error } = await admin
        .from('skills')
        .update({ position: item.position })
        .eq('id', resolvedId)
        .select('id')
        .single();

      if (error) {
        markFailed(evidence, {
          kind: 'reorder',
          id: `skill:${resolvedId}`,
          error: error.message,
        });
      } else {
        markReordered(evidence, `skill:${resolvedId}`);
      }
    }

    let revalidation: RevalidationStatus | undefined;
    if (batchHadCommits(evidence)) {
      revalidation = await invalidatePublicContent({
        entity: 'skills',
        operation: 'publish',
      });
    }

    return {
      success: batchSucceeded(evidence),
      data: { ...evidence, tempIdToRealId },
      error: batchFailureSummary(evidence),
      revalidation,
    };
  } catch (error) {
    console.error('Error batch publishing skills:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to publish skills';
    markFailed(evidence, { kind: 'update', error: message });
    const revalidation = batchHadCommits(evidence)
      ? await invalidatePublicContent({
          entity: 'skills',
          operation: 'publish',
        })
      : undefined;
    return {
      success: false,
      data: { ...evidence, tempIdToRealId },
      error: batchFailureSummary(evidence),
      revalidation,
    };
  }
}
async function getSkills(supabase: SupabaseClient): Promise<SkillsResult> {
  try {
    const { data, error } = await supabase
      .from('skills_categories')
      .select('*, skills(*)')
      .order('position', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .order('position', {
        referencedTable: 'skills',
        ascending: true,
        nullsFirst: false,
      })
      .order('id', { referencedTable: 'skills', ascending: true });

    if (error) throw error;

    return { success: true, data };
  } catch (error) {
    console.error('Error fetching skills:', error);
    return {
      success: false,
      error: 'Failed to fetch skills data',
    };
  }
}

async function createSkill(
  _supabase: SupabaseClient,
  skillData: CreateSkillData
): Promise<SkillsResult> {
  try {
    const normalized = withNormalizedSkillFields(skillData);
    const validation = validateSkillData(normalized);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('skills')
      .insert(normalized)
      .select()
      .single();

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'skills',
      operation: 'create',
    });
    return { success: true, data, revalidation };
  } catch (error) {
    console.error('Error creating skill:', error);
    return {
      success: false,
      error: 'Failed to create skill',
    };
  }
}

async function updateSkill(
  _supabase: SupabaseClient,
  skillId: number,
  updateData: UpdateSkillData
): Promise<SkillsResult> {
  try {
    const updateFields = withNormalizedSkillFields(updateData);
    const validation = validateSkillData(updateFields);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data: existingSkill, error: fetchError } = await admin
      .from('skills')
      .select('id')
      .eq('id', skillId)
      .single();

    if (fetchError || !existingSkill) {
      return { success: false, error: 'Skill not found' };
    }

    const { data, error } = await admin
      .from('skills')
      .update(updateFields)
      .eq('id', skillId)
      .select();

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'skills',
      operation: 'update',
    });
    return { success: true, data, revalidation };
  } catch (error) {
    console.error('Error updating skill:', error);
    return {
      success: false,
      error: 'Failed to update skill',
    };
  }
}

async function deleteSkill(
  _supabase: SupabaseClient,
  skillId: number
): Promise<SkillsResult> {
  try {
    const admin = getAdminClient();
    const { error } = await admin.from('skills').delete().eq('id', skillId);

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'skills',
      operation: 'delete',
    });
    return { success: true, revalidation };
  } catch (error) {
    console.error('Error deleting skill:', error);
    return {
      success: false,
      error: 'Failed to delete skill',
    };
  }
}

async function createCategory(
  _supabase: SupabaseClient,
  categoryData: CreateCategoryData
): Promise<SkillsResult> {
  try {
    if (!categoryData.name || categoryData.name.trim().length === 0) {
      return { success: false, error: 'Category name is required' };
    }

    if (categoryData.name.length > 100) {
      return {
        success: false,
        error: 'Category name must be less than 100 characters',
      };
    }

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('skills_categories')
      .insert({ name: categoryData.name.trim() })
      .select()
      .single();

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'skills',
      operation: 'create',
    });
    return { success: true, data, revalidation };
  } catch (error) {
    console.error('Error creating category:', error);
    return {
      success: false,
      error: 'Failed to create category',
    };
  }
}

async function updateCategory(
  _supabase: SupabaseClient,
  categoryId: number,
  updateData: UpdateCategoryData
): Promise<SkillsResult> {
  try {
    if (updateData.name !== undefined) {
      if (!updateData.name || updateData.name.trim().length === 0) {
        return { success: false, error: 'Category name cannot be empty' };
      }
      if (updateData.name.length > 100) {
        return {
          success: false,
          error: 'Category name must be less than 100 characters',
        };
      }
    }

    const admin = getAdminClient();
    const { data: existingCategory, error: fetchError } = await admin
      .from('skills_categories')
      .select('id')
      .eq('id', categoryId)
      .single();

    if (fetchError || !existingCategory) {
      return { success: false, error: 'Category not found' };
    }

    const updateFields: { name?: string; position?: number } = {};
    if (updateData.name !== undefined) {
      updateFields.name = updateData.name.trim();
    }
    if (updateData.position !== undefined) {
      updateFields.position = updateData.position;
    }

    const { data, error } = await admin
      .from('skills_categories')
      .update(updateFields)
      .eq('id', categoryId)
      .select()
      .single();

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'skills',
      operation: 'update',
    });
    return { success: true, data, revalidation };
  } catch (error) {
    console.error('Error updating category:', error);
    return {
      success: false,
      error: 'Failed to update category',
    };
  }
}

async function deleteCategory(
  _supabase: SupabaseClient,
  categoryId: number
): Promise<SkillsResult> {
  try {
    const admin = getAdminClient();
    const { data: skills, error: skillsError } = await admin
      .from('skills')
      .select('id')
      .eq('category_id', categoryId);

    if (skillsError) throw skillsError;

    if (skills && skills.length > 0) {
      return {
        success: false,
        error: `Cannot delete category with ${skills.length} skill(s). Remove all skills first.`,
      };
    }

    const { error } = await admin
      .from('skills_categories')
      .delete()
      .eq('id', categoryId);

    if (error) throw error;

    const revalidation = await invalidatePublicContent({
      entity: 'skills',
      operation: 'delete',
    });
    return { success: true, revalidation };
  } catch (error) {
    console.error('Error deleting category:', error);
    return {
      success: false,
      error: 'Failed to delete category',
    };
  }
}

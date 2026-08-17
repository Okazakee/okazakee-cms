'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  getCmsActionContext,
  requireAdmin,
} from '@/app/actions/cms/utils/fileHelpers';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
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
      newCategories: Array<{ name: string; tempId: number }>;
      newSkills: Array<{ categoryId: number; data: CreateSkillData }>;
      updateSkills: Array<{ id: number; data: UpdateSkillData }>;
      deleteSkills: number[];
      updateCategories: Array<{ id: number; data: UpdateCategoryData }>;
      deleteCategories: number[];
      categoryOrder: Array<{ id: number; position: number }>;
    };

type CreateSkillData = {
  title: string;
  icon: string;
  invert: boolean;
  category_id?: number;
  blurhashURL?: string;
};

type UpdateSkillData = {
  title?: string;
  category_id?: number;
  icon?: string;
  blurhashURL?: string;
  invert?: boolean;
};

type CreateCategoryData = {
  name: string;
};

type UpdateCategoryData = {
  name?: string;
  position?: number;
};

type SkillsResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

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

  return { isValid: true };
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
  try {
    await getCmsActionContext('admin');
    const admin = getAdminClient();
    const errors: string[] = [];
    const tempIdToRealId: Record<number, number> = {};

    for (const category of operation.newCategories) {
      if (!category.name || category.name.trim().length === 0) {
        errors.push('Category name is required');
        continue;
      }

      const { data, error } = await admin
        .from('skills_categories')
        .insert({ name: category.name.trim() })
        .select()
        .single();

      if (error) {
        errors.push(`Category "${category.name}": ${error.message}`);
      } else {
        tempIdToRealId[category.tempId] = data.id as number;
      }
    }

    for (const item of operation.newSkills) {
      const categoryId = tempIdToRealId[item.categoryId] ?? item.categoryId;
      const skillData = { ...item.data, category_id: categoryId };
      const validation = validateSkillData(skillData);
      if (!validation.isValid) {
        errors.push(`Skill "${skillData.title}": ${validation.error}`);
        continue;
      }

      const { error } = await admin.from('skills').insert(skillData);
      if (error) errors.push(`Skill "${skillData.title}": ${error.message}`);
    }

    if (operation.deleteSkills.length > 0) {
      const { error } = await admin
        .from('skills')
        .delete()
        .in('id', operation.deleteSkills);
      if (error) errors.push(`Delete skill: ${error.message}`);
    }

    for (const categoryId of operation.deleteCategories) {
      const { data: skills, error: skillsError } = await admin
        .from('skills')
        .select('id')
        .eq('category_id', categoryId);

      if (skillsError) {
        errors.push(`Delete category ${categoryId}: ${skillsError.message}`);
        continue;
      }

      if (skills && skills.length > 0) {
        errors.push(
          `Cannot delete category with ${skills.length} skill(s). Remove all skills first.`
        );
        continue;
      }

      const { error } = await admin
        .from('skills_categories')
        .delete()
        .eq('id', categoryId);
      if (error) errors.push(`Delete category ${categoryId}: ${error.message}`);
    }

    for (const item of operation.updateCategories) {
      const id = tempIdToRealId[item.id] ?? item.id;
      const updateFields: UpdateCategoryData = {};
      if (item.data.name !== undefined)
        updateFields.name = item.data.name.trim();
      if (item.data.position !== undefined)
        updateFields.position = item.data.position;

      const { error } = await admin
        .from('skills_categories')
        .update(updateFields)
        .eq('id', id);
      if (error) errors.push(`Category ${id}: ${error.message}`);
    }

    for (const item of operation.categoryOrder) {
      const id = tempIdToRealId[item.id] ?? item.id;
      const { error } = await admin
        .from('skills_categories')
        .update({ position: item.position })
        .eq('id', id);
      if (error) errors.push(`Reorder category ${id}: ${error.message}`);
    }

    for (const item of operation.updateSkills) {
      const validation = validateSkillData(item.data);
      if (!validation.isValid) {
        errors.push(`Skill ${item.id}: ${validation.error}`);
        continue;
      }

      const { error } = await admin
        .from('skills')
        .update(item.data)
        .eq('id', item.id);
      if (error) errors.push(`Skill ${item.id}: ${error.message}`);
    }

    if (
      operation.newCategories.length > 0 ||
      operation.newSkills.length > 0 ||
      operation.updateSkills.length > 0 ||
      operation.deleteSkills.length > 0 ||
      operation.updateCategories.length > 0 ||
      operation.deleteCategories.length > 0 ||
      operation.categoryOrder.length > 0
    ) {
      await invalidatePublicContent({ entity: 'skills', operation: 'publish' });
    }

    return {
      success: errors.length === 0,
      data: { tempIdToRealId },
      error: errors.length > 0 ? errors.join('\n') : undefined,
    };
  } catch (error) {
    console.error('Error batch publishing skills:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to publish skills',
    };
  }
}

async function getSkills(supabase: SupabaseClient): Promise<SkillsResult> {
  try {
    const { data, error } = await supabase.from('skills_categories').select(`
      *,
      skills (
        *,
        category_id
      )
    `);

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
    const validation = validateSkillData(skillData);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('skills')
      .insert(skillData)
      .select()
      .single();

    if (error) throw error;

    await invalidatePublicContent({ entity: 'skills', operation: 'create' });
    return { success: true, data };
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
    const validation = validateSkillData(updateData);
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
      .update(updateData)
      .eq('id', skillId)
      .select();

    if (error) throw error;

    await invalidatePublicContent({ entity: 'skills', operation: 'update' });
    return { success: true, data };
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

    await invalidatePublicContent({ entity: 'skills', operation: 'delete' });
    return { success: true };
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

    await invalidatePublicContent({ entity: 'skills', operation: 'create' });
    return { success: true, data };
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

    await invalidatePublicContent({ entity: 'skills', operation: 'update' });
    return { success: true, data };
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

    await invalidatePublicContent({ entity: 'skills', operation: 'delete' });
    return { success: true };
  } catch (error) {
    console.error('Error deleting category:', error);
    return {
      success: false,
      error: 'Failed to delete category',
    };
  }
}

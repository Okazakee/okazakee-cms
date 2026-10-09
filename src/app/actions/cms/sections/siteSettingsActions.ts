'use server';

import {
  getAdminClient,
  prepareImageUpload,
  removePublicFileIfPresent,
  removeStorageObjectBestEffort,
  requireAdmin,
  uploadImmutablePreparedImage,
} from '@/app/actions/cms/utils/fileHelpers';
import type { MutationResult } from '@/libs/cms/mutationResult';
import { getCmsStorageBucket } from '@/libs/cms/storage/bucket';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';

type SiteSettingsOperation =
  | { type: 'GET' }
  | { type: 'UPDATE_VAT'; vatNumber: string }
  | { type: 'UPLOAD_LOGO'; variant: 'dark' | 'light'; file: File }
  | { type: 'CLEAR_LOGO'; variant: 'dark' | 'light' };

export type SiteSettingsRow = {
  header_logo_dark: string | null;
  header_logo_light: string | null;
  footer_vat_number: string | null;
};

export type SiteSettingsResult = MutationResult;

const settingsRowId = 1;
const settingsColumns = 'header_logo_dark,header_logo_light,footer_vat_number';

function settingsRow(data: Partial<SiteSettingsRow> | null): SiteSettingsRow {
  return {
    header_logo_dark: data?.header_logo_dark ?? null,
    header_logo_light: data?.header_logo_light ?? null,
    footer_vat_number: normalizeVatNumber(data?.footer_vat_number),
  };
}

function normalizeVatNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

export async function siteSettingsActions(
  operation: SiteSettingsOperation
): Promise<SiteSettingsResult> {
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  try {
    const admin = getAdminClient();
    switch (operation.type) {
      case 'GET': {
        const { data, error } = await admin
          .from('site_settings')
          .select(settingsColumns)
          .eq('id', settingsRowId)
          .maybeSingle();
        if (error) throw error;
        return {
          success: true,
          data: settingsRow(data),
        };
      }
      case 'UPDATE_VAT': {
        const { data, error } = await admin
          .from('site_settings')
          .upsert({
            id: settingsRowId,
            footer_vat_number: normalizeVatNumber(operation.vatNumber),
          })
          .select(settingsColumns)
          .single();
        if (error || !data) {
          return {
            success: false,
            error: error?.message ?? 'Failed to save the VAT number',
          };
        }
        const revalidation = await invalidatePublicContent({
          entity: 'settings',
          operation: 'update',
        });
        return {
          success: true,
          data: settingsRow(data),
          revalidation,
        };
      }
      case 'UPLOAD_LOGO':
      case 'CLEAR_LOGO': {
        if (operation.variant !== 'dark' && operation.variant !== 'light') {
          return { success: false, error: 'Invalid logo variant' };
        }
        const column = `header_logo_${operation.variant}` as const;
        const bucket = getCmsStorageBucket();
        const { data: previous, error: readError } = await admin
          .from('site_settings')
          .select(settingsColumns)
          .eq('id', settingsRowId)
          .maybeSingle();
        if (readError) throw readError;
        let staged: { publicUrl: string; path: string } | null = null;
        if (operation.type === 'UPLOAD_LOGO') {
          const prepared = await prepareImageUpload(operation.file, undefined, {
            maxWidth: 1024,
            maxHeight: 256,
            quality: 90,
            fit: 'inside',
          });
          if (!prepared.success) return prepared;
          staged = await uploadImmutablePreparedImage(
            admin,
            bucket,
            `header/${operation.variant}`,
            `header-${operation.variant}`,
            prepared.image
          );
        }
        let committed: SiteSettingsRow;
        try {
          const { data, error } = await admin
            .from('site_settings')
            .upsert({ id: settingsRowId, [column]: staged?.publicUrl ?? null })
            .select(settingsColumns)
            .single();
          if (error || !data) {
            throw new Error(error?.message ?? 'Failed to save header image');
          }
          committed = settingsRow(data);
        } catch (error) {
          if (staged) {
            await removeStorageObjectBestEffort(admin, bucket, staged.path);
          }
          throw error;
        }
        await removePublicFileIfPresent(admin, previous?.[column], bucket);
        const revalidation = await invalidatePublicContent({
          entity: 'settings',
          operation: 'update',
        });
        return { success: true, data: committed, revalidation };
      }
      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    console.error('Site settings action error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

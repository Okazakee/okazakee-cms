'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminClient,
  prepareImageUpload,
  removePublicFileIfDifferent,
  removeStorageObjectBestEffort,
  requireAdmin,
  uploadImmutablePreparedImage,
  validateImageFile,
} from '@/app/actions/cms/utils/fileHelpers';
import { getCmsStorageBucket } from '@/libs/cms/storage/bucket';
import type { MutationResult } from '@/libs/cms/mutationResult';
import { invalidatePublicContent } from '@/libs/public-site/revalidation';
import {
  type NavAnchorDraft,
  normalizeLogoUrl,
  parseNavAnchorDrafts,
  validateNavAnchors,
} from '@/utils/cms/navAnchors';
import { createClient } from '@/utils/supabase/server';

/** The header logo variants; each theme resolves independently. */
export type LogoVariant = 'dark' | 'light';

type SiteSettingsOperation =
  | { type: 'GET' }
  | { type: 'UPLOAD_LOGO'; variant: LogoVariant; file: File }
  | { type: 'CLEAR_LOGO'; variant: LogoVariant }
  | { type: 'UPDATE_ANCHORS'; anchors: NavAnchorDraft[] }
  | { type: 'UPDATE_FOOTER'; name: string; vatNumber: string };

export type SiteSettingsRow = {
  header_logo_dark: string | null;
  header_logo_light: string | null;
  nav_anchors: NavAnchorDraft[];
  /** Footer display name; null falls back to the site's default name. */
  footer_name: string | null;
  /**
   * Footer VAT number, stored as text so a leading zero survives. It is
   * displayed verbatim and never parsed, so no country/checksum rules apply.
   */
  footer_vat_number: string | null;
};

export type SiteSettingsResult = MutationResult;

/** The header is a singleton: one row, id 1. */
const SETTINGS_ROW_ID = 1;

/**
 * Every column a write reads back and a caller syncs from. A write that
 * returned less would make an editor silently drop the fields it does not
 * edit, because the committed row is the only evidence of the write.
 */
const settingsColumns =
  'header_logo_dark, header_logo_light, nav_anchors, footer_name, footer_vat_number';

/** Blank (or non-text) footer input means "never configured". */
function normalizeFooterText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toSettingsRow(data: unknown): SiteSettingsRow | null {
  const row = data as {
    header_logo_dark?: unknown;
    header_logo_light?: unknown;
    nav_anchors?: unknown;
    footer_name?: unknown;
    footer_vat_number?: unknown;
  } | null;
  if (!row) return null;

  const anchors = validateNavAnchors(row.nav_anchors ?? null);
  return {
    header_logo_dark: normalizeLogoUrl(row.header_logo_dark),
    header_logo_light: normalizeLogoUrl(row.header_logo_light),
    nav_anchors: anchors.isValid ? anchors.anchors : [],
    footer_name: normalizeFooterText(row.footer_name),
    footer_vat_number: normalizeFooterText(row.footer_vat_number),
  };
}

const logoColumn = (variant: LogoVariant) =>
  variant === 'dark' ? 'header_logo_dark' : 'header_logo_light';

const logoLabel = (variant: LogoVariant) =>
  variant === 'dark' ? 'Dark theme logo' : 'Light theme logo';

export async function siteSettingsActions(
  operation: SiteSettingsOperation
): Promise<SiteSettingsResult> {
  try {
    await requireAdmin();
  } catch {
    return { success: false, error: 'Unauthorized: Admin access required' };
  }

  const supabase = await createClient();

  try {
    switch (operation.type) {
      case 'GET':
        return await getSiteSettings(supabase);
      case 'UPLOAD_LOGO':
        return await uploadLogo(operation.variant, operation.file);
      case 'CLEAR_LOGO':
        return await clearLogo(operation.variant);
      case 'UPDATE_ANCHORS':
        return await updateAnchors(operation.anchors);
      case 'UPDATE_FOOTER':
        return await updateFooter(operation.name, operation.vatNumber);
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

/** Uncached direct read: editors must see current DB state immediately. */
async function getSiteSettings(
  supabase: SupabaseClient
): Promise<SiteSettingsResult> {
  // No row yet is a valid state: every column reads as "never configured".
  return { success: true, data: await readSettingsRow(supabase) };
}

/**
 * Storage ordering invariant: validate → upload (unique immutable path) →
 * commit the DB row → remove the previous object best-effort AFTER the commit.
 * A failed commit would otherwise leave the header pointing at a deleted file.
 */
async function uploadLogo(
  variant: LogoVariant,
  file: File
): Promise<SiteSettingsResult> {
  const fileValidation = validateImageFile(file);
  if (!fileValidation.isValid) {
    return { success: false, error: fileValidation.error };
  }

  const admin = getAdminClient();
  const bucket = getCmsStorageBucket();
  const column = logoColumn(variant);
  const prepared = await prepareImageUpload(file, undefined, {
    maxWidth: 1024,
    maxHeight: 256,
    quality: 90,
  });
  if (!prepared.success) {
    return { success: false, error: prepared.error };
  }

  // Trusted replacement source: read the previous value from the DB rather
  // than trusting the client payload.
  const previous = await readSettingsRow(admin);

  const upload = await uploadImmutablePreparedImage(
    admin,
    bucket,
    'Website Assets/header',
    logoLabel(variant).toLowerCase().replace(/\s+/g, '-'),
    prepared.image
  );

  // Canonical stored value: cache-busted public URL, so the public site picks
  // the new object up instead of the CDN's copy of the previous one.
  const logoUrl = `${upload.publicUrl}?t=${Date.now()}`;

  const { data, error: commitError } = await admin
    .from('site_settings')
    .upsert({ ...previous, id: SETTINGS_ROW_ID, [column]: logoUrl })
    .select(settingsColumns)
    .single();

  if (commitError || !data) {
    // The DB never referenced the new object; drop it.
    await removeStorageObjectBestEffort(admin, bucket, upload.path);
    return {
      success: false,
      error: commitError?.message ?? 'Failed to save the header logo',
    };
  }

  await removePublicFileIfDifferent(
    admin,
    previous[column],
    bucket,
    upload.path
  );

  const revalidation = await invalidatePublicContent({
    entity: 'settings',
    operation: 'asset-update',
  });

  return {
    success: true,
    // Evidence of the committed row, not of the upload.
    data: toSettingsRow(data),
    revalidation,
  };
}

/**
 * Clearing a logo commits the NULL first and only then removes the object, so
 * a crash between the two leaves an orphaned file rather than a header that
 * points at nothing.
 */
async function clearLogo(variant: LogoVariant): Promise<SiteSettingsResult> {
  const admin = getAdminClient();
  const bucket = getCmsStorageBucket();
  const column = logoColumn(variant);
  const previous = await readSettingsRow(admin);

  const { data, error: commitError } = await admin
    .from('site_settings')
    .upsert({ ...previous, id: SETTINGS_ROW_ID, [column]: null })
    .select(settingsColumns)
    .single();

  if (commitError || !data) {
    return {
      success: false,
      error: commitError?.message ?? 'Failed to clear the header logo',
    };
  }

  if (previous[column]) {
    await removePublicFileIfDifferent(admin, previous[column], bucket, '');
  }

  const revalidation = await invalidatePublicContent({
    entity: 'settings',
    operation: 'asset-update',
  });

  return { success: true, data: toSettingsRow(data), revalidation };
}

/**
 * Writes the six anchors as one ordered jsonb array, index-aligned with
 * `header.buttons.N`. The whole row is upserted so an unrelated logo write is
 * never dropped by a partial update.
 */
async function updateAnchors(
  anchors: NavAnchorDraft[]
): Promise<SiteSettingsResult> {
  const validation = validateNavAnchors(anchors);
  if (!validation.isValid) {
    return { success: false, error: validation.error };
  }

  const admin = getAdminClient();
  const previous = await readSettingsRow(admin);

  const { data, error: commitError } = await admin
    .from('site_settings')
    .upsert({
      ...previous,
      id: SETTINGS_ROW_ID,
      nav_anchors: validation.anchors,
    })
    .select(settingsColumns)
    .single();

  if (commitError || !data) {
    return {
      success: false,
      error: commitError?.message ?? 'Failed to save the navigation anchors',
    };
  }

  const revalidation = await invalidatePublicContent({
    entity: 'settings',
    operation: 'update',
  });

  return { success: true, data: toSettingsRow(data), revalidation };
}

/**
 * Writes the footer identity. Both values are text: the VAT number keeps its
 * leading zeros, and neither is parsed, so there is no country or checksum
 * rule to enforce. Blank input clears the field, which the site renders as its
 * own default. The whole row is upserted from the trusted read, so this never
 * drops an unrelated logo or anchor edit.
 */
async function updateFooter(
  name: string,
  vatNumber: string
): Promise<SiteSettingsResult> {
  const admin = getAdminClient();
  const previous = await readSettingsRow(admin);

  const { data, error: commitError } = await admin
    .from('site_settings')
    .upsert({
      ...previous,
      id: SETTINGS_ROW_ID,
      footer_name: normalizeFooterText(name),
      footer_vat_number: normalizeFooterText(vatNumber),
    })
    .select(settingsColumns)
    .single();

  if (commitError || !data) {
    return {
      success: false,
      error: commitError?.message ?? 'Failed to save the footer identity',
    };
  }

  const revalidation = await invalidatePublicContent({
    entity: 'settings',
    operation: 'update',
  });

  return { success: true, data: toSettingsRow(data), revalidation };
}

/**
 * The current row, defaulted to "never configured" for a table that may not
 * have a row yet. Every write is an upsert, so a write must always carry every
 * column it does not intend to change — hence the full-column read.
 */
async function readSettingsRow(
  admin: SupabaseClient
): Promise<SiteSettingsRow> {
  const { data, error } = await admin
    .from('site_settings')
    .select(settingsColumns)
    .eq('id', SETTINGS_ROW_ID)
    .maybeSingle();

  if (error) throw error;

  return (
    toSettingsRow(data) ?? {
      header_logo_dark: null,
      header_logo_light: null,
      nav_anchors: parseNavAnchorDrafts(null),
      footer_name: null,
      footer_vat_number: null,
    }
  );
}

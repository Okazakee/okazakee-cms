import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteSettingsRow } from '@/app/actions/cms/sections/siteSettingsActions';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  invalidate: vi.fn(async () => 'sent' as const),
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.fake.client,
}));
vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.fake.client,
}));
vi.mock('@/libs/public-site/revalidation', () => ({
  invalidatePublicContent: h.invalidate,
}));

import { siteSettingsActions } from '@/app/actions/cms/sections/siteSettingsActions';

const admin = [{ email: 'admin@example.com', role: 'admin' }];
const editor = [{ email: 'admin@example.com', role: 'editor' }];
const nullLogos = { header_logo_dark: null, header_logo_light: null };
const oldPath = 'header/dark/previous.webp';
const oldUrl = `https://fake.supabase.co/storage/v1/object/public/website-dev/${oldPath}`;

async function logoFile() {
  const bytes = await sharp({
    create: { width: 32, height: 16, channels: 4, background: '#ff00ff' },
  })
    .png()
    .toBuffer();
  return new File([new Uint8Array(bytes)], 'logo.png', { type: 'image/png' });
}

beforeEach(() => {
  h.invalidate.mockClear();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
});

describe('siteSettingsActions', () => {
  it('reads a null VAT when the singleton does not exist', async () => {
    h.fake = createFakeSupabase({
      tables: { cms_allowed_users: admin, site_settings: [] },
    });
    const result = await siteSettingsActions({ type: 'GET' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ...nullLogos, footer_vat_number: null });
  });

  it('commits and returns textual VAT evidence with leading zeroes', async () => {
    h.fake = createFakeSupabase({
      tables: { cms_allowed_users: admin, site_settings: [] },
    });
    const result = await siteSettingsActions({
      type: 'UPDATE_VAT',
      vatNumber: ' 00123456789 ',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ...nullLogos,
      footer_vat_number: '00123456789',
    });
    expect(h.fake.state.tables.site_settings?.[0]?.footer_vat_number).toBe(
      '00123456789'
    );
    expect(result.revalidation).toBe('sent');
    expect(h.invalidate).toHaveBeenCalledWith({
      entity: 'settings',
      operation: 'update',
    });
    const read = await siteSettingsActions({ type: 'GET' });
    expect((read.data as SiteSettingsRow).footer_vat_number).toBe(
      '00123456789'
    );
    expect(h.fake.state.uploads).toEqual([]);
    expect(h.fake.state.removed).toEqual([]);
  });

  it('commits null for a blank VAT so the site restores its default', async () => {
    h.fake = createFakeSupabase({
      tables: {
        cms_allowed_users: admin,
        site_settings: [{ id: 1, footer_vat_number: '00123456789' }],
      },
    });
    const result = await siteSettingsActions({
      type: 'UPDATE_VAT',
      vatNumber: '   ',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ...nullLogos, footer_vat_number: null });
    expect(
      h.fake.state.tables.site_settings?.[0]?.footer_vat_number
    ).toBeNull();
  });

  it('does not claim a rejected database write or invalidate it', async () => {
    h.fake = createFakeSupabase({
      tables: { cms_allowed_users: admin, site_settings: [] },
      failNext: { table: 'site_settings', mode: 'upsert', message: 'db down' },
    });
    const result = await siteSettingsActions({
      type: 'UPDATE_VAT',
      vatNumber: '00123456789',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('db down');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it.each(['GET', 'UPDATE_VAT'] as const)(
    'rejects an editor before accessing settings for %s',
    async (type) => {
      h.fake = createFakeSupabase({
        tables: { cms_allowed_users: editor, site_settings: [] },
      });
      const result = await siteSettingsActions(
        type === 'GET' ? { type } : { type, vatNumber: '00123456789' }
      );
      expect(result.success).toBe(false);
      expect(
        h.fake.state.log.some((entry) => entry.table === 'site_settings')
      ).toBe(false);
      expect(h.invalidate).not.toHaveBeenCalled();
    }
  );
  it('rejects invalid images without uploading or modifying settings', async () => {
    h.fake = createFakeSupabase({
      tables: { cms_allowed_users: admin, site_settings: [] },
    });
    const result = await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: new File(['bad'], 'file.txt', { type: 'text/plain' }),
    });
    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toEqual([]);
    expect(h.fake.state.tables.site_settings).toEqual([]);
  });

  it.each(['dark', 'light'] as const)(
    'rejects editor image mutations for %s',
    async (variant) => {
      h.fake = createFakeSupabase({
        tables: { cms_allowed_users: editor, site_settings: [] },
      });
      expect(
        (
          await siteSettingsActions({
            type: 'UPLOAD_LOGO',
            variant,
            file: await logoFile(),
          })
        ).success
      ).toBe(false);
      expect(
        (await siteSettingsActions({ type: 'CLEAR_LOGO', variant })).success
      ).toBe(false);
      expect(h.fake.state.uploads).toEqual([]);
      expect(
        h.fake.state.log.some((entry) => entry.table === 'site_settings')
      ).toBe(false);
    }
  );

  it.each([false, true])(
    'rolls back staged replacement on DB failure (throws=%s)',
    async (throws) => {
      h.fake = createFakeSupabase({
        tables: {
          cms_allowed_users: admin,
          site_settings: [
            {
              id: 1,
              header_logo_dark: oldUrl,
              header_logo_light: 'light',
              footer_vat_number: '001',
            },
          ],
        },
        failNext: {
          table: 'site_settings',
          mode: 'upsert',
          message: 'db down',
          throws,
        },
      });
      h.fake.state.objects[`website-dev/${oldPath}`] = 'old';
      const result = await siteSettingsActions({
        type: 'UPLOAD_LOGO',
        variant: 'dark',
        file: await logoFile(),
      });
      expect(result.success).toBe(false);
      expect(h.fake.state.removed).toEqual(h.fake.state.uploads);
      expect(h.fake.state.objects[`website-dev/${oldPath}`]).toBe('old');
      expect(h.fake.state.tables.site_settings[0].header_logo_dark).toBe(
        oldUrl
      );
      expect(h.invalidate).not.toHaveBeenCalled();
    }
  );

  it('commits immutable variants independently and preserves VAT on replacement', async () => {
    h.fake = createFakeSupabase({
      tables: {
        cms_allowed_users: admin,
        site_settings: [
          {
            id: 1,
            header_logo_dark: oldUrl,
            header_logo_light: null,
            footer_vat_number: '001',
          },
        ],
      },
    });
    h.fake.state.objects[`website-dev/${oldPath}`] = 'old';
    const originalStorage = h.fake.client.storage.from.bind(
      h.fake.client.storage
    );
    const remove = vi.spyOn(h.fake.client.storage, 'from');
    remove.mockImplementation((bucket) => {
      const storage = originalStorage(bucket);
      const originalRemove = storage.remove.bind(storage);
      vi.spyOn(storage, 'remove').mockImplementation(async (paths) => {
        expect(h.fake.state.tables.site_settings[0].header_logo_dark).not.toBe(
          oldUrl
        );
        return originalRemove(paths);
      });
      return storage;
    });
    const dark = await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: await logoFile(),
    });
    expect(dark.success).toBe(true);
    expect(h.fake.state.uploads[0]).toMatch(
      /^header\/dark\/.+-header-dark\.webp$/
    );
    expect(h.fake.state.removed).toEqual([oldPath]);
    const darkUrl = (dark.data as SiteSettingsRow).header_logo_dark;
    const light = await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'light',
      file: await logoFile(),
    });
    expect(light.data).toMatchObject({
      header_logo_dark: darkUrl,
      footer_vat_number: '001',
    });
    expect(h.fake.state.uploads[1]).toMatch(
      /^header\/light\/.+-header-light\.webp$/
    );
    const vat = await siteSettingsActions({
      type: 'UPDATE_VAT',
      vatNumber: '002',
    });
    expect(vat.data).toMatchObject({
      header_logo_dark: darkUrl,
      header_logo_light: (light.data as SiteSettingsRow).header_logo_light,
      footer_vat_number: '002',
    });
    remove.mockRestore();
  });

  it.each([
    [oldUrl, [oldPath]],
    ['https://external.example/logo.png', []],
    [
      'https://fake.supabase.co/storage/v1/object/public/website/header/dark/x.webp',
      [],
    ],
    [
      'https://forged.example/storage/v1/object/public/website-dev/header/dark/x.webp',
      [],
    ],
  ])('clears the database before safe cleanup for %s', async (url, removed) => {
    h.fake = createFakeSupabase({
      tables: {
        cms_allowed_users: admin,
        site_settings: [
          {
            id: 1,
            header_logo_dark: url,
            header_logo_light: 'light',
            footer_vat_number: '001',
          },
        ],
      },
    });
    const originalStorage = h.fake.client.storage.from.bind(
      h.fake.client.storage
    );
    const storageSpy = vi.spyOn(h.fake.client.storage, 'from');
    storageSpy.mockImplementation((bucket) => {
      const storage = originalStorage(bucket);
      const originalRemove = storage.remove.bind(storage);
      vi.spyOn(storage, 'remove').mockImplementation(async (paths) => {
        expect(
          h.fake.state.tables.site_settings[0].header_logo_dark
        ).toBeNull();
        return originalRemove(paths);
      });
      return storage;
    });
    const result = await siteSettingsActions({
      type: 'CLEAR_LOGO',
      variant: 'dark',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      header_logo_dark: null,
      header_logo_light: 'light',
      footer_vat_number: '001',
    });
    expect(h.fake.state.removed).toEqual(removed);
    storageSpy.mockRestore();
  });
  it('retains the owned object when clearing fails to commit', async () => {
    h.fake = createFakeSupabase({
      tables: {
        cms_allowed_users: admin,
        site_settings: [
          {
            id: 1,
            header_logo_dark: oldUrl,
          },
        ],
      },
      failNext: { table: 'site_settings', mode: 'upsert', message: 'db down' },
    });
    const result = await siteSettingsActions({
      type: 'CLEAR_LOGO',
      variant: 'dark',
    });
    expect(result.success).toBe(false);
    expect(h.fake.state.tables.site_settings[0].header_logo_dark).toBe(oldUrl);
    expect(h.fake.state.removed).toEqual([]);
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

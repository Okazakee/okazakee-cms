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

vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({ hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })),
}));

import { siteSettingsActions } from '@/app/actions/cms/sections/siteSettingsActions';

// The fake Supabase user's email must match the allowlist row it is checked
// against, so both fixtures share that address and differ only by role.
const ADMIN = [{ email: 'admin@example.com', role: 'admin' }];
const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];

function webpFile(name = 'logo.webp'): File {
  return new File(
    [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])],
    name,
    { type: 'image/webp' }
  );
}

function makeFake(
  tables: Record<string, Array<Record<string, unknown>>>,
  extra: Partial<Parameters<typeof createFakeSupabase>[0]> = {}
) {
  return createFakeSupabase({ tables, ...extra });
}

function storedRow() {
  return h.fake.state.tables.site_settings?.[0];
}

beforeEach(() => {
  h.invalidate.mockClear();
});

describe('siteSettingsActions GET', () => {
  it('reads "never configured" defaults when no row exists yet', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    const result = await siteSettingsActions({ type: 'GET' });

    expect(result.success).toBe(true);
    const data = result.data as SiteSettingsRow;
    expect(data.header_logo_dark).toBeNull();
    expect(data.header_logo_light).toBeNull();
    // Unconfigured footer identity: the site renders its own default.
    expect(data.footer_name).toBeNull();
    expect(data.footer_vat_number).toBeNull();
    expect(data.nav_anchors.map((entry) => entry.anchor)).toEqual([
      'home',
      'skills',
      'career',
      'portfolio',
      'blog',
      'contacts',
    ]);
  });

  it('rejects a non-admin caller before touching the table', async () => {
    h.fake = makeFake({ cms_allowed_users: EDITOR, site_settings: [] });

    const result = await siteSettingsActions({ type: 'GET' });

    expect(result.success).toBe(false);
    // Only the allowlist lookup: the settings table is never reached.
    expect(
      h.fake.state.log.some((entry) => entry.table === 'site_settings')
    ).toBe(false);
  });
});

describe('siteSettingsActions UPLOAD_LOGO', () => {
  it('commits the row and returns it as evidence of the write', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    const result = await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile(),
    });

    expect(result.success).toBe(true);
    const data = result.data as SiteSettingsRow;
    expect(data.header_logo_dark).toMatch(/^https:\/\/fake\.supabase\.co\//);
    expect(data.header_logo_light).toBeNull();
    expect(storedRow()?.header_logo_dark).toBe(data.header_logo_dark);
    expect(result.revalidation).toBe('sent');
    expect(h.invalidate).toHaveBeenCalledWith({
      entity: 'settings',
      operation: 'asset-update',
    });
  });

  it('resolves the two variants independently', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'light',
      file: webpFile('light.webp'),
    });

    const data = storedRow();
    expect(data?.header_logo_light).toBeTruthy();
    expect(data?.header_logo_dark).toBeNull();
  });

  it('rejects a non-image without uploading or writing anything', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    const result = await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: new File([new Uint8Array([1])], 'note.txt', {
        type: 'text/plain',
      }),
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toEqual([]);
    expect(
      h.fake.state.log.some((entry) => entry.table === 'site_settings')
    ).toBe(false);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('removes the staged object when the DB commit fails', async () => {
    h.fake = makeFake(
      { cms_allowed_users: ADMIN, site_settings: [] },
      {
        failNext: {
          table: 'site_settings',
          mode: 'upsert',
          message: 'db down',
        },
      }
    );

    const result = await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile(),
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toHaveLength(1);
    expect(h.fake.state.removed).toEqual(h.fake.state.uploads);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('removes the previous object only after the replacement is committed', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile('first.webp'),
    });
    const first = storedRow()?.header_logo_dark as string;

    const order = h.fake.state.log.map((entry) => entry.mode);
    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile('second.webp'),
    });

    expect(order).toContain('upsert');
    expect(storedRow()?.header_logo_dark).not.toBe(first);
    const firstPath = decodeURIComponent(
      new URL(first).pathname.split('/website/')[1]
    );
    expect(h.fake.state.removed).toContain(firstPath);
  });
});

describe('siteSettingsActions CLEAR_LOGO', () => {
  it('commits the null before removing the stored object', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile(),
    });
    const stored = storedRow()?.header_logo_dark as string;

    const result = await siteSettingsActions({
      type: 'CLEAR_LOGO',
      variant: 'dark',
    });

    expect(result.success).toBe(true);
    expect((result.data as SiteSettingsRow).header_logo_dark).toBeNull();
    expect(storedRow()?.header_logo_dark).toBeNull();
    expect(h.fake.state.removed).toContain(
      decodeURIComponent(new URL(stored).pathname.split('/website/')[1])
    );
  });

  it('leaves the other variant untouched', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'light',
      file: webpFile(),
    });
    const light = storedRow()?.header_logo_light as string;

    await siteSettingsActions({ type: 'CLEAR_LOGO', variant: 'dark' });

    expect(storedRow()?.header_logo_light).toBe(light);
  });
});

describe('siteSettingsActions UPDATE_ANCHORS', () => {
  const anchors = [
    { id: 'home', anchor: 'top' },
    { id: 'skills', anchor: 'skills' },
    { id: 'career', anchor: 'work-history' },
    { id: 'portfolio', anchor: 'portfolio' },
    { id: 'blog', anchor: 'writing' },
    { id: 'contacts', anchor: 'contacts' },
  ] as const;

  it('stores the anchors index-aligned with header.buttons.N', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    const result = await siteSettingsActions({
      type: 'UPDATE_ANCHORS',
      anchors: [...anchors],
    });

    expect(result.success).toBe(true);
    expect(storedRow()?.nav_anchors).toEqual([...anchors]);
    expect(h.invalidate).toHaveBeenCalledWith({
      entity: 'settings',
      operation: 'update',
    });
  });

  it('rejects an unusable anchor without writing', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    const result = await siteSettingsActions({
      type: 'UPDATE_ANCHORS',
      anchors: [{ id: 'blog', anchor: '/blog' }] as never,
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.log.some((entry) => entry.mode === 'upsert')).toBe(
      false
    );
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('does not drop a stored logo when only the anchors change', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile(),
    });
    const logo = storedRow()?.header_logo_dark;

    await siteSettingsActions({
      type: 'UPDATE_ANCHORS',
      anchors: [...anchors],
    });

    expect(storedRow()?.header_logo_dark).toBe(logo);
  });

  it('restores the default hrefs when every anchor is cleared', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPDATE_ANCHORS',
      anchors: [...anchors],
    });

    const result = await siteSettingsActions({
      type: 'UPDATE_ANCHORS',
      anchors: [
        { id: 'home', anchor: '' },
        { id: 'skills', anchor: '' },
        { id: 'career', anchor: '' },
        { id: 'portfolio', anchor: '' },
        { id: 'blog', anchor: '' },
        { id: 'contacts', anchor: '' },
      ],
    });

    expect(result.success).toBe(true);
    expect(
      (result.data as SiteSettingsRow).nav_anchors.map((entry) => entry.anchor)
    ).toEqual(['home', 'skills', 'career', 'portfolio', 'blog', 'contacts']);
  });
});

describe('siteSettingsActions UPDATE_FOOTER', () => {
  it('stores the display name and the VAT number with its leading zero', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });

    const result = await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: 'Okazakee',
      vatNumber: '02863310815',
    });

    expect(result.success).toBe(true);
    expect(storedRow()?.footer_name).toBe('Okazakee');
    expect(storedRow()?.footer_vat_number).toBe('02863310815');
    expect(h.invalidate).toHaveBeenCalledWith({
      entity: 'settings',
      operation: 'update',
    });
  });

  it('reads the stored identity back through GET', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: 'Okazakee',
      vatNumber: '02863310815',
    });

    const result = await siteSettingsActions({ type: 'GET' });

    const data = result.data as SiteSettingsRow;
    expect(data.footer_name).toBe('Okazakee');
    expect(data.footer_vat_number).toBe('02863310815');
  });

  it('clears a field the editor blanked, so the site falls back to its default', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: 'Okazakee',
      vatNumber: '02863310815',
    });

    const result = await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: '   ',
      vatNumber: '',
    });

    expect(result.success).toBe(true);
    expect(storedRow()?.footer_name).toBeNull();
    expect(storedRow()?.footer_vat_number).toBeNull();
    const data = result.data as SiteSettingsRow;
    expect(data.footer_name).toBeNull();
    expect(data.footer_vat_number).toBeNull();
  });

  it('keeps the identity through a logo write and an anchor write', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, site_settings: [] });
    await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: 'Okazakee',
      vatNumber: '02863310815',
    });

    await siteSettingsActions({
      type: 'UPLOAD_LOGO',
      variant: 'dark',
      file: webpFile(),
    });
    await siteSettingsActions({
      type: 'CLEAR_LOGO',
      variant: 'light',
    });
    const anchors = [
      { id: 'home', anchor: 'top' },
      { id: 'skills', anchor: 'skills' },
      { id: 'career', anchor: 'work-history' },
      { id: 'portfolio', anchor: 'portfolio' },
      { id: 'blog', anchor: 'writing' },
      { id: 'contacts', anchor: 'contacts' },
    ] as const;
    const result = await siteSettingsActions({
      type: 'UPDATE_ANCHORS',
      anchors: [...anchors],
    });

    expect(result.success).toBe(true);
    expect(storedRow()?.footer_name).toBe('Okazakee');
    expect(storedRow()?.footer_vat_number).toBe('02863310815');
    const data = result.data as SiteSettingsRow;
    expect(data.footer_name).toBe('Okazakee');
    expect(data.footer_vat_number).toBe('02863310815');
  });

  it('does not claim a save the database refused', async () => {
    h.fake = makeFake(
      { cms_allowed_users: ADMIN, site_settings: [] },
      {
        failNext: {
          table: 'site_settings',
          mode: 'upsert',
          message: 'db down',
        },
      }
    );

    const result = await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: 'Okazakee',
      vatNumber: '02863310815',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('db down');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller before touching the table', async () => {
    h.fake = makeFake({ cms_allowed_users: EDITOR, site_settings: [] });

    const result = await siteSettingsActions({
      type: 'UPDATE_FOOTER',
      name: 'Okazakee',
      vatNumber: '02863310815',
    });

    expect(result.success).toBe(false);
    expect(
      h.fake.state.log.some((entry) => entry.table === 'site_settings')
    ).toBe(false);
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

/**
 * Portfolio dual-write integration (Phase 7B), mirroring the Phase 7A blog
 * suite against the shared fake Supabase / fake Storage harness.
 */

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
vi.mock('next/cache', () => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({ hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })),
}));

import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import { sha256Hex } from '@/libs/cms/storage/bodyContent';
import { portfolioActions } from '@/app/actions/cms/sections/portfolioActions';
import type { PostButton } from '@/utils/cms/postButtons';

const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];
const CONTENT = 'website-content-dev/';

function webpFile(name = 'cover.webp'): File {
  return new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], name, {
    type: 'image/webp',
  });
}

const BUTTONS: PostButton[] = [
  { kind: 'website', url: '  https://example.test  ' },
];

function portfolioCreate(
  bodyEn = '# en body',
  bodyIt = '# it body',
  extra: Record<string, unknown> = {}
) {
  return {
    data: {
      title_en: 'Project',
      title_it: 'Progetto',
      image: '',
      description_en: 'd',
      description_it: 'd',
      body_en: bodyEn,
      body_it: bodyIt,
      blurhashURL: '',
      post_tags: '',
      author_id: 'user-1',
      buttons: BUTTONS,
      ...extra,
    },
    file: webpFile(),
    tempId: 'p1',
  };
}

function fake(
  tables: Record<string, Array<Record<string, unknown>>> = {},
  extra: Partial<Parameters<typeof createFakeSupabase>[0]> = {}
): FakeSupabase {
  return createFakeSupabase({
    tables: { cms_allowed_users: EDITOR, ...tables },
    ...extra,
  });
}

function contentObjectKeys(store: FakeSupabase): string[] {
  return Object.keys(store.state.objects).filter((key) => key.startsWith(CONTENT));
}

beforeEach(() => {
  h.invalidate.mockClear();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
  vi.stubEnv('APP_ENV', 'development');
  vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'false');
});

describe('portfolio dual-write: feature isolation', () => {
  it('is disabled by default: no pointers, no content-bucket objects', async () => {
    h.fake = fake({ portfolio_posts: [] });
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toBeUndefined();
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('enabled in dev stores portfolio paths, preserves visibility and normalizes buttons', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate('# en final', '# it final', { hidden: true })],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    const id = row?.id as number;
    expect(row?.body_en_path).toMatch(
      new RegExp(`^portfolio/${id}/en/[0-9a-f]{64}\\.md$`)
    );
    expect(row?.body_it_path).toMatch(
      new RegExp(`^portfolio/${id}/it/[0-9a-f]{64}\\.md$`)
    );
    // Intended draft visibility preserved.
    expect(row?.hidden).toBe(true);
    const insert = h.fake.state.log.find((entry) => entry.mode === 'insert');
    expect((insert?.payload as { hidden?: boolean } | undefined)?.hidden).toBe(
      true
    );
    // Normalized buttons persisted unchanged by dual-write.
    const buttons = row?.buttons as Array<{ kind: string; url: string }>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.kind).toBe('website');
    expect(buttons[0]?.url).toBe('https://example.test');
    // Exact final bytes stored.
    const enKey = `${CONTENT}${row?.body_en_path as string}`;
    expect(Buffer.from(h.fake.state.objects[enKey] as Buffer).toString('utf8')).toBe(
      '# en final'
    );
  });

  it('rejects an enabled flag in production before any mutation', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    h.fake = fake({ portfolio_posts: [] });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.log).toEqual([]);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('keeps production legacy-only and never references pointer columns', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
    h.fake = fake({ portfolio_posts: [] });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toBeUndefined();
    expect(contentObjectKeys(h.fake)).toEqual([]);
    for (const entry of h.fake.state.log) {
      expect(JSON.stringify(entry.payload ?? {})).not.toContain('body_en_path');
    }
  });

  it('clears the modified language pointer when disabled in the dev clone', async () => {
    h.fake = fake({
      portfolio_posts: [
        {
          id: 4,
          title_en: 'T',
          body_en: '# old en',
          body_it: '# old it',
          body_en_path: `portfolio/4/en/${'a'.repeat(64)}.md`,
          body_it_path: `portfolio/4/it/${'b'.repeat(64)}.md`,
          image: '',
          buttons: [],
          hidden: false,
        },
      ],
    });

    const result = await portfolioActions({
      type: 'UPDATE',
      id: 4,
      data: { body_en: '# new en' },
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toBeNull();
    // The untouched language keeps its pointer.
    expect(row?.body_it_path).toBe(`portfolio/4/it/${'b'.repeat(64)}.md`);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });
});

describe('portfolio dual-write: batch update', () => {
  const seeded = () => ({
    portfolio_posts: [
      {
        id: 11,
        title_en: 'T',
        body_en: '# old en',
        body_it: '# old it',
        body_en_path: `portfolio/11/en/${'a'.repeat(64)}.md`,
        body_it_path: `portfolio/11/it/${'b'.repeat(64)}.md`,
        image: '',
        buttons: [],
        hidden: false,
      },
    ],
  });
  const update = (data: Record<string, unknown>) => ({
    id: 11,
    data,
    currentImageUrl: undefined,
  });

  it('replaces only the changed language pointer (EN)', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toMatch(/^portfolio\/11\/en\/[0-9a-f]{64}\.md$/);
    expect(row?.body_it_path).toBe(`portfolio/11/it/${'b'.repeat(64)}.md`);
  });

  it('replaces only the changed language pointer (IT)', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_it: '# new it' })],
      deletes: [],
    });
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_it_path).toMatch(/^portfolio\/11\/it\/[0-9a-f]{64}\.md$/);
    expect(row?.body_en_path).toBe(`portfolio/11/en/${'a'.repeat(64)}.md`);
  });

  it('makes no Storage call for a metadata-only update', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ title_en: 'Renamed' })],
      deletes: [],
    });
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('initialises a NULL pointer when the body is supplied', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({
      portfolio_posts: [
        {
          id: 11,
          title_en: 'T',
          body_en: '# old en',
          body_it: '# old it',
          body_en_path: null,
          body_it_path: null,
          image: '',
          buttons: [],
          hidden: false,
        },
      ],
    });
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toMatch(/^portfolio\/11\/en\/[0-9a-f]{64}\.md$/);
  });

  it('reuses an existing correct pointer without uploading', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());
    // Seed the exact object the unchanged body already maps to by first saving.
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# old en' })],
      deletes: [],
    });
    const firstPath = h.fake.state.tables.portfolio_posts[0]?.body_en_path;
    const uploadsAfterFirst = contentObjectKeys(h.fake).length;
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# old en' })],
      deletes: [],
    });
    expect(h.fake.state.tables.portfolio_posts[0]?.body_en_path).toBe(firstPath);
    expect(contentObjectKeys(h.fake)).toHaveLength(uploadsAfterFirst);
  });

  it('leaves the DB unchanged when the Markdown upload fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded(), {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });
    expect(result.success).toBe(false);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_en_path).toBe(`portfolio/11/en/${'a'.repeat(64)}.md`);
  });

  it('leaves old pointers authoritative when the DB commit fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded(), {
      failNext: { table: 'portfolio_posts', mode: 'update', message: 'db down' },
    });
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ body_en: '# new en' })],
      deletes: [],
    });
    expect(result.success).toBe(false);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_en_path).toBe(`portfolio/11/en/${'a'.repeat(64)}.md`);
  });

  it('preserves buttons normalization on an unrelated update', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seeded());
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [update({ buttons: BUTTONS, title_en: 'Renamed' })],
      deletes: [],
    });
    const buttons = h.fake.state.tables.portfolio_posts[0]?.buttons as Array<{
      kind: string;
      url: string;
    }>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.url).toBe('https://example.test');
  });
});

describe('portfolio dual-write: single-shot paths', () => {
  it('creates with pointers and returns the committed row', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] });
    const result = await portfolioActions({
      type: 'CREATE',
      data: {
        title_en: 'T',
        title_it: 'T',
        image: 'https://x.test/a.webp',
        description_en: 'd',
        description_it: 'd',
        body_en: '# single en',
        body_it: '# single it',
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
        buttons: BUTTONS,
        hidden: false,
      },
    });
    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toMatch(/^portfolio\/\d+\/en\/[0-9a-f]{64}\.md$/);
    expect(row?.hidden).toBe(false);
  });

  it('preserves the omitted pointer on a partial update', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({
      portfolio_posts: [
        {
          id: 21,
          title_en: 'T',
          body_en: '# old en',
          body_it: '# old it',
          body_en_path: `portfolio/21/en/${'c'.repeat(64)}.md`,
          body_it_path: `portfolio/21/it/${'d'.repeat(64)}.md`,
          image: '',
          buttons: [],
          hidden: false,
        },
      ],
    });
    const result = await portfolioActions({
      type: 'UPDATE',
      id: 21,
      data: { body_it: '# new it' },
    });
    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toBe(`portfolio/21/en/${'c'.repeat(64)}.md`);
    expect(row?.body_it_path).not.toBe(`portfolio/21/it/${'d'.repeat(64)}.md`);
  });

  it('rolls the provisional row back when the Markdown upload fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] }, {
      failUpload: { pathIncludes: '.md', message: 'bucket down' },
    });
    const result = await portfolioActions({
      type: 'CREATE',
      data: {
        title_en: 'T',
        title_it: 'T',
        image: 'https://x.test/a.webp',
        description_en: 'd',
        description_it: 'd',
        body_en: '# en',
        body_it: '# it',
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
      },
    });
    expect(result.success).toBe(false);
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
  });

  it('still rejects unresolved staged image references', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] });
    const result = await portfolioActions({
      type: 'CREATE',
      data: {
        title_en: 'T',
        title_it: 'T',
        image: '',
        description_en: 'd',
        description_it: 'd',
        body_en: '# en\n\n![cap-pending:abc](blob:x)',
        body_it: '# it',
        blurhashURL: '',
        post_tags: '',
        author_id: 'user-1',
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('batch publish');
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
  });
});

describe('portfolio dual-write: review hardening', () => {
  const FORGED_EN = `portfolio/999/en/${'f'.repeat(64)}.md`;
  const FORGED_IT = `portfolio/999/it/${'f'.repeat(64)}.md`;

  const seededRow = () => ({
    portfolio_posts: [
      {
        id: 11,
        title_en: 'T',
        body_en: '# old en',
        body_it: '# old it',
        body_en_path: `portfolio/11/en/${'a'.repeat(64)}.md`,
        body_it_path: `portfolio/11/it/${'b'.repeat(64)}.md`,
        image: '',
        buttons: [],
        hidden: false,
      },
    ],
  });

  it('rejects forged pointers on batch CREATE before any mutation', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] });
    const itemData = { ...portfolioCreate().data, body_en_path: FORGED_EN };
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [{ ...portfolioCreate(), data: itemData }],
      updates: [],
      deletes: [],
    });
    expect(result.success).toBe(false);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain('server-generated');
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('rejects forged pointers on batch UPDATE before any mutation', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seededRow());
    const forgedUpdate = { body_en: '# new', body_en_path: FORGED_EN };
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [{ id: 11, data: forgedUpdate }],
      deletes: [],
    });
    expect(result.success).toBe(false);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toBe(`portfolio/11/en/${'a'.repeat(64)}.md`);
    expect(contentObjectKeys(h.fake)).toEqual([]);
  });

  it('rejects forged pointers on single-shot CREATE', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] });
    const payload = { ...portfolioCreate().data, body_it_path: FORGED_IT };
    const result = await portfolioActions({ type: 'CREATE', data: payload });
    expect(result.success).toBe(false);
    expect(result.error).toContain('server-generated');
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
  });

  it('rejects forged pointers on single-shot UPDATE', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seededRow());
    const payload = { body_it: '# new it', body_it_path: FORGED_IT };
    const result = await portfolioActions({
      type: 'UPDATE',
      id: 11,
      data: payload,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('server-generated');
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_it_path).toBe(`portfolio/11/it/${'b'.repeat(64)}.md`);
  });

  it('removes only the newly uploaded cover when the Markdown upload fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    const oldCover =
      'https://fake.supabase.co/storage/v1/object/public/website-dev/portfolio/11/old.webp';
    h.fake = fake(
      {
        portfolio_posts: [
          { ...seededRow().portfolio_posts[0], image: oldCover },
        ],
      },
      { failUpload: { pathIncludes: '.md', message: 'bucket down' } }
    );

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [{ id: 11, data: { body_en: '# new en' }, file: webpFile() }],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const uploadedCover = h.fake.state.uploads[0];
    expect(uploadedCover).toBeTruthy();
    expect(h.fake.state.removed).toEqual([uploadedCover]);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.image).toBe(oldCover);
    expect(row?.body_en).toBe('# old en');
    expect(row?.body_en_path).toBe(`portfolio/11/en/${'a'.repeat(64)}.md`);
  });

  it('retains assets and reports the row when the provisional rollback fails', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(
      { portfolio_posts: [] },
      {
        failUpload: { pathIncludes: '.md', message: 'bucket down' },
        failNext: {
          table: 'portfolio_posts',
          mode: 'delete',
          message: 'delete blocked',
        },
      }
    );
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row).toBeDefined();
    expect(row?.hidden).toBe(true);
    expect(h.fake.state.removed).toEqual([]);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.failed[0]?.error).toContain(
      `provisional row ${row?.id as number}`
    );
    expect(evidence.failed[0]?.error).toContain('manual reconciliation');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('fails the create when the final commit matches zero rows', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(
      { portfolio_posts: [] },
      {
        failNext: {
          table: 'portfolio_posts',
          mode: 'update',
          message: 'no rows',
          zeroRows: true,
        },
      }
    );
    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [portfolioCreate()],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const evidence = result.data as BatchCommitEvidence;
    expect(evidence.created).toEqual([]);
    expect(evidence.createdIds).toEqual({});
    expect(evidence.failed[0]?.error).toContain('expected exactly 1');
    expect(h.fake.state.tables.portfolio_posts ?? []).toEqual([]);
  });

  it('stores the final rewritten Markdown for staged body images', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake({ portfolio_posts: [] });

    const result = await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [
        {
          data: {
            ...portfolioCreate().data,
            body_en: '# en\n\n![cap-pending:b1](blob:fake-en)',
            body_it: '# it\n\n![cap-pending:b2](blob:fake-it)',
          },
          file: webpFile(),
          tempId: 'p1',
          bodyFiles: [
            {
              localId: 'b1',
              file: webpFile('body-en.webp'),
              blurhash: '',
              alt: 'cap',
            },
            {
              localId: 'b2',
              file: webpFile('body-it.webp'),
              blurhash: '',
              alt: 'cap',
            },
          ],
        },
      ],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.portfolio_posts[0];
    for (const locale of ['en', 'it'] as const) {
      const body = row?.[`body_${locale}`] as string;
      const path = row?.[`body_${locale}_path`] as string;
      // The hashed object is the FINAL markdown, never the pending source.
      expect(body).not.toContain('pending:');
      expect(body).not.toContain('blob:');
      expect(body).toContain('/website-dev/portfolio/');
      const stored = Buffer.from(
        h.fake.state.objects[`${CONTENT}${path}`] as Buffer
      );
      expect(stored.toString('utf8')).toBe(body);
      expect(path).toContain(sha256Hex(stored));
    }
  });

  it('updates both language pointers when both bodies change', async () => {
    vi.stubEnv('CMS_BODY_DUAL_WRITE_ENABLED', 'true');
    h.fake = fake(seededRow());
    await portfolioActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [{ id: 11, data: { body_en: '# new en', body_it: '# new it' } }],
      deletes: [],
    });
    const row = h.fake.state.tables.portfolio_posts[0];
    expect(row?.body_en_path).toMatch(/^portfolio\/11\/en\/[0-9a-f]{64}\.md$/);
    expect(row?.body_it_path).toMatch(/^portfolio\/11\/it\/[0-9a-f]{64}\.md$/);
    expect(row?.body_en_path).not.toBe(`portfolio/11/en/${'a'.repeat(64)}.md`);
    expect(row?.body_it_path).not.toBe(`portfolio/11/it/${'b'.repeat(64)}.md`);
  });
});

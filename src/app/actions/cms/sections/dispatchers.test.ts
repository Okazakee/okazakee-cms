import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('next/cache', () => ({
  updateTag: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('blurkit/node', () => ({
  encode: vi.fn(async () => ({ hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })),
}));

import { blogActions } from '@/app/actions/cms/sections/blogActions';
import { careerActions } from '@/app/actions/cms/sections/careerActions';
import { contactsActions } from '@/app/actions/cms/sections/contactsActions';
import { heroActions } from '@/app/actions/cms/sections/heroActions';
import { i18nActions } from '@/app/actions/cms/sections/i18nActions';
import { portfolioActions } from '@/app/actions/cms/sections/portfolioActions';
import { skillsActions } from '@/app/actions/cms/sections/skillsActions';
import {
  updateMyProfile,
  updateUserDisplayName,
  uploadUserAvatar,
} from '@/app/actions/cms/sections/usersActions';
import { requireAuth } from '@/app/actions/cms/utils/fileHelpers';

const ADMIN = [{ email: 'admin@example.com', role: 'admin' }];
const EDITOR = [{ email: 'admin@example.com', role: 'editor' }];

function makeFake(
  tables: Record<string, Array<Record<string, unknown>>>,
  extra: Partial<Parameters<typeof createFakeSupabase>[0]> = {}
): FakeSupabase {
  return createFakeSupabase({ tables, ...extra });
}

function webpFile(name = 'image.webp'): File {
  return new File(
    [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])],
    name,
    {
      type: 'image/webp',
    }
  );
}

function pdfFile(name = 'resume.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
}

const blogCreate = (title: string, tempId: string) => ({
  data: {
    title_en: title,
    title_it: title,
    image: '',
    description_en: 'd',
    description_it: 'd',
    body_en: 'b',
    body_it: 'b',
    blurhashURL: '',
    post_tags: '',
    author_id: 'user-1',
  },
  file: webpFile(),
  tempId,
});

beforeEach(() => {
  h.invalidate.mockClear();
  // Storage hardening: actions resolve the bucket + origin from env per call.
  // Loopback-dev pairing routes writes to website-dev with a matching origin
  // so fake public URLs parse for owned-bucket cleanup tests.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
});

describe('blog BATCH_PUBLISH evidence', () => {
  it('reports only committed creates and still attempts revalidation on partial failure', async () => {
    h.fake = makeFake(
      { cms_allowed_users: EDITOR, blog_posts: [] },
      { failNext: { table: 'blog_posts', mode: 'insert', message: 'db down' } }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('First', 'c1'), blogCreate('Second', 'c2')],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    const data = result.data as {
      created: string[];
      createdIds: Record<string, number>;
      failed: Array<{ tempId?: string }>;
    };
    expect(data.created).toEqual(['c2']);
    expect(data.createdIds).toEqual({ c2: 1 });
    expect(data.failed.map((f) => f.tempId)).toEqual(['c1']);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not touch the DB or leave an orphan when the staged upload fails', async () => {
    h.fake = makeFake(
      { cms_allowed_users: EDITOR, blog_posts: [] },
      { failUpload: { message: 'storage down' } }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('First', 'c1')],
      updates: [],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toEqual([]);
    expect(
      h.fake.state.log.some(
        (entry) => entry.table === 'blog_posts' && entry.mode === 'insert'
      )
    ).toBe(false);
  });

  it('on DB failure after upload removes the NEW object but never the trusted OLD one', async () => {
    const oldUrl =
      'https://fake.supabase.co/storage/v1/object/public/website-dev/Website%20Assets/blog/old.webp';
    h.fake = makeFake(
      {
        cms_allowed_users: EDITOR,
        blog_posts: [{ id: 7, image: oldUrl, title_en: 'Old' }],
      },
      { failNext: { table: 'blog_posts', mode: 'update', message: 'db down' } }
    );

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [
        {
          id: 7,
          data: { title_en: 'New' },
          file: webpFile(),
        },
      ],
      deletes: [],
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toHaveLength(1);
    const newPath = h.fake.state.uploads[0];
    expect(h.fake.state.removed).toContain(newPath);
    expect(h.fake.state.removed).not.toContain('Website Assets/blog/old.webp');
    const data = result.data as { updated: number[]; failed: unknown[] };
    expect(data.updated).toEqual([]);
    expect(data.failed).toHaveLength(1);
  });

  it('mirrors a committed create id even when the client omits tempId', async () => {
    h.fake = makeFake({ cms_allowed_users: EDITOR, blog_posts: [] });

    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [
        {
          data: blogCreate('NoTemp', 'ignored').data,
          file: webpFile(),
        },
      ],
      updates: [],
      deletes: [],
    });

    const data = result.data as { created: string[] };
    expect(data.created).toEqual(['temp:blog:0']);
  });
});

describe('contacts BATCH_PUBLISH reorder split', () => {
  it('records committed reorders and isolates the failed one', async () => {
    h.fake = makeFake(
      {
        cms_allowed_users: ADMIN,
        contacts: [
          { id: 1, position: 0 },
          { id: 2, position: 1 },
        ],
      },
      { failNext: { table: 'contacts', mode: 'update', message: 'db down' } }
    );

    const result = await contactsActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [],
      deletes: [],
      reorder: [
        { id: 1, position: 1 },
        { id: 2, position: 0 },
      ],
    });

    expect(result.success).toBe(false);
    const data = result.data as {
      reordered: number[];
      failed: Array<{ kind: string }>;
    };
    expect(data.reordered).toEqual([2]);
    expect(data.failed).toHaveLength(1);
  });
  it('accepts extensionless SVG URLs and rejects named or unsafe icons', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, contacts: [] });
    const result = await contactsActions({
      type: 'BATCH_PUBLISH',
      creates: [
        'https://cdn.example.test/icon',
        'Mail',
        'javascript:alert(1)',
        'data:image/svg+xml,<svg/>',
      ].map((icon, position) => ({
        tempId: String(position),
        label: 'Contact',
        icon,
        link: 'mailto:hello@example.test',
        bg_color: '#ffffff',
        position,
      })),
      updates: [],
      deletes: [],
      reorder: [],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ created: ['0'] });
    expect(h.fake.state.tables.contacts).toHaveLength(1);
  });
  it('interleaves a created contact and densely orders surviving contacts', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      contacts: [
        { id: 1, position: 0 },
        { id: 2, position: 1 },
      ],
    });
    const result = await contactsActions({
      type: 'BATCH_PUBLISH',
      creates: [
        {
          tempId: 'new',
          label: 'New',
          icon: 'https://cdn.example.test/new-icon',
          link: 'https://example.test',
          bg_color: '#ffffff',
          position: 0,
        },
      ],
      updates: [],
      deletes: [2],
      reorder: [{ id: 1, position: 1 }],
    });
    expect(result.success).toBe(true);
    const evidence = result.data as { createdIds: Record<string, number> };
    expect(h.fake.state.tables.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: evidence.createdIds.new, position: 0 }),
        expect.objectContaining({ id: 1, position: 1 }),
      ])
    );
    expect(h.fake.state.tables.contacts).toHaveLength(2);
  });
});

describe('skills BATCH_PUBLISH temp category mapping', () => {
  it('maps a string category tempId to the committed DB id and preserves the map', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      skills_categories: [],
      skills: [],
    });

    const result = await skillsActions({
      type: 'BATCH_PUBLISH',
      newCategories: [{ name: 'Languages', tempId: 'cat-1' }],
      newSkills: [
        {
          categoryId: 'cat-1',
          tempId: 'skill:temp-1',
          data: { title: 'TypeScript', icon: 'ts', invert: false },
        },
      ],
      updateSkills: [],
      deleteSkills: [],
      updateCategories: [],
      deleteCategories: [],
      categoryOrder: [{ id: 'cat-1', position: 0 }],
      skillOrder: [{ id: 'skill:temp-1', position: 0 }],
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      created: string[];
      createdIds: Record<string, number>;
      tempIdToRealId: Record<string, number>;
    };
    expect(data.tempIdToRealId['cat-1']).toBe(1);
    expect(data.created).toEqual(['cat-1', 'skill:temp-1']);
    expect(data.createdIds['skill:temp-1']).toBe(1);
    expect(data.tempIdToRealId['skill:temp-1']).toBe(1);
    expect(result.data).toMatchObject({ reordered: [1, 'skill:1'] });
    expect(h.fake.state.tables.skills_categories[0].position).toBe(0);
    expect(h.fake.state.tables.skills[0].position).toBe(0);
    expect(h.fake.state.tables.skills[0]).not.toHaveProperty('tempId');
    expect(h.fake.state.tables.skills[0].category_id).toBe(1);
  });
});

describe('hero UPDATE_WITH_FILES staging is atomic', () => {
  it('performs zero uploads and zero commits when one file is invalid', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      hero_section: [{ id: 1, propic: null, resume_en: null }],
    });

    const result = await heroActions({
      type: 'UPDATE_WITH_FILES',
      files: {
        propic: webpFile(),
        resume_en: new File([new Uint8Array([1])], 'bad.txt', {
          type: 'text/plain',
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toEqual([]);
    expect(h.fake.state.log.some((entry) => entry.mode === 'update')).toBe(
      false
    );
  });

  it('removes every staged object when the DB commit fails', async () => {
    h.fake = makeFake(
      {
        cms_allowed_users: ADMIN,
        hero_section: [{ id: 1, propic: null, resume_en: null }],
      },
      {
        failNext: { table: 'hero_section', mode: 'update', message: 'db down' },
      }
    );

    const result = await heroActions({
      type: 'UPDATE_WITH_FILES',
      files: { propic: webpFile(), resume_en: pdfFile() },
    });

    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toHaveLength(2);
    expect(h.fake.state.removed.sort()).toEqual(
      [...h.fake.state.uploads].sort()
    );
  });
});

describe('i18n CAS and delta merge', () => {
  const seedTranslations = () => ({
    cms_allowed_users: ADMIN,
    i18n_translations: [
      {
        language: 'en',
        translations: {
          'hero-section': { title: 'Old', sub: 'keep' },
          other: 1,
        },
        privacy_policy: 'old',
      },
    ],
  });

  it.each([
    'skills-section',
    'career-section',
    'posts-section',
    'contacts-section',
    'privacyPolicy',
    'header',
    'footer',
    'errors',
    '',
  ])('rejects frozen namespace %s before writing', async (sectionKey) => {
    h.fake = makeFake(seedTranslations());
    for (const operation of [
      {
        type: 'UPDATE_SECTION' as const,
        locale: 'en',
        sectionKey,
        sectionData: { title: 'Forbidden' },
      },
      {
        type: 'UPDATE_SECTIONS' as const,
        sectionKey,
        sections: { en: { title: 'Forbidden' } },
      },
    ]) {
      const result = await i18nActions(operation);
      expect(result.success).toBe(false);
      expect(result.error).toContain('owned by the public website');
    }
    expect(
      h.fake.state.log.filter(
        (entry) =>
          entry.table === 'i18n_translations' && entry.mode === 'update'
      )
    ).toHaveLength(0);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('keeps request form translations editable', async () => {
    h.fake = makeFake(seedTranslations());
    const result = await i18nActions({
      type: 'UPDATE_SECTION',
      locale: 'en',
      sectionKey: 'request-form',
      sectionData: { title: 'Project request' },
    });
    expect(result.success).toBe(true);
    expect(h.fake.state.tables.i18n_translations[0].translations).toMatchObject(
      {
        'request-form': { title: 'Project request' },
      }
    );
  });

  it('merges a section delta without clobbering concurrent keys', async () => {
    h.fake = makeFake(seedTranslations());

    const result = await i18nActions({
      type: 'UPDATE_SECTION',
      locale: 'en',
      sectionKey: 'hero-section',
      sectionData: { title: 'New' },
    });

    expect(result.success).toBe(true);
    const stored = h.fake.state.tables.i18n_translations[0]
      .translations as Record<string, Record<string, unknown>>;
    expect(stored['hero-section']).toEqual({ title: 'New', sub: 'keep' });
    expect(stored.other).toBe(1);
  });

  it('retries once after a CAS miss and still commits', async () => {
    h.fake = makeFake(seedTranslations(), {
      failNext: {
        table: 'i18n_translations',
        mode: 'update',
        message: 'no match',
        code: 'PGRST116',
        times: 1,
      },
    });

    const result = await i18nActions({
      type: 'UPDATE_SECTION',
      locale: 'en',
      sectionKey: 'hero-section',
      sectionData: { title: 'Retried' },
    });

    expect(result.success).toBe(true);
    const updates = h.fake.state.log.filter(
      (entry) => entry.table === 'i18n_translations' && entry.mode === 'update'
    );
    expect(updates).toHaveLength(2);
  });

  it('reports an explicit conflict when every CAS retry misses', async () => {
    h.fake = makeFake(seedTranslations(), {
      failNext: {
        table: 'i18n_translations',
        mode: 'update',
        message: 'no match',
        code: 'PGRST116',
        times: Number.POSITIVE_INFINITY,
      },
    });

    const result = await i18nActions({
      type: 'UPDATE_SECTION',
      locale: 'en',
      sectionKey: 'hero-section',
      sectionData: { title: 'Never' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Conflict');
  });

  it('drops prototype-polluting keys and merges array indices', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      i18n_translations: [
        {
          language: 'en',
          translations: { 'hero-section': { list: ['a', 'b'] } },
          privacy_policy: 'x',
        },
      ],
    });

    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"list":{"1":"B"}}'
    );
    const result = await i18nActions({
      type: 'UPDATE_SECTION',
      locale: 'en',
      sectionKey: 'hero-section',
      sectionData: malicious,
    });

    expect(result.success).toBe(true);
    const stored = h.fake.state.tables.i18n_translations[0]
      .translations as Record<string, unknown>;
    const hero = stored['hero-section'] as Record<string, unknown>;
    expect(hero.list).toEqual(['a', 'B']);
    expect(Object.hasOwn(hero, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('commits locale A and reports locale B failure without rolling back A', async () => {
    h.fake = makeFake(seedTranslations());

    const result = await i18nActions({
      type: 'UPDATE_SECTIONS',
      sectionKey: 'hero-section',
      sections: { en: { title: 'EN' }, it: { title: 'IT' } },
    });

    expect(result.success).toBe(false);
    const data = result.data as {
      locales: Array<{ locale: string; committed: boolean }>;
      failed: Array<{ locale: string }>;
    };
    expect(data.locales.find((l) => l.locale === 'en')?.committed).toBe(true);
    expect(data.locales.find((l) => l.locale === 'it')?.committed).toBe(false);
    expect(data.failed.map((f) => f.locale)).toEqual(['it']);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('privacy update writes only the privacy_policy column', async () => {
    h.fake = makeFake(seedTranslations());
    const before = JSON.stringify(
      h.fake.state.tables.i18n_translations[0].translations
    );

    const result = await i18nActions({
      type: 'UPDATE_PRIVACY',
      locale: 'en',
      markdown: '# New policy',
    });

    expect(result.success).toBe(true);
    const row = h.fake.state.tables.i18n_translations[0];
    expect(row.privacy_policy).toBe('# New policy');
    expect(JSON.stringify(row.translations)).toBe(before);
    const update = h.fake.state.log.find(
      (entry) => entry.table === 'i18n_translations' && entry.mode === 'update'
    );
    expect(Object.keys(update?.payload as object)).toEqual(['privacy_policy']);
  });
});

describe('acknowledged partial commits survive exceptions', () => {
  it('retains the first blog create evidence and revalidates when the second upload throws', async () => {
    h.fake = makeFake(
      { cms_allowed_users: ADMIN, blog_posts: [] },
      { failUpload: { pathIncludes: 'second', message: 'storage offline' } }
    );
    const result = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('first', 'draft1'), blogCreate('second', 'draft2')],
      updates: [],
      deletes: [],
    });
    expect(result.success).toBe(false);
    const data = result.data as {
      created: string[];
      createdIds: Record<string, number>;
    };
    expect(data.created).toEqual(['draft1']);
    expect(data.createdIds.draft1).toBe(1);
    expect(h.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'blog', ids: [1] })
    );
    h.fake.state.failUpload = null;
    const retry = await blogActions({
      type: 'BATCH_PUBLISH',
      creates: [blogCreate('second', 'draft2')],
      updates: [],
      deletes: [],
    });
    expect(retry.success).toBe(true);
    expect(h.fake.state.tables.blog_posts.map((row) => row.title_en)).toEqual([
      'first',
      'second',
    ]);
  });

  it('retains a committed contact create when a later query rejects', async () => {
    h.fake = makeFake(
      { cms_allowed_users: ADMIN, contacts: [] },
      {
        failNext: {
          table: 'contacts',
          mode: 'insert',
          after: 1,
          throws: true,
          message: 'transport down',
        },
      }
    );
    const result = await contactsActions({
      type: 'BATCH_PUBLISH',
      creates: [
        {
          tempId: 'first',
          label: 'First',
          icon: 'https://cdn.example.test/mail',
          link: 'mailto:first@example.test',
          bg_color: '#ffffff',
          position: 0,
        },
        {
          tempId: 'second',
          label: 'Second',
          icon: 'https://cdn.example.test/mail',
          link: 'mailto:second@example.test',
          bg_color: '#ffffff',
          position: 1,
        },
      ],
      updates: [],
      deletes: [],
      reorder: [],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      created: ['first'],
      failed: [{ error: 'transport down' }],
    });
    expect(h.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'contacts' })
    );
    expect(h.fake.state.tables.contacts).toHaveLength(1);
  });
});

describe('skills entity-scoped evidence', () => {
  it('cannot clear a failed skill update by committing a category with the same id', async () => {
    h.fake = makeFake(
      {
        cms_allowed_users: ADMIN,
        skills_categories: [{ id: 1, name: 'Old' }],
        skills: [{ id: 1, title: 'Old', category_id: 1 }],
      },
      {
        failNext: {
          table: 'skills',
          mode: 'update',
          message: 'skill update failed',
        },
      }
    );
    const result = await skillsActions({
      type: 'BATCH_PUBLISH',
      newCategories: [],
      newSkills: [],
      deleteSkills: [],
      deleteCategories: [],
      categoryOrder: [],
      skillOrder: [],
      updateCategories: [{ id: 1, data: { name: 'New' } }],
      updateSkills: [{ id: 1, data: { title: 'New' } }],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ updated: ['category:1'] });
    expect(h.fake.state.tables.skills[0].title).toBe('Old');
  });

  it('fails a missing skill update instead of recording a nonexistent commit', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, skills: [] });
    const result = await skillsActions({
      type: 'BATCH_PUBLISH',
      newCategories: [],
      newSkills: [],
      deleteSkills: [],
      deleteCategories: [],
      categoryOrder: [],
      skillOrder: [],
      updateCategories: [],
      updateSkills: [{ id: 999, data: { title: 'New' } }],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ updated: [], failed: [{ id: 999 }] });
  });

  it('persists the link and the dense per-category positions', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      skills: [
        { id: 1, title: 'TypeScript', category_id: 1 },
        { id: 2, title: 'Rust', category_id: 1 },
        { id: 3, title: 'Bun', category_id: 2 },
      ],
    });

    const result = await skillsActions({
      type: 'BATCH_PUBLISH',
      newCategories: [],
      newSkills: [],
      deleteSkills: [],
      deleteCategories: [],
      categoryOrder: [],
      skillOrder: [
        { id: 2, position: 0 },
        { id: 1, position: 1 },
        { id: 3, position: 0 },
      ],
      updateCategories: [],
      updateSkills: [
        { id: 1, data: { title: 'TypeScript', link: 'https://ts.dev/' } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      reordered: ['skill:2', 'skill:1', 'skill:3'],
      updated: [1],
    });
    expect(h.fake.state.tables.skills).toEqual([
      expect.objectContaining({
        id: 1,
        link: 'https://ts.dev/',
        position: 1,
      }),
      expect.objectContaining({ id: 2, position: 0 }),
      expect.objectContaining({ id: 3, position: 0 }),
    ]);
  });

  it('stores a blank link as null and rejects a non-http scheme', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      skills: [{ id: 1, title: 'TypeScript', category_id: 1 }],
    });

    const cleared = await skillsActions({
      type: 'UPDATE',
      id: 1,
      data: { link: '   ' },
    });
    expect(cleared.success).toBe(true);
    expect(h.fake.state.tables.skills[0].link).toBeNull();

    const rejected = await skillsActions({
      type: 'UPDATE',
      id: 1,
      data: { link: 'javascript:alert(1)' },
    });
    expect(rejected.success).toBe(false);
    expect(h.fake.state.tables.skills[0].link).toBeNull();
  });

  it('fails a skill reorder for an unknown temp id instead of reporting a commit', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, skills: [] });
    const result = await skillsActions({
      type: 'BATCH_PUBLISH',
      newCategories: [],
      newSkills: [],
      deleteSkills: [],
      deleteCategories: [],
      categoryOrder: [],
      skillOrder: [{ id: 'skill:ghost', position: 0 }],
      updateCategories: [],
      updateSkills: [],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      reordered: [],
      failed: [{ kind: 'reorder', id: 'skill:ghost' }],
    });
  });
});

describe('asset commit and cleanup authority', () => {
  it('rolls staged hero files back when the hero row is absent', async () => {
    h.fake = makeFake({ cms_allowed_users: ADMIN, hero_section: [] });
    const result = await heroActions({
      type: 'UPDATE_WITH_FILES',
      files: { propic: webpFile(), resume_en: pdfFile() },
    });
    expect(result.success).toBe(false);
    expect(h.fake.state.removed).toEqual(h.fake.state.uploads);
    expect(Object.keys(h.fake.state.objects)).toHaveLength(0);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('never deletes a client-supplied URL when the real blog image is null', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      blog_posts: [{ id: 1, title_en: 'Existing', image: null }],
    });
    const result = await blogActions({
      type: 'UPLOAD_IMAGE',
      blogId: 1,
      file: webpFile(),
      currentImageUrl: 'https://attacker.test/website/resumes/unrelated.pdf',
    });
    expect(result.success).toBe(true);
    expect(h.fake.state.removed).toEqual([]);
  });
  it('never deletes a client-supplied career logo URL when the DB logo is null', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      career_entries: [{ id: 1, company: 'Fixture', logo: null }],
    });
    const result = await careerActions({
      type: 'UPLOAD_LOGO',
      careerId: 1,
      file: webpFile(),
      currentLogoUrl: 'https://attacker.test/website/resumes/unrelated.pdf',
    });
    expect(result.success).toBe(true);
    expect(h.fake.state.removed).toEqual([]);
  });
  it('never deletes a same-origin cross-bucket URL (prod object from a dev write)', async () => {
    // Old prod URL is readable but must be a cleanup no-op: the dev bucket
    // owns nothing at that path, so deleting would remove a prod object.
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      blog_posts: [
        {
          id: 1,
          title_en: 'Existing',
          image:
            'https://fake.supabase.co/storage/v1/object/public/website/Website%20Assets/blog/old.webp',
        },
      ],
    });
    const result = await blogActions({
      type: 'UPLOAD_IMAGE',
      blogId: 1,
      file: webpFile(),
    });
    expect(result.success).toBe(true);
    expect(h.fake.state.removed).toEqual([]);
  });

  it('cleans the staged career logo when the DB update fails', async () => {
    h.fake = makeFake(
      {
        cms_allowed_users: ADMIN,
        career_entries: [{ id: 1, company: 'Fixture', logo: null }],
      },
      {
        failNext: {
          table: 'career_entries',
          mode: 'update',
          message: 'db down',
        },
      }
    );
    const result = await careerActions({
      type: 'UPLOAD_LOGO',
      careerId: 1,
      file: webpFile(),
    });
    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toHaveLength(1);
    expect(h.fake.state.removed).toEqual(h.fake.state.uploads);
    expect(Object.keys(h.fake.state.objects)).toHaveLength(0);
  });

  it('cleans the staged avatar when the profile update fails', async () => {
    h.fake = makeFake(
      {
        cms_allowed_users: ADMIN,
        user_profiles: [{ id: 'profile-1', avatar_url: null }],
      },
      {
        failNext: {
          table: 'user_profiles',
          mode: 'update',
          message: 'db down',
        },
      }
    );
    const form = new FormData();
    form.set('profileId', 'profile-1');
    form.set('avatar', webpFile());
    const result = await uploadUserAvatar(form);
    expect(result.success).toBe(false);
    expect(h.fake.state.uploads).toHaveLength(1);
    expect(h.fake.state.removed).toEqual(h.fake.state.uploads);
    expect(Object.keys(h.fake.state.objects)).toHaveLength(0);
  });

  it('reports profile-not-found instead of success for a missing avatar profile', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      user_profiles: [],
    });
    const form = new FormData();
    form.set('profileId', 'missing-profile');
    form.set('avatar', webpFile());
    const result = await uploadUserAvatar(form);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(h.fake.state.uploads).toEqual([]);
  });

  it('rejects over-long display names on both profile update paths', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      user_profiles: [{ id: 'user-1', display_name: 'Old' }],
    });
    expect(
      (await updateUserDisplayName('user-1', 'x'.repeat(101))).success
    ).toBe(false);
    const form = new FormData();
    form.set('displayName', 'x'.repeat(101));
    expect((await updateMyProfile(form)).success).toBe(false);
  });

  it('reports unknown batch delete ids as failures instead of committed deletes', async () => {
    h.fake = makeFake({
      cms_allowed_users: ADMIN,
      career_entries: [],
    });
    const result = await careerActions({
      type: 'BATCH_PUBLISH',
      creates: [],
      updates: [],
      deletes: [999],
    });
    expect(result.success).toBe(false);
    const data = result.data as {
      deleted: number[];
      failed: Array<{ id?: number }>;
    };
    expect(data.deleted).toEqual([]);
    expect(data.failed.map((f) => f.id)).toContain(999);
  });
});

describe('auth allowlist boundary', () => {
  it('requireAuth rejects an authenticated user who is not allowlisted', async () => {
    h.fake = makeFake({ cms_allowed_users: [] });
    await expect(requireAuth()).rejects.toThrow(/not allowlisted/i);
  });

  it('requireAuth accepts an allowlisted user', async () => {
    h.fake = makeFake({ cms_allowed_users: EDITOR });
    await expect(requireAuth()).resolves.toMatchObject({
      id: 'user-1',
      email: 'admin@example.com',
    });
  });
});

describe('draft visibility and author picker', () => {
  it('serves drafts to allowlisted CMS readers through the admin boundary', async () => {
    h.fake = makeFake({
      cms_allowed_users: EDITOR,
      blog_posts: [
        { id: 1, title_en: 'Draft', hidden: true },
        { id: 2, title_en: 'Live', hidden: false },
      ],
      portfolio_posts: [{ id: 7, title_en: 'Draft work', hidden: true }],
    });
    const blog = await blogActions({ type: 'GET' });
    expect(blog.success).toBe(true);
    expect(
      (blog.data as Array<{ title_en: string }>).map((row) => row.title_en)
    ).toEqual(expect.arrayContaining(['Draft', 'Live']));
    const portfolio = await portfolioActions({ type: 'GET' });
    expect(portfolio.success).toBe(true);
    expect(
      (portfolio.data as Array<{ title_en: string }>).map((row) => row.title_en)
    ).toEqual(expect.arrayContaining(['Draft work']));
  });

  it('rejects unallowlisted readers before touching post tables', async () => {
    h.fake = makeFake({
      cms_allowed_users: [],
      blog_posts: [{ id: 1, title_en: 'Draft', hidden: true }],
      portfolio_posts: [{ id: 7, title_en: 'Draft work', hidden: true }],
    });
    expect((await blogActions({ type: 'GET' })).success).toBe(false);
    expect((await portfolioActions({ type: 'GET' })).success).toBe(false);
    expect(
      h.fake.state.log.filter(
        (entry) =>
          (entry.table === 'blog_posts' || entry.table === 'portfolio_posts') &&
          entry.mode === 'select'
      )
    ).toEqual([]);
  });

  it('exposes only the picker columns for authors, never allowlist emails', async () => {
    h.fake = makeFake({
      cms_allowed_users: EDITOR,
      user_profiles: [
        {
          id: 'user-1',
          email: 'author@example.com',
          display_name: 'Author',
          avatar_url: null,
        },
      ],
    });
    for (const result of [
      await blogActions({ type: 'GET_AUTHORS' }),
      await portfolioActions({ type: 'GET_AUTHORS' }),
    ]) {
      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        { id: 'user-1', display_name: 'Author', avatar_url: null },
      ]);
    }
  });

  it('refuses author enumeration to unallowlisted callers', async () => {
    h.fake = makeFake({
      cms_allowed_users: [],
      user_profiles: [{ id: 'user-1', display_name: 'Author' }],
    });
    expect((await blogActions({ type: 'GET_AUTHORS' })).success).toBe(false);
    expect((await portfolioActions({ type: 'GET_AUTHORS' })).success).toBe(
      false
    );
    expect(
      h.fake.state.log.filter(
        (entry) => entry.table === 'user_profiles' && entry.mode === 'select'
      )
    ).toEqual([]);
  });
});

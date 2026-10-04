// @vitest-environment happy-dom
import { NextIntlClientProvider, useLocale, useTranslations } from 'next-intl';
import { act, createElement, type ReactNode, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  settings: vi.fn(),
  setField: vi.fn(),
  skills: vi.fn(),
}));
vi.mock('@/app/actions/cms/sections/skillsActions', () => ({
  skillsActions: h.skills,
}));
vi.mock('@/app/actions/cms/sections/i18nActions', () => ({
  i18nActions: h.read,
}));
vi.mock('@/app/actions/cms/sections/blogActions', () => ({
  blogActions: async () => ({ success: true, data: [] }),
}));
vi.mock('@/app/actions/cms/sections/portfolioActions', () => ({
  portfolioActions: async () => ({ success: true, data: [] }),
}));
vi.mock('@/app/actions/cms/sections/siteSettingsActions', () => ({
  siteSettingsActions: h.settings,
}));
vi.mock('@/hooks/cms/useSectionCallbacks', () => ({
  useSectionCallbacks: () => {},
}));
vi.mock('@/hooks/cms/useSectionDirty', () => ({ useSectionDirty: () => {} }));
vi.mock('@/hooks/cms/useSectionTranslations', async (original) => {
  const actual =
    await original<typeof import('@/hooks/cms/useSectionTranslations')>();
  return {
    ...actual,
    useSectionTranslations: (namespace: string) => ({
      translations: {
        en:
          namespace === 'header'
            ? { 'buttons.0': 'Editable home' }
            : { left: 'English footer' },
        it:
          namespace === 'header'
            ? { 'buttons.1': 'Ignored Italian draft' }
            : { left: 'Italian footer' },
      },
      isDirty: false,
      isLoading: false,
      error: null,
      getField: (locale: string, path: string) => `${locale}:${path}`,
      setField: h.setField,
      saveTranslations: async () => [],
      revertTranslations: () => {},
    }),
  };
});
vi.mock('next/image', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: { src?: string; alt?: string; className?: string }) =>
      createElement('img', {
        src: props.src,
        alt: props.alt,
        className: props.className,
      }),
  };
});
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: {
      href: string;
      children: ReactNode;
      target?: string;
      rel?: string;
    }) => createElement('a', props, props.children),
  };
});
vi.mock('@/app/public/title-cms.png', () => ({
  default: { src: '/logo.png' },
}));
vi.mock('@/app/public/title-cms-lightmode.png', () => ({
  default: { src: '/logo-light.png' },
}));

import BlogSection from '@/components/cms/sections/Blog/BlogSection';
import CareerSection from '@/components/cms/sections/Career/CareerSection';
import {
  RequestCopySection,
  SiteCopySection,
} from '@/components/cms/sections/Copy/CopySections';
import FooterSection from '@/components/cms/sections/Footer/FooterSection';
import HeaderSection from '@/components/cms/sections/Header/HeaderSection';
import PortfolioSection from '@/components/cms/sections/Portfolio/PortfolioSection';
import PrivacyPolicySection from '@/components/cms/sections/Privacy/PrivacyPolicySection';
import SkillsSection from '@/components/cms/sections/Skills/SkillsSection';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { ClientMarkdown } from '@/components/common/cms/previews/canonical/ClientMarkdown';
import { GitHubStars } from '@/components/common/cms/previews/canonical/GitHubStars';
import { RequestFormPreview } from '@/components/common/cms/previews/canonical/RequestForm';
import { ViewCount } from '@/components/common/cms/previews/canonical/ViewCount';
import { PreviewTranslations } from '@/components/common/cms/previews/PreviewTranslations';

const rows = ['en', 'it'].map((language) => ({
  language,
  translations: {
    header: {
      buttons: ['Home', 'Skills', 'Career', 'Portfolio', 'Blog', 'Contacts'],
    },
    footer: {
      left: `Footer ${language}`,
      middle: 'Tax',
      source: 'Source',
      buttonTitle: 'Copy tax ID',
      privacyPolicy: 'Privacy',
    },
    'posts-section': {
      button: `Read ${language}`,
      source: `Source ${language}`,
      preCopy: 'Copy code',
      demo: 'Demo',
      store: 'Store',
      fdroid: 'F-Droid',
      ios: 'App Store',
    },
    'request-form': {
      title: 'A request',
      typeOptions: ['Type'],
      budgetOptions: ['Budget'],
      timelineOptions: ['Timeline'],
    },
  },
}));
const base = { cms: cmsEn, ...rows[0].translations };
let root: Root;
let container: HTMLDivElement;

async function mount(children: ReactNode, messages = base, strict = false) {
  const props = { locale: 'en', messages, children };
  const provider = createElement(NextIntlClientProvider, props);
  await act(async () =>
    root.render(strict ? createElement(StrictMode, null, provider) : provider)
  );
}
function deferredRead() {
  type Response = { success: boolean; data: unknown };
  let complete: (value: Response) => void = () => {
    throw new Error('Deferred read not initialized');
  };
  const promise = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  return { promise, complete: (value: Response) => complete(value) };
}
function localizedPreview(
  options: Omit<Parameters<typeof PreviewTranslations>[0], 'children'>,
  children: ReactNode
) {
  const props = { ...options, children };
  return createElement(PreviewTranslations, props);
}
function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) =>
      node.textContent?.trim() === name ||
      node.getAttribute('aria-label') === name
  );
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}
async function click(node: HTMLButtonElement) {
  await act(async () =>
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
}
async function fill(selector: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector
  );
  if (!node) throw new Error(`Missing field: ${selector}`);
  const prototype =
    node.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  h.read
    .mockReset()
    .mockResolvedValue({ success: true, data: structuredClone(rows) });
  h.settings.mockReset().mockResolvedValue({
    success: true,
    data: {
      header_logo_dark: null,
      header_logo_light: null,
      nav_anchors: [
        'home',
        'skills',
        'career',
        'portfolio',
        'blog',
        'contacts',
      ].map((id) => ({ id, anchor: id })),
    },
  });
  h.setField.mockClear();
  h.skills.mockReset().mockImplementation(async ({ type }: { type: string }) =>
    type === 'GET'
      ? {
          success: true,
          data: [{ id: 1, name: 'Languages', position: 0, skills: [] }],
        }
      : {
          success: false,
          error: 'Injected batch failure',
          data: {
            created: [],
            createdIds: {},
            updated: [],
            deleted: [],
            reordered: [],
            failed: [],
            tempIdToRealId: {},
          },
        }
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function CopyProbe() {
  const t = useTranslations('posts-section');
  return createElement(
    'p',
    { id: 'probe' },
    `${useLocale()}|${t('button')}|${t('source')}`
  );
}

describe('localized draft preview boundary', () => {
  it.each([true, false])(
    'keeps Privacy loading/drafts safe under StrictMode duplicate responses (old first: %s)',
    async (oldFirst) => {
      const old = deferredRead();
      const latest = deferredRead();
      h.read
        .mockReset()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
      await mount(createElement(PrivacyPolicySection), base, true);
      expect(h.read).toHaveBeenCalledTimes(2);
      if (oldFirst) {
        await act(async () =>
          old.complete({
            success: true,
            data: [{ language: 'en', privacy_policy: '# Stale policy' }],
          })
        );
        expect(container.querySelector('textarea')).toBeNull();
      }
      await act(async () =>
        latest.complete({
          success: true,
          data: [{ language: 'en', privacy_policy: '# Latest policy' }],
        })
      );
      await fill('textarea', '# Keep my unsaved policy');
      if (!oldFirst)
        await act(async () =>
          old.complete({
            success: true,
            data: [{ language: 'en', privacy_policy: '# Stale policy' }],
          })
        );
      expect(container.querySelector('textarea')?.value).toBe(
        '# Keep my unsaved policy'
      );
    }
  );
  it('keeps edited Skills categories when a superseded mount read arrives late', async () => {
    const old = deferredRead();
    const latest = deferredRead();
    h.skills
      .mockReset()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    await mount(createElement(SkillsSection), base, true);
    expect(h.skills).toHaveBeenCalledTimes(2);
    await act(async () =>
      latest.complete({
        success: true,
        data: [{ id: 1, name: 'Languages', position: 0, skills: [] }],
      })
    );
    await click(button('Rename category: Languages'));
    await fill('[aria-label="Category name"]', 'Keep this category draft');
    await act(async () =>
      old.complete({
        success: true,
        data: [{ id: 1, name: 'Stale languages', position: 0, skills: [] }],
      })
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Category name"]')
        ?.value
    ).toBe('Keep this category draft');
    expect(button('Publish').disabled).toBe(false);
  });
  it('retains Privacy drafts when another section refreshes public translations', async () => {
    h.read.mockResolvedValue({
      success: true,
      data: rows.map((row) => ({
        ...row,
        privacy_policy: `# Original ${row.language}`,
      })),
    });
    await mount(createElement(PrivacyPolicySection));
    await fill('textarea', '# Keep my unsaved privacy');
    await mount(createElement(PrivacyPolicySection), {
      ...base,
      cms: { ...cmsEn },
      'posts-section': {
        ...base['posts-section'],
        button: 'Sibling copy changed',
      },
    });
    expect(container.querySelector('textarea')?.value).toBe(
      '# Keep my unsaved privacy'
    );
    expect(h.read).toHaveBeenCalledTimes(1);
  });
  it('merges only selected-locale drafts and preserves unrelated public copy', async () => {
    const before = structuredClone(rows);
    await mount(
      localizedPreview(
        {
          locale: 'it',
          namespace: 'posts-section',
          drafts: { en: { button: 'EN draft' }, it: { button: 'IT draft' } },
        },
        createElement(CopyProbe)
      )
    );
    expect(document.querySelector('#probe')?.textContent).toBe(
      'it|IT draft|Source it'
    );
    expect(h.read).toHaveBeenCalledWith({ type: 'GET_PUBLIC' });
    expect(rows).toEqual(before);
  });
  it('renders the selected public locale when an editor has no translation drafts', async () => {
    await mount(
      localizedPreview(
        {
          locale: 'it',
          namespace: 'posts-section',
          drafts: { en: {}, it: {} },
        },
        createElement(CopyProbe)
      )
    );
    expect(document.querySelector('#probe')?.textContent).toBe(
      'it|Read it|Source it'
    );
  });
  it('supports root-scoped layout patches without replacing other keys', async () => {
    await mount(
      localizedPreview(
        {
          locale: 'en',
          namespace: '',
          drafts: { en: { 'posts-section.button': 'Root draft' }, it: {} },
        },
        createElement(CopyProbe)
      )
    );
    expect(document.querySelector('#probe')?.textContent).toBe(
      'en|Root draft|Source en'
    );
  });
  it('surfaces failed reads instead of displaying a misleading preview', async () => {
    h.read.mockResolvedValue({ success: false, error: 'Preview read failed' });
    await mount(
      localizedPreview(
        {
          locale: 'en',
          namespace: 'posts-section',
          drafts: { en: {}, it: {} },
        },
        createElement(CopyProbe)
      )
    );
    expect(document.querySelector('[role=alert]')?.textContent).toContain(
      'Preview read failed'
    );
    expect(document.querySelector('#probe')).toBeNull();
  });
  it.each([
    ['blog', BlogSection],
    ['portfolio', PortfolioSection],
  ] as const)(
    'previews %s form drafts in the form locale, not forced English',
    async (kind, Section) => {
      await mount(createElement(Section));
      await click(
        button(kind === 'blog' ? 'Add Blog Post' : 'Add Portfolio Post')
      );
      await click(button('Italian'));
      await fill('#tf-english-title-it', 'Titolo italiano');
      await fill('#tf-english-description-it', 'Descrizione italiana');
      await fill('#tf-english-content-it', 'Corpo italiano');
      await click(button('Preview Post'));
      const modal = document.querySelector('[role=dialog]');
      expect(modal?.textContent).toContain('Descrizione italiana');
      expect(modal?.textContent).toContain('Corpo italiano');
    }
  );
});

describe('honest website customization and offline controls', () => {
  it('submits an existing category rename and retains it after a rejected write', async () => {
    await mount(createElement(SkillsSection));
    await click(button('Rename category: Languages'));
    await fill('[aria-label="Category name"]', 'Updated languages');
    await click(button('Publish'));
    expect(h.skills).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'BATCH_PUBLISH',
        updateCategories: [{ id: 1, data: { name: 'Updated languages' } }],
      })
    );
    expect(
      document
        .querySelector('[aria-label="Category name"]')
        ?.getAttribute('value') ||
        (
          document.querySelector(
            '[aria-label="Category name"]'
          ) as HTMLInputElement
        )?.value ||
        container.textContent
    ).toContain('Updated languages');
  });
  it('submits the latest name for a newly created category, not its stale initial name', async () => {
    await mount(createElement(SkillsSection));
    await click(button('Add Category'));
    await fill('[placeholder="Category name"]', 'New category');
    await click(button('Add'));
    await click(button('Rename category: New category'));
    await fill('[aria-label="Category name"]', 'New category renamed');
    await click(button('Publish'));
    expect(h.skills).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'BATCH_PUBLISH',
        newCategories: [
          expect.objectContaining({ name: 'New category renamed' }),
        ],
        updateCategories: [],
      })
    );
  });
  it('renders every header field the website consumes and keeps Italian navigation fixed', async () => {
    await mount(createElement(HeaderSection));
    // 6 navigation labels + header.theme + header.language + header.resume.
    // The website reads the last three straight from this namespace
    // (NavMenu), so without a control here that copy is unreachable.
    // 6 navigation labels + 6 anchors + header.theme/language/resume, plus
    // the two hidden file inputs behind the logo dropzones.
    const texts =
      container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    expect(texts).toHaveLength(15);
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
    // The anchors are CMS-editable per theme, so a draft shows up in preview.
    expect([...texts].slice(6, 12).map((node) => node.value)).toEqual([
      'home',
      'skills',
      'career',
      'portfolio',
      'blog',
      'contacts',
    ]);
    expect(container.textContent).toContain('Theme');
    expect(container.textContent).toContain('Language');
    expect(container.textContent).toContain('Resume button');
    await click(button('Italian', container));
    const inputs = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ];
    expect(inputs.slice(0, 6).map((node) => node.value)).toEqual([
      'Home',
      'Skills',
      'Carriera',
      'Portfolio',
      'Blog',
      'Contatti',
    ]);
    expect(inputs.slice(0, 6).every((node) => node.disabled)).toBe(true);
    expect(inputs.slice(6).every((node) => !node.disabled)).toBe(true);
    // Every field the website reads from this namespace has a control.
    expect(container.textContent).toContain('Header Logo');
    expect(container.textContent).toContain('Navigation Anchors');
    expect(h.setField).not.toHaveBeenCalled();
  });
  it('exposes every footer field the website reads', async () => {
    await mount(createElement(FooterSection));
    expect(container.querySelectorAll('input')).toHaveLength(6);
    for (const label of [
      'Left',
      'Middle',
      'Right',
      'Source',
      'Button Title',
      'Privacy Policy',
    ]) {
      expect(container.textContent).toContain(label);
    }
  });
  it('edits sharing/rate-limit and post error labels in actual website namespaces', async () => {
    await mount(createElement(SiteCopySection));
    for (const label of [
      'posts-section.preCopy (EN)',
      'posts-section.ratelimit (EN)',
      'errors.postErrorTitle (EN)',
      'errors.postErrorText (EN)',
      'errors.postNotFoundText (EN)',
    ]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[aria-label^="common."]')).toBeNull();
  });
  it('edits career work-location labels under the consumed career-section namespace', async () => {
    await mount(createElement(CareerSection));
    // TranslationField ids derive from the CMS label text.
    for (const id of ['#tf-remote-en', '#tf-hybrid-en', '#tf-on-site-en']) {
      expect(container.querySelector(id)).not.toBeNull();
    }
    expect(container.querySelector('[aria-label^="remote."]')).toBeNull();
  });
  it('disables clean/busy publish and revert while preserving the preview action', async () => {
    const publish = vi.fn(async () => {});
    const revert = vi.fn();
    await mount(
      createElement(SectionActions, {
        isDirty: false,
        busy: false,
        onPublish: publish,
        onRevert: revert,
        onPreview: () => {},
      })
    );
    expect(button('Publish').disabled).toBe(true);
    expect(button('Revert').disabled).toBe(true);
    expect(button('Preview').disabled).toBe(false);
    await mount(
      createElement(SectionActions, {
        isDirty: true,
        busy: true,
        onPublish: publish,
        onRevert: revert,
        onPreview: () => {},
      })
    );
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].every(
        (node) => node.disabled
      )
    ).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
  it('never fetches or mutates when rendering stats or submitting the request preview', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await mount(
      createElement(
        'div',
        null,
        createElement(GitHubStars, { stars: 17 }),
        createElement(ViewCount, { views: 42 }),
        createElement(RequestFormPreview)
      )
    );
    const event = new Event('submit', { bubbles: true, cancelable: true });
    const form = container.querySelector('form');
    await act(async () => form?.dispatchEvent(event));
    expect(form).not.toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });
  it('uses public code chrome and image captions in draft markdown', async () => {
    const props = {
      children:
        '```ts\nconst answer = 42;\n```\n\n![Caption](https://example.test/image.webp)',
    };
    await mount(createElement(ClientMarkdown, props));
    expect(container.querySelector('.code-block .code-head')).not.toBeNull();
    expect(
      container.querySelector('.code-copy')?.getAttribute('aria-label')
    ).toBe('Copy code');
    expect(container.querySelector('.code-body')?.textContent).toContain(
      'const answer = 42;'
    );
    expect(container.querySelector('.fig-caption')?.textContent).toBe(
      'Caption'
    );
  });
  it('keeps request fields draft-driven and includes all existing option indices', async () => {
    await mount(createElement(RequestCopySection));
    expect(
      container.querySelector('[aria-label="request-form.title (EN)"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="request-form.typeOptions.0 (EN)"]')
    ).not.toBeNull();
  });
});

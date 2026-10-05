/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
 */
import { NextIntlClientProvider, useLocale, useTranslations } from 'next-intl';
import { act, createElement, type ReactNode, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';
import type * as useSectionTranslationsModule from '@/hooks/cms/useSectionTranslations';
import { useCmsStore } from '@/store/cmsStore';

const h = vi.hoisted(() => ({
  hero: vi.fn(),
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
  const actual = await original<typeof useSectionTranslationsModule>();
  return {
    ...actual,
    useSectionTranslations: () => ({
      translations: { en: {}, it: {} },
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
vi.mock('@/app/actions/cms/sections/heroActions', () => ({
  heroActions: h.hero,
}));
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
import { RequestCopySection } from '@/components/cms/sections/Copy/CopySections';
import { LayoutSection } from '@/components/cms/sections/Layout/LayoutSection';
import PortfolioSection from '@/components/cms/sections/Portfolio/PortfolioSection';
import PrivacyPolicySection from '@/components/cms/sections/Privacy/PrivacyPolicySection';
import SkillsSection from '@/components/cms/sections/Skills/SkillsSection';
import { SectionActions } from '@/components/cms/shared/SectionActions';
import { ClientMarkdown } from '@/components/common/cms/previews/canonical/ClientMarkdown';
import { GitHubStars } from '@/components/common/cms/previews/canonical/GitHubStars';
import { RequestFormPreview } from '@/components/common/cms/previews/canonical/RequestForm';
import { ViewCount } from '@/components/common/cms/previews/canonical/ViewCount';
import { LayoutPreview } from '@/components/common/cms/previews/LayoutPreview';
import { PreviewTranslations } from '@/components/common/cms/previews/PreviewTranslations';

const rows = ['en', 'it'].map((language) => ({
  language,
  translations: {
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
// No `header` or `footer` namespace is loaded anywhere here: that chrome copy
// is frozen site-side, so both the Layout and request-form previews must read
// it from local copy and stay functional without those DB namespaces.
const base = { cms: cmsEn, ...rows[0].translations };
let root: Root;
let container: HTMLDivElement;

async function mount(
  children: ReactNode,
  messages: Record<string, unknown> = base,
  strict = false,
  locale = 'en'
) {
  const props = {
    locale,
    messages,
    children,
  };
  const provider = createElement(NextIntlClientProvider, props);
  await act(async () =>
    root.render(strict ? createElement(StrictMode, null, provider) : provider)
  );
}
/** Types `value` into the text field the section renders under `label`. */
async function fillLabelled(label: string, value: string) {
  const field = [...container.querySelectorAll('label')].find(
    (node) => node.querySelector('span')?.textContent === label
  );
  const node = field?.querySelector('input');
  if (!node) throw new Error(`Missing field: ${label}`);
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  await act(async () => {
    setValue?.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
  useCmsStore.setState({
    activeSection: 'layout',
    heroSection: {
      mainImage: null,
      blurhashURL: null,
      resume_en: null,
      resume_it: null,
      shape: null,
      typewriter: false,
      typewriter_target: null,
    },
  });
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
      footer_name: null,
      footer_vat_number: null,
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
        expect(
          container.querySelector('[aria-label="Policy body"]')
        ).toBeNull();
      }
      await act(async () =>
        latest.complete({
          success: true,
          data: [{ language: 'en', privacy_policy: '# Latest policy' }],
        })
      );
      await fill('[aria-label="Policy body"]', '# Keep my unsaved policy');
      if (!oldFirst)
        await act(async () =>
          old.complete({
            success: true,
            data: [{ language: 'en', privacy_policy: '# Stale policy' }],
          })
        );
      expect(
        container.querySelector<HTMLTextAreaElement>(
          '[aria-label="Policy body"]'
        )?.value
      ).toBe('# Keep my unsaved policy');
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
    await fill('[aria-label="Policy body"]', '# Keep my unsaved privacy');
    await mount(createElement(PrivacyPolicySection), {
      ...base,
      cms: { ...cmsEn },
      'posts-section': {
        ...base['posts-section'],
        button: 'Sibling copy changed',
      },
    });
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Policy body"]')
        ?.value
    ).toBe('# Keep my unsaved privacy');
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
  it.each([
    ['en', ['Career', 'Contacts'], 'Made with ❤️ by'],
    ['it', ['Carriera', 'Contatti'], 'Creato con ❤️ da'],
  ] as const)(
    'previews the layout chrome from local copy in %s with no header or footer namespace loaded',
    async (locale, navLabels, credit) => {
      await mount(createElement(LayoutPreview), { cms: cmsEn }, false, locale);
      const rendered = container.textContent ?? '';
      for (const label of navLabels) expect(rendered).toContain(label);
      expect(rendered).toContain(credit);
      // A namespace key must never surface as chrome text.
      expect(rendered).not.toContain('footer.');
    }
  );
  it('keeps the website footer identity until a draft supplies one, and hides the résumé link without a PDF', async () => {
    await mount(createElement(LayoutSection));
    await click(button('Preview'));
    const preview = () => document.querySelector('[role=dialog]');
    expect(preview()?.textContent).toContain('Made with ❤️ by Okazakee');
    expect(preview()?.textContent).toContain('VAT IT - 02863310815');
    expect(preview()?.querySelector('a[href$=".pdf"]')).toBeNull();
    // A draft takes over one field at a time; the untouched one keeps the
    // site's own value instead of going blank.
    await click(button('Close'));
    await fillLabelled('VAT number', '00123456789');
    await click(button('Preview'));
    expect(preview()?.textContent).toContain('VAT IT - 00123456789');
    expect(preview()?.textContent).toContain('Made with ❤️ by Okazakee');
  });

  it('releases busy state and re-enables the editor after a successful publish', async () => {
    await mount(createElement(LayoutSection));
    // Drain the initial fetch + render microtasks.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Initial: clean, Publish/Revert disabled, fieldset enabled.
    const fs = container.querySelector('fieldset');
    expect(fs?.hasAttribute('disabled')).toBe(false);
    expect(button('Publish').disabled).toBe(true);

    // Edit footer to make dirty.
    await fillLabelled('Display name', 'NewName');
    expect(button('Publish').disabled).toBe(false);

    // Publish succeeds (h.settings resolves success).
    await click(button('Publish'));
    // Drain the async publish callback + resulting state updates.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // busy must release: fieldset re-enabled, dirty cleared, error absent.
    expect(fs?.hasAttribute('disabled')).toBe(false);
    expect(button('Publish').disabled).toBe(true);
    expect(button('Revert').disabled).toBe(true);
    expect(container.querySelector('[role=alert]')).toBeNull();

    // Editor stays usable: a second edit + publish still works.
    await fillLabelled('Display name', 'SecondEdit');
    expect(button('Publish').disabled).toBe(false);
    await click(button('Publish'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fs?.hasAttribute('disabled')).toBe(false);
    expect(button('Publish').disabled).toBe(true);
  });
  it('previews the anchor a draft points at and the résumé link of the previewed locale', async () => {
    useCmsStore.setState({
      heroSection: {
        mainImage: null,
        blurhashURL: null,
        resume_en: '/resumes/en.pdf',
        resume_it: '/resumes/it.pdf',
        shape: null,
        typewriter: false,
        typewriter_target: null,
      },
    });
    await mount(createElement(LayoutSection));
    await fillLabelled('Skills', 'competenze');
    await click(button('Preview'));
    const preview = () => document.querySelector('[role=dialog]');
    expect(preview()?.querySelector('a[href="#competenze"]')?.textContent).toBe(
      'Skills'
    );
    // Only the previewed locale's own PDF is offered, as the site resolves the
    // button from `resume_${locale}`.
    expect(
      preview()?.querySelector('a[href="/resumes/en.pdf"]')?.textContent
    ).toContain('Resume');
    expect(preview()?.querySelector('a[href="/resumes/it.pdf"]')).toBeNull();
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
  it('renders the request preview from frozen chrome copy with no footer namespace loaded, and only reports unavailable when the request-form copy is gone', async () => {
    await mount(createElement(RequestFormPreview));
    const privacy = container.querySelector('a[href="/en/privacy-policy"]');
    expect(container.querySelector('form')).not.toBeNull();
    expect(privacy).not.toBeNull();
    await mount(createElement(RequestFormPreview), { cms: cmsEn });
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('unavailable');
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

// @vitest-environment happy-dom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';
import { useCmsStore } from '@/store/cmsStore';
import { markdownToEditorHtml } from '@/utils/cms/bodyBlocks';

/**
 * Phase 9B blog section: metadata-only list rows plus the lazy per-post
 * Markdown read. Every assertion reads an actual action payload or rendered
 * DOM state — never a helper call count.
 */

type BlogResult = { success: boolean; data?: unknown; error?: string };

type PublishUpdate = {
  id: number;
  file: File | null;
  currentImageUrl: string;
  blurhashURL: string;
  bodyFiles: Array<{ file: File }>;
  data: Record<string, unknown>;
};

type BlogOperation = {
  type: string;
  id?: number;
  updates?: PublishUpdate[];
  creates?: unknown[];
  deletes?: number[];
};

const h = vi.hoisted(() => ({
  action: vi.fn<(operation: BlogOperation) => Promise<BlogResult>>(),
  publish: null as (() => Promise<void>) | null,
}));
vi.mock('@/app/actions/cms/sections/blogActions', () => ({
  blogActions: h.action,
}));
vi.mock('@/hooks/cms/useSectionCallbacks', () => ({
  useSectionCallbacks: (_section: string, publish: () => Promise<void>) => {
    h.publish = publish;
  },
}));
vi.mock('@/utils/imageProcessor', () => ({
  processImageToWebP: async (file: File) => ({ success: true, file }),
}));
vi.mock('@/utils/cms/webpAnimation', () => ({
  isAnimatedWebpFile: async () => false,
}));
vi.mock('blurkit/browser', () => ({
  encode: async () => ({ dataURL: 'data:image/png;base64,AAAA' }),
}));
vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => createElement('img', props),
}));

import BlogSection from '@/components/cms/sections/Blog/BlogSection';

const ALPHA = {
  id: 11,
  titleEn: 'Post Alpha',
  titleIt: 'Post Alpha IT',
  bodyEn: 'Alpha EN markdown',
  bodyIt: 'Alpha IT markdown',
};
const BETA = {
  id: 22,
  titleEn: 'Post Beta',
  titleIt: 'Post Beta IT',
  bodyEn: 'Beta EN markdown',
  bodyIt: 'Beta IT markdown',
};
const POSTS = [ALPHA, BETA];
const CREATED_AT = '2026-01-02T10:00:00.000Z';
const AUTHOR_ID = 'author-1';

/** What `GET_LIST` returns: every non-body column, and no Markdown at all. */
function listRows() {
  return POSTS.map((post) => ({
    id: post.id,
    created_at: CREATED_AT,
    title: post.titleEn,
    title_en: post.titleEn,
    title_it: post.titleIt,
    image: `https://example.com/${post.id}.webp`,
    description_en: `${post.titleEn} summary`,
    description_it: `${post.titleIt} summary`,
    blurhashURL: '',
    post_tags: 'tag-one',
    views: 7,
    hidden: hiddenIds.has(post.id),
    author_id: AUTHOR_ID,
  }));
}

let batches: BlogOperation[] = [];
let hiddenIds = new Set<number>();
let bodyResults = new Map<number, BlogResult>();
let pendingBodies = new Map<number, (result: BlogResult) => void>();
let deferBodies = false;
let failUpdates = false;

async function fakeBlogAction(operation: BlogOperation): Promise<BlogResult> {
  switch (operation.type) {
    case 'GET_LIST':
      return { success: true, data: listRows() };
    case 'GET_AUTHORS':
      return {
        success: true,
        data: [
          { id: AUTHOR_ID, display_name: 'Ada Lovelace', avatar_url: null },
        ],
      };
    case 'GET_BODIES': {
      const id = operation.id ?? -1;
      if (deferBodies) {
        const { promise, resolve } = Promise.withResolvers<BlogResult>();
        pendingBodies.set(id, resolve);
        return promise;
      }
      return (
        bodyResults.get(id) ?? { success: false, error: `No bodies ${id}` }
      );
    }
    case 'BATCH_PUBLISH': {
      batches.push(operation);
      const updateIds = (operation.updates ?? []).map((update) => update.id);
      const deletes = operation.deletes ?? [];
      if (failUpdates) {
        return {
          success: true,
          data: {
            created: [],
            createdIds: {},
            updated: [],
            deleted: deletes,
            reordered: [],
            failed: updateIds.map((id) => ({
              kind: 'update',
              id,
              error: 'write failed',
            })),
          },
        };
      }
      return {
        success: true,
        data: {
          created: [],
          createdIds: {},
          updated: updateIds,
          deleted: deletes,
          reordered: [],
          failed: [],
        },
      };
    }
    default:
      throw new Error(`Unexpected operation: ${operation.type}`);
  }
}

let root: Root;
let container: HTMLDivElement;

/**
 * The PRODUCTION CMS environment, as it actually runs: schema `public`,
 * `APP_ENV=production`, and `NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED` NOT set.
 * Every editor assertion below is therefore a production regression guard — the
 * metadata-only list plus the authenticated `GET_BODIES` read must not depend on
 * any flag being configured.
 */
const productionEnv = () => {
  delete process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'public');
  vi.stubEnv('APP_ENV', 'production');
};

/** Settles every pending promise chain (actions, effects) inside `act`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const click = async (node: Element) => {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
  });
};

const clickText = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await click(button);
};

const rowButton = (title: string, label: string) => {
  const heading = [...container.querySelectorAll('h3')].find(
    (node) => node.textContent === title
  );
  if (!heading) throw new Error(`Missing row: ${title}`);
  const row = heading.parentElement?.parentElement?.parentElement;
  const button = row?.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing "${label}" button on ${title}`);
  return button;
};

const editRow = (title: string) => rowButton(title, cmsEn.common.edit);

const editorBody = () => container.querySelector<HTMLElement>('#blog-body');
const editorMarkdown = () => editorBody()?.textContent ?? '';
const titleInput = () => {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error('Missing title input');
  return input;
};

/** Types into the visual body editor the way a user would. */
const setEditorBody = async (markdown: string) => {
  const editor = editorBody();
  if (!editor) throw new Error('The editor is not open');
  await act(async () => {
    editor.innerHTML = markdownToEditorHtml(markdown);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
};

const setInputValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
};

const attachCover = async () => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing cover input');
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['cover'], 'cover.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
};

const renderSection = async () => {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ cms: cmsEn }}>
        <BlogSection />
      </NextIntlClientProvider>
    );
    await settle();
  });
};

const publish = async () => {
  if (!h.publish) throw new Error('Publish was never registered');
  await act(async () => {
    await h.publish?.();
    await settle();
  });
};

const bodyReads = () =>
  h.action.mock.calls
    .map(([operation]) => operation)
    .filter((operation) => operation.type === 'GET_BODIES');
const actionTypes = () =>
  h.action.mock.calls.map(([operation]) => operation.type);
const lastBatch = () => batches.at(-1);

beforeEach(() => {
  // Production does not set this variable; nothing may depend on it.
  delete process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED;
  useCmsStore.setState({ demoMode: false });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:staged');
      static revokeObjectURL = vi.fn();
    }
  );
  h.publish = null;
  h.action.mockReset();
  h.action.mockImplementation(fakeBlogAction);
  batches = [];
  hiddenIds = new Set();
  bodyResults = new Map();
  pendingBodies = new Map();
  deferBodies = false;
  failUpdates = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('production (public), no lazy flag set: reads metadata-only rows with GET_LIST and never fetches bodies', async () => {
  productionEnv();
  // The regression this guards: production sets neither the lazy-body variable
  // nor a dev schema, and used to fall back to a full-row `GET`.
  expect(process.env.NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED).toBeUndefined();
  expect(process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA).toBe('public');

  await renderSection();

  expect(h.action.mock.calls.map(([operation]) => operation.type)).toEqual([
    'GET_LIST',
    'GET_AUTHORS',
  ]);
  expect(container.textContent).toContain(ALPHA.titleEn);
  expect(container.textContent).toContain(`${ALPHA.titleEn} summary`);
  expect(container.textContent).toContain(`${BETA.titleEn} summary`);
  expect(container.textContent).toContain('7 views');
  expect(bodyReads()).toEqual([]);
});

it('production (public): opening an existing post reads its Markdown from Storage once and seeds both locales', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  // The row itself carries no Markdown, so the editor can only be populated
  // from the authenticated per-post read.
  expect(actionTypes()).not.toContain('GET');
  await click(editRow(ALPHA.titleEn));

  expect(bodyReads()).toEqual([{ type: 'GET_BODIES', id: ALPHA.id }]);
  expect(container.textContent).toContain(cmsEn.blog.editPost);
  expect(editorMarkdown()).toContain(ALPHA.bodyEn);
  await clickText(cmsEn.common.italian);
  expect(editorMarkdown()).toContain(ALPHA.bodyIt);
});

it('production (public): a hidden post is listed and its Markdown still resolves', async () => {
  productionEnv();
  bodyResults.set(BETA.id, {
    success: true,
    data: { id: BETA.id, body_en: BETA.bodyEn, body_it: BETA.bodyIt },
  });
  hiddenIds = new Set([BETA.id]);
  await renderSection();

  expect(container.textContent).toContain(BETA.titleEn);
  await click(editRow(BETA.titleEn));
  expect(editorMarkdown()).toContain(BETA.bodyEn);
});

it('production (public): a staged new post never reads bodies and keeps its local Markdown', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await clickText(cmsEn.blog.addBlogPost);
  await setInputValue(titleInput(), 'Draft post');
  await setEditorBody('Draft EN markdown');
  await attachCover();
  await clickText(cmsEn.editor.addDraft);

  expect(container.textContent).toContain('Draft post');
  expect(bodyReads()).toEqual([]);

  // Reopening the pending create takes the synchronous path.
  await click(editRow('Draft post'));
  expect(bodyReads()).toEqual([]);
  expect(editorMarkdown()).toContain('Draft EN markdown');
});

it('production (public): a failed body read keeps the row, blocks the editor, and retries', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, { success: false, error: 'Markdown unavailable' });
  await renderSection();

  await click(editRow(ALPHA.titleEn));

  expect(container.textContent).toContain('Markdown unavailable');
  expect(container.textContent).toContain(ALPHA.titleEn);
  expect(container.textContent).not.toContain(cmsEn.blog.editPost);
  expect(editorBody()).toBeNull();

  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await click(editRow(ALPHA.titleEn));

  expect(bodyReads()).toEqual([
    { type: 'GET_BODIES', id: ALPHA.id },
    { type: 'GET_BODIES', id: ALPHA.id },
  ]);
  expect(editorMarkdown()).toContain(ALPHA.bodyEn);
  expect(container.textContent).not.toContain('Markdown unavailable');
});

it('production (public): a failed body read forbids overwriting the committed Markdown', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, { success: false, error: 'Storage read failed' });
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  // The read failed, so the editor never opened: the only thing the user can
  // still do to this row is a metadata-level change.
  expect(container.textContent).toContain('Storage read failed');
  expect(editorBody()).toBeNull();

  await click(rowButton(ALPHA.titleEn, cmsEn.common.hide));
  await publish();

  // A locale with no successful read has no loaded value and no baseline, so
  // the publish must omit BOTH body fields: sending `''` here would wipe the
  // real Markdown (and orphan its object) that the client never saw.
  const update = lastBatch()?.updates?.[0];
  expect(update?.id).toBe(ALPHA.id);
  expect(update?.data.hidden).toBe(true);
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(update?.bodyFiles).toEqual([]);
});

it('production (public): a superseded body read never overwrites the open editor', async () => {
  productionEnv();
  deferBodies = true;
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  expect(container.textContent).toContain(cmsEn.common.loading);
  await click(editRow(BETA.titleEn));

  await act(async () => {
    pendingBodies.get(BETA.id)?.({
      success: true,
      data: { id: BETA.id, body_en: BETA.bodyEn, body_it: BETA.bodyIt },
    });
    await settle();
  });
  expect(editorMarkdown()).toContain(BETA.bodyEn);
  expect(titleInput().value).toBe(BETA.titleEn);
  expect(container.textContent).not.toContain(cmsEn.common.loading);

  await act(async () => {
    pendingBodies.get(ALPHA.id)?.({
      success: true,
      data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
    });
    await settle();
  });

  expect(editorMarkdown()).toContain(BETA.bodyEn);
  expect(editorMarkdown()).not.toContain(ALPHA.bodyEn);
  expect(titleInput().value).toBe(BETA.titleEn);
  expect(container.textContent).not.toContain('Unexpected markdown response');
});

it('production (public): a visibility-only update sends no body field', async () => {
  productionEnv();
  await renderSection();

  await click(rowButton(ALPHA.titleEn, cmsEn.common.hide));
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.id).toBe(ALPHA.id);
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(update?.data.hidden).toBe(true);
  expect(update?.bodyFiles).toEqual([]);
  expect(bodyReads()).toEqual([]);
});

it('production (public): a metadata-only update of a loaded post sends no body field', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  await setInputValue(titleInput(), 'Post Alpha v2');
  await clickText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.data).toMatchObject({ title_en: 'Post Alpha v2' });
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(update?.bodyFiles).toEqual([]);
});

it('production (public): an EN-only edit sends only body_en', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  await setEditorBody('Alpha EN edited');
  await clickText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.data.body_en).toBe('Alpha EN edited');
  expect(update?.data).not.toHaveProperty('body_it');
});

it('production (public): editing both locales sends both body fields', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  await setEditorBody('Alpha EN edited');
  await clickText(cmsEn.common.italian);
  await setEditorBody('Alpha IT edited');
  await clickText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.data.body_en).toBe('Alpha EN edited');
  expect(update?.data.body_it).toBe('Alpha IT edited');
});

it('production (public): an edit reverted to the baseline sends neither body field', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  await setEditorBody('Alpha EN edited');
  await setEditorBody(ALPHA.bodyEn);
  await clickText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.id).toBe(ALPHA.id);
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(update?.bodyFiles).toEqual([]);
});

it('production (public): an unresolvable draft keeps its body edit for the next publish', async () => {
  productionEnv();
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await click(editRow(ALPHA.titleEn));
  await setEditorBody('Alpha EN edited');
  await clickText(cmsEn.editor.applyDraft);

  failUpdates = true;
  await publish();

  expect(container.textContent).toContain('write failed');
  expect(container.textContent).toContain(ALPHA.titleEn);
  // The retained draft keeps its loaded baseline: no second body read.
  expect(bodyReads()).toEqual([{ type: 'GET_BODIES', id: ALPHA.id }]);

  failUpdates = false;
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.id).toBe(ALPHA.id);
  expect(update?.data.body_en).toBe('Alpha EN edited');
  expect(update?.data).not.toHaveProperty('body_it');
});

/**
 * Demo mode owns its data: it must keep rendering its fixtures and never issue
 * a server action, in particular never a `GET_BODIES` for a fixture post whose
 * id looks like a real one. The editor must still open on fixture Markdown.
 */
it('demo mode: renders its fixtures, calls no action, and keeps the fixture Markdown', async () => {
  productionEnv();
  useCmsStore.setState({ demoMode: true });
  await renderSection();

  expect(h.action).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Demo post one');

  await click(editRow('Demo post one'));
  expect(bodyReads()).toEqual([]);
  expect(editorMarkdown()).toContain('Hello demo');
});

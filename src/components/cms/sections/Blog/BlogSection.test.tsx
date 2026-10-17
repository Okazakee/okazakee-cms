// @vitest-environment happy-dom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';
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
    hidden: false,
    author_id: AUTHOR_ID,
  }));
}

/** What `GET` returns: the same rows, bodies included. */
function fullRows() {
  return listRows().map((row) => {
    const post = POSTS.find((entry) => entry.id === row.id);
    return { ...row, body_en: post?.bodyEn ?? '', body_it: post?.bodyIt ?? '' };
  });
}

let batches: BlogOperation[] = [];
let bodyResults = new Map<number, BlogResult>();
let pendingBodies = new Map<number, (result: BlogResult) => void>();
let deferBodies = false;
let failUpdates = false;

async function fakeBlogAction(operation: BlogOperation): Promise<BlogResult> {
  switch (operation.type) {
    case 'GET':
      return { success: true, data: fullRows() };
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

const lazyFlag = (enabled: boolean) => {
  vi.stubEnv(
    'NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED',
    enabled ? 'true' : 'false'
  );
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_DB_SCHEMA', 'dev_staging');
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
const lastBatch = () => batches.at(-1);

beforeEach(() => {
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

it('flag off: reads full rows with GET and keeps the eager editor and payloads', async () => {
  lazyFlag(false);
  await renderSection();

  expect(h.action.mock.calls.map(([operation]) => operation.type)).toEqual([
    'GET',
    'GET_AUTHORS',
  ]);
  expect(container.textContent).toContain(ALPHA.titleEn);

  // Today's behaviour: the editor opens straight off the GET bodies.
  await click(editRow(ALPHA.titleEn));
  expect(bodyReads()).toEqual([]);
  expect(editorMarkdown()).toContain(ALPHA.bodyEn);
  await clickText(cmsEn.common.italian);
  expect(editorMarkdown()).toContain(ALPHA.bodyIt);
  await clickText(cmsEn.common.english);

  await setInputValue(titleInput(), 'Post Alpha v2');
  await clickText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastBatch()?.updates?.[0];
  expect(update?.data).toMatchObject({
    title_en: 'Post Alpha v2',
    body_en: ALPHA.bodyEn,
    body_it: ALPHA.bodyIt,
  });
  expect(update?.bodyFiles).toEqual([]);
});

it('flag on: reads metadata-only rows with GET_LIST and never fetches bodies', async () => {
  lazyFlag(true);
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

it('flag on: opening an existing post reads its bodies once and seeds both locales', async () => {
  lazyFlag(true);
  bodyResults.set(ALPHA.id, {
    success: true,
    data: { id: ALPHA.id, body_en: ALPHA.bodyEn, body_it: ALPHA.bodyIt },
  });
  await renderSection();

  await click(editRow(ALPHA.titleEn));

  expect(bodyReads()).toEqual([{ type: 'GET_BODIES', id: ALPHA.id }]);
  expect(container.textContent).toContain(cmsEn.blog.editPost);
  expect(editorMarkdown()).toContain(ALPHA.bodyEn);
  await clickText(cmsEn.common.italian);
  expect(editorMarkdown()).toContain(ALPHA.bodyIt);
});

it('flag on: a staged new post never reads bodies and keeps its local Markdown', async () => {
  lazyFlag(true);
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

it('flag on: a failed body read keeps the row, blocks the editor, and retries', async () => {
  lazyFlag(true);
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

it('flag on: a superseded body read never overwrites the open editor', async () => {
  lazyFlag(true);
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

it('flag on: a visibility-only update sends no body field', async () => {
  lazyFlag(true);
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

it('flag on: a metadata-only update of a loaded post sends no body field', async () => {
  lazyFlag(true);
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

it('flag on: an EN-only edit sends only body_en', async () => {
  lazyFlag(true);
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

it('flag on: editing both locales sends both body fields', async () => {
  lazyFlag(true);
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

it('flag on: an edit reverted to the baseline sends neither body field', async () => {
  lazyFlag(true);
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

it('flag on: an unresolvable draft keeps its body edit for the next publish', async () => {
  lazyFlag(true);
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

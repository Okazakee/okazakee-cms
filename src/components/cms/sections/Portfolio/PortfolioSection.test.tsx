// @vitest-environment happy-dom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';

const h = vi.hoisted(() => ({
  action:
    vi.fn<
      (operation: {
        type: string;
        id?: number;
        creates?: Array<{ tempId: string; data: Record<string, unknown> }>;
        updates?: Array<{
          id: number;
          data: Record<string, unknown>;
          bodyFiles: Array<{ file: File }>;
        }>;
        deletes?: number[];
      }) => Promise<unknown>
    >(),
  publish: null as (() => Promise<void>) | null,
}));

vi.mock('@/app/actions/cms/sections/portfolioActions', () => ({
  portfolioActions: h.action,
}));
vi.mock('@/hooks/cms/useSectionCallbacks', () => ({
  useSectionCallbacks: (_section: string, publish: () => Promise<void>) => {
    h.publish = publish;
  },
}));
vi.mock('@/utils/imageProcessor', () => ({
  processImageToWebP: async (file: File) => ({ success: true, file }),
}));
vi.mock('blurkit/browser', () => ({
  encode: async () => ({ dataURL: 'data:image/png;base64,blur' }),
}));
vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => createElement('img', props),
}));

import PortfolioSection from '@/components/cms/sections/Portfolio/PortfolioSection';

type Operation = Parameters<typeof h.action>[0];
type UpdatePayload = NonNullable<Operation['updates']>[number];

type ServerRow = {
  id: number;
  created_at: string;
  title_en: string;
  title_it: string;
  image: string;
  description_en: string;
  description_it: string;
  blurhashURL: string;
  post_tags: string;
  views: number;
  hidden: boolean;
  author_id: string;
  buttons: Array<{ kind: string; url: string }>;
  source_link?: string;
};

const ROWS: ServerRow[] = [
  {
    id: 1,
    created_at: '2024-03-01T00:00:00.000Z',
    title_en: 'Alpha',
    title_it: 'Alfa',
    image: 'https://cdn.example.com/alpha.png',
    description_en: 'Alpha desc',
    description_it: 'Alfa desc',
    blurhashURL: 'blur-alpha',
    post_tags: '"alpha"',
    views: 5,
    hidden: false,
    author_id: 'author-1',
    buttons: [{ kind: 'source', url: 'https://source.example.com' }],
    source_link: 'https://legacy.example.com',
  },
  {
    id: 2,
    created_at: '2024-04-01T00:00:00.000Z',
    title_en: 'Beta',
    title_it: 'Beta it',
    image: 'https://cdn.example.com/beta.png',
    description_en: 'Beta desc',
    description_it: 'Beta it desc',
    blurhashURL: 'blur-beta',
    post_tags: '"beta"',
    views: 9,
    hidden: false,
    author_id: 'author-1',
    buttons: [],
  },
];

/** Committed Markdown, the only bodies the fake reader can return. */
const BODIES: Record<number, { en: string; it: string }> = {
  1: { en: 'Alpha committed EN', it: 'Alfa committed IT' },
  2: { en: 'Beta committed EN', it: 'Beta committed IT' },
};

const bodyResponse = (id: number) => ({
  success: true,
  data: { id, body_en: BODIES[id]?.en, body_it: BODIES[id]?.it },
});

/** Fake server: `GET` carries bodies, `GET_LIST` never does. */
function respond(operation: Operation): unknown {
  switch (operation.type) {
    case 'GET':
      return {
        success: true,
        data: ROWS.map((row) => ({
          ...row,
          body_en: BODIES[row.id]?.en,
          body_it: BODIES[row.id]?.it,
        })),
      };
    case 'GET_LIST':
      return { success: true, data: ROWS.map((row) => ({ ...row })) };
    case 'GET_AUTHORS':
      return {
        success: true,
        data: [
          { id: 'author-1', display_name: 'Author One', avatar_url: null },
        ],
      };
    case 'GET_BODIES':
      return BODIES[operation.id ?? 0]
        ? bodyResponse(operation.id ?? 0)
        : { success: false, error: 'Portfolio post not found' };
    case 'BATCH_PUBLISH':
      return {
        success: true,
        data: {
          created: (operation.creates ?? []).map((item) => item.tempId),
          createdIds: {},
          updated: (operation.updates ?? []).map((item) => item.id),
          deleted: operation.deletes ?? [],
          reordered: [],
          failed: [],
        },
      };
    default:
      return { success: true, data: null };
  }
}

function setGate(enabled: boolean): void {
  vi.stubEnv(
    'NEXT_PUBLIC_CMS_BODY_LAZY_LOAD_ENABLED',
    enabled ? 'true' : 'false'
  );
  vi.stubEnv(
    'NEXT_PUBLIC_SUPABASE_DB_SCHEMA',
    enabled ? 'dev_staging' : 'public'
  );
}

let root: Root;
let container: HTMLDivElement;

const actionTypes = () =>
  h.action.mock.calls.map(([operation]) => operation.type);
const batchCalls = () =>
  h.action.mock.calls
    .map(([operation]) => operation)
    .filter((operation) => operation.type === 'BATCH_PUBLISH');
const lastUpdate = (): UpdatePayload | undefined =>
  batchCalls().at(-1)?.updates?.[0];

const rowFor = (title: string): HTMLElement => {
  const row = [...container.querySelectorAll('li')].find((item) =>
    item.textContent?.includes(title)
  );
  if (!row) throw new Error(`Missing row: ${title}`);
  return row as HTMLElement;
};

const bodyText = () =>
  container.querySelector<HTMLElement>('#portfolio-body')?.textContent ?? null;

const findInputWithValue = (value: string): HTMLInputElement => {
  const input = [...container.querySelectorAll('input')].find(
    (item) => item.value === value
  );
  if (!input) throw new Error(`Missing input with value: ${value}`);
  return input;
};

const clickByLabel = async (scope: ParentNode, label: string) => {
  const button = scope.querySelector<HTMLElement>(
    `button[aria-label="${label}"]`
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {});
};

const clickByText = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {});
};

const setInputValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const setBodyMarkdown = async (markdown: string) => {
  const editor = container.querySelector<HTMLElement>('#portfolio-body');
  if (!editor) throw new Error('Body editor is not open');
  await act(async () => {
    editor.innerHTML = `<p data-block="paragraph">${markdown}</p>`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
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
  });
  await act(async () => {});
};

const mount = async () => {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ cms: cmsEn }}>
        <PortfolioSection />
      </NextIntlClientProvider>
    );
  });
  await act(async () => {});
};

const publish = async () => {
  await act(async () => {
    await h.publish?.();
  });
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:staged');
      static revokeObjectURL = vi.fn();
    }
  );
  h.action.mockReset();
  h.publish = null;
  h.action.mockImplementation(async (operation) => respond(operation));
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

it('loads the full list with GET when the gate is off and keeps the legacy payload', async () => {
  setGate(false);
  await mount();

  expect(actionTypes()).toContain('GET');
  expect(actionTypes()).not.toContain('GET_LIST');
  expect(actionTypes()).not.toContain('GET_BODIES');
  expect(container.textContent).toContain('Alpha');

  // The editor opens on the bodies the list read already carried.
  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  expect(actionTypes()).not.toContain('GET_BODIES');
  expect(bodyText()).toBe(BODIES[1]?.en);
  expect(findInputWithValue('Alpha')).toBeTruthy();

  await clickByText(cmsEn.common.cancel);
  await clickByLabel(rowFor('Alpha'), cmsEn.common.hide);
  await publish();

  const update = lastUpdate();
  expect(update?.id).toBe(1);
  expect(update?.data.hidden).toBe(true);
  expect(Object.keys(update?.data ?? {}).sort()).toEqual([
    'author_id',
    'body_en',
    'body_it',
    'buttons',
    'created_at',
    'description_en',
    'description_it',
    'hidden',
    'post_tags',
    'title_en',
    'title_it',
  ]);
  expect(update?.data.body_en).toBe(BODIES[1]?.en);
  expect(update?.data.body_it).toBe(BODIES[1]?.it);
  expect(update?.bodyFiles).toEqual([]);
});

it('loads the metadata-only list and never reads bodies when the gate is on', async () => {
  setGate(true);
  await mount();

  expect(actionTypes()[0]).toBe('GET_LIST');
  expect(actionTypes()).not.toContain('GET');
  expect(actionTypes()).not.toContain('GET_BODIES');
  expect(container.textContent).toContain('Alpha');
  expect(container.textContent).toContain('Alpha desc');
  expect(container.textContent).toContain('Beta');
});

it('opens an existing post by loading its bodies exactly once', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);

  expect(actionTypes().filter((type) => type === 'GET_BODIES')).toHaveLength(1);
  expect(h.action).toHaveBeenCalledWith({ type: 'GET_BODIES', id: 1 });
  expect(container.textContent).toContain(cmsEn.portfolio.editPost);
  expect(bodyText()).toBe(BODIES[1]?.en);
  expect(findInputWithValue('Alpha')).toBeTruthy();
  // The row's buttons (derived from its legacy link columns) reach the editor.
  expect(findInputWithValue('https://source.example.com')).toBeTruthy();
});

it('keeps a staged new post local and never reads bodies for it', async () => {
  setGate(true);
  await mount();

  await clickByText(cmsEn.portfolio.addPortfolioPost);
  await setInputValue(
    container.querySelector<HTMLInputElement>(
      'input[type="text"]'
    ) as HTMLInputElement,
    'Local project'
  );
  await setBodyMarkdown('Local body EN');
  await attachCover();
  await clickByText(cmsEn.editor.addDraft);

  expect(rowFor('Local project')).toBeTruthy();
  expect(actionTypes()).not.toContain('GET_BODIES');

  // Reopening the pending create stays local, with its draft Markdown intact.
  await clickByLabel(rowFor('Local project'), cmsEn.common.edit);
  expect(actionTypes()).not.toContain('GET_BODIES');
  expect(bodyText()).toBe('Local body EN');

  await clickByText(cmsEn.common.cancel);
  await publish();

  const create = batchCalls().at(-1)?.creates?.[0];
  expect(create?.data.body_en).toBe('Local body EN');
  expect(create?.data.body_it).toBe('');
});

it('surfaces a failed body read, keeps the editor closed, and retries', async () => {
  setGate(true);
  await mount();

  h.action.mockImplementation(async (operation) =>
    operation.type === 'GET_BODIES'
      ? { success: false, error: 'Storage read failed' }
      : respond(operation)
  );
  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);

  expect(container.textContent).toContain('Storage read failed');
  expect(container.querySelector('#portfolio-body')).toBeNull();
  expect(container.textContent).toContain(cmsEn.portfolio.postsTitle);
  expect(rowFor('Alpha')).toBeTruthy();

  // A retry (second Edit) reads again and finally opens the editor.
  h.action.mockImplementation(async (operation) => respond(operation));
  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);

  expect(bodyText()).toBe(BODIES[1]?.en);
  expect(container.textContent).not.toContain('Storage read failed');
  expect(actionTypes().filter((type) => type === 'GET_BODIES')).toHaveLength(2);
});

it('drops a stale body response instead of overwriting the editor', async () => {
  setGate(true);
  const pending: Array<(value: unknown) => void> = [];
  h.action.mockImplementation(async (operation) => {
    if (operation.type === 'GET_BODIES') {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending.push(resolve);
      return await promise;
    }
    return respond(operation);
  });
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  await clickByLabel(rowFor('Beta'), cmsEn.common.edit);
  expect(pending).toHaveLength(2);

  // Beta's bodies arrive first and open its editor.
  await act(async () => {
    pending[1]?.({ ...bodyResponse(2) });
  });
  expect(bodyText()).toBe(BODIES[2]?.en);
  expect(findInputWithValue('Beta')).toBeTruthy();

  // Alpha's late response must not touch the open editor.
  await act(async () => {
    pending[0]?.({ ...bodyResponse(1) });
  });
  expect(bodyText()).toBe(BODIES[2]?.en);
  expect(findInputWithValue('Beta')).toBeTruthy();
  expect(container.textContent).not.toContain(BODIES[1]?.en ?? 'Alpha');
});

it('sends no body field for a visibility-only update', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.hide);
  await publish();

  const update = lastUpdate();
  expect(update?.id).toBe(1);
  expect(update?.data.hidden).toBe(true);
  expect(Object.keys(update?.data ?? {}).sort()).toEqual([
    'author_id',
    'buttons',
    'created_at',
    'description_en',
    'description_it',
    'hidden',
    'post_tags',
    'title_en',
    'title_it',
  ]);
  expect(update?.bodyFiles).toEqual([]);
});

it('sends no body field for a metadata-only update', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  await setInputValue(findInputWithValue('Alpha'), 'Alpha renamed');
  await clickByText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastUpdate();
  expect(update?.data.title_en).toBe('Alpha renamed');
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(update?.bodyFiles).toEqual([]);
});

it('sends only the locale that changed, and both when both changed', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  await setBodyMarkdown('Alpha EDITED EN');
  await clickByText(cmsEn.editor.applyDraft);
  await publish();

  const enUpdate = lastUpdate();
  expect(enUpdate?.data.body_en).toBe('Alpha EDITED EN');
  expect(enUpdate?.data).not.toHaveProperty('body_it');
  expect(enUpdate?.data.buttons).toEqual(ROWS[0]?.buttons);

  // A fresh open loads again; both locales are then edited.
  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  await setBodyMarkdown('Alpha EDITED EN again');
  await clickByText(cmsEn.common.italian);
  await setBodyMarkdown('Alfa EDITED IT');
  await clickByText(cmsEn.editor.applyDraft);
  await publish();

  const bothUpdate = lastUpdate();
  expect(bothUpdate?.data.body_en).toBe('Alpha EDITED EN again');
  expect(bothUpdate?.data.body_it).toBe('Alfa EDITED IT');
});

it('sends neither body field when the edit is reverted to the baseline', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  await setBodyMarkdown('Temporary EN');
  await setBodyMarkdown(BODIES[1]?.en ?? '');
  await clickByText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastUpdate();
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(update?.bodyFiles).toEqual([]);
});

it('keeps an unresolved body draft across a reopen and rebases its baseline', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  await setBodyMarkdown('Alpha EDITED EN');
  await clickByText(cmsEn.editor.applyDraft);

  // Reopening reads the committed Markdown again but must not discard the
  // local edit the draft still holds.
  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  expect(bodyText()).toBe('Alpha EDITED EN');
  expect(actionTypes().filter((type) => type === 'GET_BODIES')).toHaveLength(2);

  await clickByText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastUpdate();
  expect(update?.data.body_en).toBe('Alpha EDITED EN');
  expect(update?.data).not.toHaveProperty('body_it');
});

it('sends no body field for a buttons-only change and keeps buttons intact', async () => {
  setGate(true);
  await mount();

  await clickByLabel(rowFor('Alpha'), cmsEn.common.edit);
  const urlInput = container.querySelector<HTMLInputElement>(
    `input[aria-label="${cmsEn.portfolio.buttonUrlLabel}"]`
  );
  if (!urlInput) throw new Error('Missing button URL input');
  await setInputValue(urlInput, 'https://changed.example.com');
  await clickByText(cmsEn.editor.applyDraft);
  await publish();

  const update = lastUpdate();
  expect(update?.data.buttons).toEqual([
    { kind: 'source', url: 'https://changed.example.com' },
  ]);
  expect(update?.data).not.toHaveProperty('body_en');
  expect(update?.data).not.toHaveProperty('body_it');
  expect(Object.keys(update?.data ?? {}).sort()).toEqual([
    'author_id',
    'buttons',
    'created_at',
    'description_en',
    'description_it',
    'hidden',
    'post_tags',
    'title_en',
    'title_it',
  ]);
});

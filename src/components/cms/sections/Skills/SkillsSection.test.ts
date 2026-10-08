// @vitest-environment happy-dom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';

type BatchPayload = {
  type: string;
  skillOrder: Array<{ id: number | string; position: number }>;
  categoryOrder: Array<{ id: number | string; position: number }>;
  updateSkills: Array<{
    id: number;
    data: { title: string; link: string | null };
  }>;
};

const h = vi.hoisted(() => ({
  skills: vi.fn<(operation: BatchPayload) => Promise<unknown>>(),
}));

vi.mock('@/app/actions/cms/sections/skillsActions', () => ({
  skillsActions: h.skills,
}));
vi.mock('@/hooks/cms/useSectionCallbacks', () => ({
  useSectionCallbacks: () => {},
}));
vi.mock('@/hooks/cms/useSectionDirty', () => ({ useSectionDirty: () => {} }));
vi.mock('next/image', async () => {
  const React = await import('react');
  return {
    default: (props: { src?: string; alt?: string; className?: string }) =>
      React.createElement('img', {
        src: props.src,
        alt: props.alt,
        className: props.className,
      }),
  };
});

import SkillsSection from '@/components/cms/sections/Skills/SkillsSection';

const messages = {
  cms: cmsEn,
  'skills-section': { title: 'Skills', subtitle: 'Stack' },
};

const initialCategories = [
  {
    id: 1,
    name: 'Languages',
    position: 0,
    skills: [
      {
        id: 10,
        title: 'TypeScript',
        icon: 'https://cdn.example.com/ts.svg',
        invert: false,
        category_id: 1,
        blurhashURL: '',
        link: null,
        position: 0,
      },
      {
        id: 11,
        title: 'Rust',
        icon: 'https://cdn.example.com/rs.svg',
        invert: false,
        category_id: 1,
        blurhashURL: '',
        link: null,
        position: 1,
      },
    ],
  },
  {
    id: 2,
    name: 'Tools',
    position: 1,
    skills: [
      {
        id: 20,
        title: 'Bun',
        icon: 'https://cdn.example.com/bun.svg',
        invert: false,
        category_id: 2,
        blurhashURL: '',
        link: null,
        position: null,
      },
    ],
  },
];

const committedBatch = {
  success: true,
  data: {
    created: [],
    createdIds: {},
    updated: [],
    deleted: [],
    reordered: [],
    failed: [],
    tempIdToRealId: {},
  },
  revalidation: 'sent',
};

let root: Root;
let container: HTMLDivElement;

async function mount(children: ReactNode) {
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages,
        children,
      })
    )
  );
}

function buttonByTitle(title: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.title === title
  );
  if (!node) throw new Error(`Missing button: ${title}`);
  return node;
}

function buttonByText(text: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!node) throw new Error(`Missing button: ${text}`);
  return node;
}

async function click(node: HTMLElement) {
  await act(async () =>
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
}

function skillCard(title: string) {
  const heading = [...document.querySelectorAll('h3')].find(
    (candidate) => candidate.textContent === title
  );
  const card = heading?.closest('div.rounded-lg');
  if (!card) throw new Error(`Missing skill card: ${title}`);
  return card;
}

async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set?.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function publish() {
  const publishButton = buttonByText('Publish');
  expect(publishButton.disabled).toBe(false);
  await click(publishButton);
  await click(
    buttonByText('Publish', document.querySelector('[role="dialog"]')!)
  );
}

function batchPayload(): BatchPayload {
  const call = h.skills.mock.calls.find(
    ([operation]) => operation.type === 'BATCH_PUBLISH'
  );
  if (!call) throw new Error('No BATCH_PUBLISH dispatched');
  return call[0];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  h.skills
    .mockReset()
    .mockImplementation(async ({ type }) =>
      type === 'GET'
        ? { success: true, data: structuredClone(initialCategories) }
        : committedBatch
    );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('skills reorder dispatch', () => {
  it('publishes a dense per-category skillOrder payload after a move', async () => {
    await mount(createElement(SkillsSection));

    await click(buttonByTitle('Move up', skillCard('Rust')));
    await publish();

    const payload = batchPayload();
    expect(payload.skillOrder).toEqual([
      { id: 11, position: 0 },
      { id: 10, position: 1 },
      { id: 20, position: 0 },
    ]);
    expect(payload.categoryOrder).toEqual([]);
  });

  it('sends no skillOrder and the new link when only a link was edited', async () => {
    await mount(createElement(SkillsSection));

    const card = skillCard('TypeScript');
    await click(buttonByTitle('Edit', card));
    const linkInput = card.querySelector<HTMLInputElement>(
      'input[placeholder="https://example.com (optional)"]'
    );
    if (!linkInput) throw new Error('Missing skill link field');
    await fill(linkInput, 'https://www.typescriptlang.org/');
    await click(buttonByText('Done', card));
    await publish();

    const payload = batchPayload();
    expect(payload.skillOrder).toEqual([]);
    expect(payload.updateSkills).toEqual([
      {
        id: 10,
        data: {
          title: 'TypeScript',
          icon: 'https://cdn.example.com/ts.svg',
          invert: false,
          link: 'https://www.typescriptlang.org/',
        },
      },
    ]);
  });

  it('publishes category swaps and retries failed skill ordering without losing drafts', async () => {
    h.skills.mockImplementation(async ({ type }) =>
      type === 'GET'
        ? { success: true, data: structuredClone(initialCategories) }
        : {
            ...committedBatch,
            success: false,
            error: 'Skill order failed',
            data: {
              ...committedBatch.data,
              reordered: [2, 1, 'skill:11'],
              failed: [{ kind: 'reorder', id: 'skill:10', error: 'db down' }],
            },
          }
    );
    await mount(createElement(SkillsSection));
    const tools = [...document.querySelectorAll('h2')]
      .find((heading) => heading.textContent === 'Tools')
      ?.closest('div.rounded-xl');
    if (!tools) throw new Error('Missing tools category');
    await click(buttonByTitle('Move up', tools));
    await click(buttonByTitle('Move up', skillCard('Rust')));
    await publish();
    expect(batchPayload().categoryOrder).toEqual([
      { id: 2, position: 0 },
      { id: 1, position: 1 },
    ]);
    await publish();
    const batches = h.skills.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.type === 'BATCH_PUBLISH');
    expect(batches[1].categoryOrder).toEqual([]);
    expect(batches[1].skillOrder).toEqual([
      { id: 20, position: 0 },
      { id: 11, position: 0 },
      { id: 10, position: 1 },
    ]);
  });

  it('redensifies surviving skills after a pending delete', async () => {
    await mount(createElement(SkillsSection));
    await click(buttonByTitle('Delete', skillCard('TypeScript')));
    await publish();
    expect(batchPayload().skillOrder).toEqual([
      { id: 11, position: 0 },
      { id: 20, position: 0 },
    ]);
  });
});

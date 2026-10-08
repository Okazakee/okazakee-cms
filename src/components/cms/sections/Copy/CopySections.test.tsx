// @vitest-environment happy-dom
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';
import { useCmsStore } from '@/store/cmsStore';

const h = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('@/app/actions/cms/sections/i18nActions', () => ({
  i18nActions: h.action,
}));

import { RequestCopySection } from './CopySections';

let root: Root;
let container: HTMLDivElement;
const initialStore = useCmsStore.getState();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useCmsStore.setState({
    ...initialStore,
    user: {
      id: 'copy-admin',
      email: 'admin@example.test',
      displayName: 'Admin',
      avatarUrl: null,
      role: 'admin',
      authProvider: 'email',
      githubUsername: null,
    },
    publishQueue: {},
    sectionCallbacks: {},
  });
  h.action.mockReset();
  h.action.mockResolvedValue({
    success: true,
    data: [
      {
        language: 'en',
        translations: {
          'request-form': {
            extra: { enOnly: 'English original' },
            constructor: 'Constructor copy',
          },
        },
      },
      {
        language: 'it',
        translations: {
          'request-form': {
            extra: { itOnly: 'Italian original' },
            toString: 'String conversion copy',
          },
        },
      },
    ],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCmsStore.setState(initialStore, true);
  vi.unstubAllGlobals();
});

function field(key: string, locale: string): HTMLTextAreaElement {
  const node = container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="request-form.${key} (${locale})"]`
  );
  if (!node) throw new Error(`Missing ${key} for ${locale}`);
  return node;
}

async function change(node: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set?.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectLocale(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label
  );
  if (!button) throw new Error(`Missing language control: ${label}`);
  await act(async () => button.click());
}

it('keeps unknown keys from either locale editable and retains both drafts across language switches', async () => {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={{ cms: cmsEn }}>
        <RequestCopySection />
      </NextIntlClientProvider>
    )
  );
  expect(field('extra.enOnly', 'EN').value).toBe('English original');
  expect(field('extra.itOnly', 'EN').value).toBe('');
  expect(field('constructor', 'EN').value).toBe('Constructor copy');
  expect(field('toString', 'EN').value).toBe('');
  await change(field('extra.enOnly', 'EN'), 'English draft');

  await selectLocale(cmsEn.common.italian);
  expect(field('extra.itOnly', 'IT').value).toBe('Italian original');
  expect(field('extra.enOnly', 'IT').value).toBe('');
  expect(field('toString', 'IT').value).toBe('String conversion copy');
  expect(field('constructor', 'IT').value).toBe('');
  await change(field('extra.itOnly', 'IT'), 'Italian draft');

  await selectLocale(cmsEn.common.english);
  expect(field('extra.enOnly', 'EN').value).toBe('English draft');
  await selectLocale(cmsEn.common.italian);
  expect(field('extra.itOnly', 'IT').value).toBe('Italian draft');
  expect(useCmsStore.getState().publishQueue['request-form'].isDirty).toBe(
    true
  );
  expect(h.action.mock.calls.map(([operation]) => operation.type)).toEqual([
    'GET',
  ]);
});

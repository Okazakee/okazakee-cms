// @vitest-environment happy-dom
import { type AbstractIntlMessages, NextIntlClientProvider } from 'next-intl';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/cms.en.json';
import itMessages from '@/i18n/messages/cms.it.json';
import type { RequestEntry } from '@/types/requestEntry.types';
import RequestsSection from './RequestsSection';

const h = vi.hoisted(() => ({
  list: vi.fn<(filter: string) => Promise<unknown>>(),
  archive: vi.fn<(id: number, archived: boolean) => Promise<unknown>>(),
  remove: vi.fn<(id: number) => Promise<unknown>>(),
}));

vi.mock('@/app/actions/cms/sections/requestEntriesActions', () => ({
  requestEntriesActions: (operation: {
    type: string;
    filter?: string;
    id?: number;
    archived?: boolean;
  }) => {
    if (operation.type === 'LIST') return h.list(operation.filter ?? 'active');
    if (operation.type === 'ARCHIVE') {
      return h.archive(operation.id ?? 0, operation.archived ?? false);
    }
    return h.remove(operation.id ?? 0);
  },
}));

const IntlProvider = NextIntlClientProvider as unknown as React.ComponentType<{
  locale: string;
  timeZone: string;
  messages: AbstractIntlMessages;
}>;

const committedEvidence = {
  created: [],
  createdIds: {},
  updated: [1],
  reordered: [],
  failed: [],
};

function entry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: '1',
    createdAt: '2026-10-04T09:30:00.000Z',
    locale: 'en',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    website: 'https://example.com',
    type: 'Web app',
    budget: '€5–15k',
    timeline: 'ASAP',
    request: 'Engine metrics dashboard.',
    consent: true,
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

let root: Root | null = null;

async function mount(
  locale: 'en' | 'it',
  messages: Record<string, unknown>
): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(
          IntlProvider,
          {
            locale,
            timeZone: 'Europe/Rome',
            messages: { cms: messages } as AbstractIntlMessages,
          },
          createElement(RequestsSection)
        )
      )
    );
  });
  return container;
}

/**
 * Matches a button by its EXACT trimmed label.
 *
 * A substring match is ambiguous here: the card's "Archive" action is a
 * prefix of the "Archived" filter tab, so a substring search would click the
 * filter instead of the action.
 */
function buttonByText(text: string, scope: ParentNode = document): HTMLElement {
  const match = [...scope.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text
  );
  if (!match) throw new Error(`button not found: ${text}`);
  return match as HTMLElement;
}

/**
 * The confirm dialog's own button. Scoped to `[role="dialog"]` because the
 * dialog's "Delete" label is identical to the row's "Delete" action.
 */
function dialogButton(text: string): HTMLElement {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('confirm dialog not open');
  return buttonByText(text, dialog);
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.list.mockReset();
  h.archive.mockReset();
  h.remove.mockReset();
  h.list.mockResolvedValue({ success: true, data: [] });
  h.archive.mockResolvedValue({ success: true, data: committedEvidence });
  h.remove.mockResolvedValue({
    success: true,
    data: { ...committedEvidence, updated: [], deleted: [1] },
  });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('RequestsSection', () => {
  it('loads the active inbox and renders the submitter', async () => {
    h.list.mockResolvedValue({ success: true, data: [entry()] });
    const container = await mount('en', en);
    expect(h.list).toHaveBeenCalledWith('active');
    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).toContain('Analytical Engines');
    expect(container.textContent).toContain('Engine metrics dashboard.');
  });

  it('says so when the active inbox is empty', async () => {
    const container = await mount('en', en);
    expect(container.textContent).toContain('No open requests.');
  });

  it('shows the archived empty state under the archived filter', async () => {
    const container = await mount('en', en);
    await click(buttonByText('Archived', container));
    expect(h.list).toHaveBeenLastCalledWith('archived');
    expect(container.textContent).toContain('No archived requests.');
  });

  it('surfaces a failed load instead of an empty inbox', async () => {
    h.list.mockResolvedValue({
      success: false,
      error: 'relation "project_requests" does not exist',
    });
    const container = await mount('en', en);
    expect(container.textContent).toContain('relation "project_requests"');
    expect(container.textContent).not.toContain('No open requests.');
  });

  it('reports an unreadable stored row rather than hiding it', async () => {
    h.list.mockResolvedValue({
      success: true,
      data: [entry()],
      malformed: ['7'],
    });
    const container = await mount('en', en);
    expect(container.textContent).toContain(
      '1 stored request(s) could not be read'
    );
  });

  it('archives an entry through the mutation and drops it from the list', async () => {
    h.list.mockResolvedValue({ success: true, data: [entry()] });
    const container = await mount('en', en);
    await click(buttonByText('Archive', container));
    expect(h.archive).toHaveBeenCalledWith(1, true);
    expect(container.textContent).not.toContain('Ada Lovelace');
  });

  it('keeps the entry and reports the error when archiving reports no-change', async () => {
    h.list.mockResolvedValue({ success: true, data: [entry()] });
    h.archive.mockResolvedValue({
      success: false,
      error: 'Request 1 is missing or already archived',
    });
    const container = await mount('en', en);
    await click(buttonByText('Archive', container));
    expect(container.textContent).toContain('already archived');
    expect(container.textContent).toContain('Ada Lovelace');
  });

  it('restores an archived entry', async () => {
    h.list.mockResolvedValue({
      success: true,
      data: [entry({ archived: true, archivedAt: '2026-10-05T10:00:00.000Z' })],
    });
    const container = await mount('en', en);
    expect(container.textContent).toContain('Archived');
    await click(buttonByText('Restore', container));
    expect(h.archive).toHaveBeenCalledWith(1, false);
  });

  it('confirms before deleting, then deletes', async () => {
    h.list.mockResolvedValue({ success: true, data: [entry()] });
    const container = await mount('en', en);
    await click(buttonByText('Delete', container));
    expect(h.remove).not.toHaveBeenCalled();
    await click(dialogButton('Delete'));
    expect(h.remove).toHaveBeenCalledWith(1);
    expect(container.textContent).not.toContain('Ada Lovelace');
  });

  it('keeps the entry when deleting reports no-change', async () => {
    h.list.mockResolvedValue({ success: true, data: [entry()] });
    h.remove.mockResolvedValue({
      success: false,
      error: 'Request 1 no longer exists',
    });
    const container = await mount('en', en);
    await click(buttonByText('Delete', container));
    await click(dialogButton('Delete'));
    expect(container.textContent).toContain('no longer exists');
    expect(container.textContent).toContain('Ada Lovelace');
  });

  it('resolves its labels in Italian too', async () => {
    const container = await mount('it', itMessages);
    expect(container.textContent).toContain('Richieste di progetto');
    expect(container.textContent).toContain('Archiviate');
  });
});

describe('requests message parity', () => {
  it('keeps the same label keys in both CMS locales', () => {
    expect(Object.keys(itMessages.requests).sort()).toEqual(
      Object.keys(en.requests).sort()
    );
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RequestEntry } from '@/types/requestEntry.types';
import { type RequestEntryActions, RequestEntryList } from './RequestEntryList';

const t = (key: string) => key;

const noopActions: RequestEntryActions = {
  busyId: null,
  setArchived: vi.fn(),
  remove: vi.fn(),
};

const entry: RequestEntry = {
  id: 'r-1',
  createdAt: '2026-03-04T09:30:00.000Z',
  locale: 'en',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  website: 'https://example.com',
  type: 'Web app',
  budget: '€5–15k',
  timeline: 'ASAP',
  request: 'A dashboard for engine metrics.\nSecond paragraph.',
  consent: true,
  archived: false,
  archivedAt: null,
};

const render = (
  entries: RequestEntry[],
  actions: RequestEntryActions = noopActions
) =>
  renderToStaticMarkup(
    createElement(RequestEntryList, { actions, entries, t })
  );

describe('RequestEntryList', () => {
  it('renders the submitter identity, company and contact links', () => {
    const html = render([entry]);
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Analytical Engines');
    expect(html).toContain('href="mailto:ada@example.com"');
    expect(html).toContain('href="https://example.com"');
  });

  it('renders the selection options as distinct values', () => {
    const html = render([entry]);
    expect(html).toContain('Web app');
    expect(html).toContain('€5–15k');
    expect(html).toContain('ASAP');
  });

  it('keeps the multi-paragraph request body readable', () => {
    const html = render([entry]);
    expect(html).toContain('A dashboard for engine metrics.');
    expect(html).toContain('Second paragraph.');
    // No markdown/em wrapper: the message is plain text.
    expect(html).not.toContain('<em>');
  });

  it('marks a timestamp and the browsing locale for a valid date', () => {
    const html = render([entry]);
    expect(html).toContain('dateTime="2026-03-04T09:30:00.000Z"');
    expect(html).toContain('EN');
  });

  it('omits the timestamp rather than rendering Invalid Date', () => {
    const html = render([{ ...entry, createdAt: 'not-a-date' }]);
    expect(html).not.toContain('<time');
    expect(html).not.toContain('Invalid Date');
  });

  it('distinguishes an accepted privacy policy from a missing one', () => {
    expect(render([entry])).toContain('consentGiven');
    expect(render([{ ...entry, consent: false }])).toContain('consentMissing');
  });

  it('drops the website link when the field is empty', () => {
    const html = render([{ ...entry, website: '' }]);
    expect(html).toContain('href="mailto:ada@example.com"');
    expect(html).not.toContain('https://example.com');
  });

  it('renders one article per entry', () => {
    const html = render([entry, { ...entry, id: 'r-2', name: 'Grace Hopper' }]);
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toContain('Grace Hopper');
  });

  it('offers archive on an active entry and restore on an archived one', () => {
    expect(render([entry])).toContain('archive');
    expect(render([entry])).not.toContain('restore');
    expect(
      render([
        { ...entry, archived: true, archivedAt: '2026-03-05T10:00:00.000Z' },
      ])
    ).toContain('restore');
  });

  it('badges an archived entry so the state is visible without the filter', () => {
    const html = render([
      { ...entry, archived: true, archivedAt: '2026-03-05T10:00:00.000Z' },
    ]);
    expect(html).toContain('archivedBadge');
  });

  it('disables both actions while that entry is the busy one', () => {
    const html = render([entry], { ...noopActions, busyId: 'r-1' });
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

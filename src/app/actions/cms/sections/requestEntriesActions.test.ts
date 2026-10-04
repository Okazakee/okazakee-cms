import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabase,
} from '@/testing/unit/supabaseFake';

const h = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
}));

vi.mock('@/libs/cms/supabase/admin', () => ({
  getCmsAdminClient: () => h.fake.client,
}));

vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => h.fake.client,
}));

import { requestEntriesActions } from '@/app/actions/cms/sections/requestEntriesActions';
import type { BatchCommitEvidence } from '@/libs/cms/batchEvidence';
import type { RequestEntry } from '@/types/requestEntry.types';

const ADMIN = [{ email: 'admin@example.com', role: 'admin' }];
const EDITOR = [{ email: 'editor@example.com', role: 'editor' }];

function storedRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    created_at: '2026-10-04T09:30:00.000Z',
    locale: 'en',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    website: 'https://example.com',
    project_type: 'Web app',
    budget: '€5–15k',
    timeline: 'ASAP',
    request: 'Engine metrics dashboard.',
    consent: true,
    archived: false,
    archived_at: null,
    ...overrides,
  };
}

function seed(
  rows: Array<Record<string, unknown>>,
  allowlist: Array<{ email: string; role: string }> = ADMIN
): FakeSupabase {
  return createFakeSupabase({
    tables: {
      cms_allowed_users: allowlist.map((entry) => ({ ...entry })),
      project_requests: rows,
    },
    user: { id: 'user-1', email: allowlist[0]?.email ?? 'admin@example.com' },
  });
}

function evidence(result: { data?: unknown }): BatchCommitEvidence {
  return result.data as BatchCommitEvidence;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requestEntriesActions authorization', () => {
  it('refuses an editor: requests hold personal data', async () => {
    h.fake = seed([], EDITOR);
    const result = await requestEntriesActions({
      type: 'LIST',
      filter: 'active',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Admin');
    expect(result.data).toBeUndefined();
  });

  it('never reads the table before the role check passes', async () => {
    h.fake = seed([storedRequest()], EDITOR);
    await requestEntriesActions({ type: 'LIST', filter: 'active' });
    expect(
      h.fake.state.log.filter((entry) => entry.table === 'project_requests')
    ).toHaveLength(0);
  });
});

describe('requestEntriesActions LIST', () => {
  it('maps stored rows onto the inbox shape', async () => {
    h.fake = seed([storedRequest()]);
    const result = await requestEntriesActions({
      type: 'LIST',
      filter: 'active',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual<RequestEntry[]>([
      {
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
      },
    ]);
  });

  it('filters archived rows out of the active inbox', async () => {
    h.fake = seed([
      storedRequest({ id: 1 }),
      storedRequest({
        id: 2,
        name: 'Grace Hopper',
        archived: true,
        archived_at: '2026-10-05T10:00:00.000Z',
      }),
    ]);
    const result = await requestEntriesActions({
      type: 'LIST',
      filter: 'active',
    });
    const entries = result.data as RequestEntry[];
    expect(entries.map((entry) => entry.name)).toEqual(['Ada Lovelace']);
  });

  it('returns only archived rows for the archived filter', async () => {
    h.fake = seed([
      storedRequest({ id: 1 }),
      storedRequest({
        id: 2,
        name: 'Grace Hopper',
        archived: true,
        archived_at: '2026-10-05T10:00:00.000Z',
      }),
    ]);
    const result = await requestEntriesActions({
      type: 'LIST',
      filter: 'archived',
    });
    const entries = result.data as RequestEntry[];
    expect(entries.map((entry) => entry.name)).toEqual(['Grace Hopper']);
    expect(entries[0].archivedAt).toBe('2026-10-05T10:00:00.000Z');
  });

  it('reports a storage failure instead of an empty inbox', async () => {
    h.fake = createFakeSupabase({
      tables: { cms_allowed_users: ADMIN },
      user: { id: 'user-1', email: 'admin@example.com' },
      failNext: {
        table: 'project_requests',
        mode: 'select',
        message: 'relation "project_requests" does not exist',
        code: '42P01',
      },
    });
    const result = await requestEntriesActions({
      type: 'LIST',
      filter: 'active',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('project_requests');
    expect(result.data).toBeUndefined();
  });

  it('flags a row it cannot read rather than dropping it silently', async () => {
    h.fake = seed([storedRequest(), storedRequest({ id: 7, email: 'nope' })]);
    const result = await requestEntriesActions({
      type: 'LIST',
      filter: 'active',
    });
    expect(result.data as RequestEntry[]).toHaveLength(1);
    expect(result.malformed).toEqual(['7']);
  });
});

describe('requestEntriesActions ARCHIVE', () => {
  it('toggles the flag and returns the committed id', async () => {
    h.fake = seed([storedRequest()]);
    const result = await requestEntriesActions({
      type: 'ARCHIVE',
      id: 1,
      archived: true,
    });
    expect(result.success).toBe(true);
    expect(evidence(result).updated).toEqual([1]);
    expect(evidence(result).failed).toEqual([]);
    expect(h.fake.state.tables.project_requests[0].archived).toBe(true);
    expect(h.fake.state.tables.project_requests[0].archived_at).toEqual(
      expect.any(String)
    );
  });

  it('restores an archived row and clears the archive timestamp', async () => {
    h.fake = seed([
      storedRequest({
        archived: true,
        archived_at: '2026-10-05T10:00:00.000Z',
      }),
    ]);
    const result = await requestEntriesActions({
      type: 'ARCHIVE',
      id: 1,
      archived: false,
    });
    expect(result.success).toBe(true);
    expect(evidence(result).updated).toEqual([1]);
    expect(h.fake.state.tables.project_requests[0].archived).toBe(false);
    expect(h.fake.state.tables.project_requests[0].archived_at).toBeNull();
  });

  it('reports no-change when the row is already in the target state', async () => {
    h.fake = seed([storedRequest()]);
    const result = await requestEntriesActions({
      type: 'ARCHIVE',
      id: 1,
      archived: false,
    });
    expect(result.success).toBe(false);
    expect(evidence(result).updated).toEqual([]);
    expect(evidence(result).failed).toEqual([
      { kind: 'update', id: 1, error: expect.stringContaining('missing') },
    ]);
  });

  it('reports no-change for a missing id instead of a silent success', async () => {
    h.fake = seed([]);
    const result = await requestEntriesActions({
      type: 'ARCHIVE',
      id: 99,
      archived: true,
    });
    expect(result.success).toBe(false);
    expect(evidence(result).updated).toEqual([]);
    expect(result.error).toContain('99');
  });

  it('rejects a non-positive id without touching the table', async () => {
    h.fake = seed([storedRequest()]);
    const result = await requestEntriesActions({
      type: 'ARCHIVE',
      id: 0,
      archived: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid request id');
    expect(h.fake.state.tables.project_requests[0].archived).toBe(false);
  });
});

describe('requestEntriesActions DELETE', () => {
  it('removes the row and returns the committed id', async () => {
    h.fake = seed([storedRequest()]);
    const result = await requestEntriesActions({ type: 'DELETE', id: 1 });
    expect(result.success).toBe(true);
    expect(evidence(result).deleted).toEqual([1]);
    expect(h.fake.state.tables.project_requests).toHaveLength(0);
  });

  it('reports no-change for an id that no longer exists', async () => {
    h.fake = seed([]);
    const result = await requestEntriesActions({ type: 'DELETE', id: 99 });
    expect(result.success).toBe(false);
    expect(evidence(result).deleted).toEqual([]);
    expect(evidence(result).failed).toEqual([
      { kind: 'delete', id: 99, error: 'Request 99 no longer exists' },
    ]);
  });

  it('surfaces a storage error as a failure with evidence', async () => {
    h.fake = createFakeSupabase({
      tables: { cms_allowed_users: ADMIN, project_requests: [storedRequest()] },
      user: { id: 'user-1', email: 'admin@example.com' },
      failNext: {
        table: 'project_requests',
        mode: 'delete',
        message: 'permission denied for table project_requests',
      },
    });
    const result = await requestEntriesActions({ type: 'DELETE', id: 1 });
    expect(result.success).toBe(false);
    expect(evidence(result).deleted).toEqual([]);
    expect(evidence(result).failed[0].error).toContain('permission denied');
  });
});

import { describe, expect, it } from 'vitest';
import {
  bodyColumnFields,
  dirtyBodyLocales,
  isBodyLoaded,
  mergeFetchedBodies,
  type OptionalBodies,
  publishBodyFields,
  publishedBodies,
  reconcileListBodies,
  retainDraftBodies,
  rowBodies,
  withoutBodies,
} from '@/hooks/cms/postBodyState';

/**
 * The Phase 9B safety core: unknown must never be confused with empty, and an
 * edited body must survive both a refetch and a partial publish.
 */

describe('isBodyLoaded', () => {
  it('counts an empty string as loaded and undefined/null as unknown', () => {
    expect(isBodyLoaded('')).toBe(true);
    expect(isBodyLoaded('# body')).toBe(true);
    expect(isBodyLoaded(undefined)).toBe(false);
    expect(isBodyLoaded(null)).toBe(false);
  });
});

describe('dirtyBodyLocales', () => {
  it('treats an unloaded body as never dirty', () => {
    expect(dirtyBodyLocales({}, { en: '# a', it: '# b' })).toEqual({
      en: false,
      it: false,
    });
    expect(dirtyBodyLocales({ en: '# a', it: '# b' }, undefined)).toEqual({
      en: false,
      it: false,
    });
  });

  it('reports only the locales that changed', () => {
    expect(
      dirtyBodyLocales({ en: '# new', it: '# b' }, { en: '# old', it: '# b' })
    ).toEqual({ en: true, it: false });
    expect(
      dirtyBodyLocales({ en: '# a', it: '# new' }, { en: '# a', it: '# old' })
    ).toEqual({ en: false, it: true });
  });

  it('clears the flag when an edit is returned to its baseline', () => {
    const baseline = { en: '# a', it: '# b' };
    expect(dirtyBodyLocales({ en: '# changed', it: '# b' }, baseline).en).toBe(
      true
    );
    expect(dirtyBodyLocales({ en: '# a', it: '# b' }, baseline).en).toBe(false);
  });

  it('treats empty-vs-non-empty as a real change', () => {
    expect(dirtyBodyLocales({ en: '' }, { en: '# a' }).en).toBe(true);
    expect(dirtyBodyLocales({ en: '# a' }, { en: '' }).en).toBe(true);
    expect(dirtyBodyLocales({ en: '' }, { en: '' }).en).toBe(false);
  });
});

describe('publishBodyFields', () => {
  it('omits every key for a metadata-only or visibility-only edit', () => {
    const fields = publishBodyFields(
      { en: '# a', it: '# b' },
      { en: '# a', it: '# b' }
    );
    expect(fields).toEqual({});
    expect(Object.hasOwn(fields, 'en')).toBe(false);
    expect(Object.hasOwn(fields, 'it')).toBe(false);
  });

  it('never publishes an unloaded body', () => {
    const fields = publishBodyFields({}, { en: '# a', it: '# b' });
    expect(Object.hasOwn(fields, 'en')).toBe(false);
    expect(Object.hasOwn(fields, 'it')).toBe(false);
  });

  it('sends only the changed locale', () => {
    expect(
      publishBodyFields({ en: '# new', it: '# b' }, { en: '# a', it: '# b' })
    ).toEqual({ en: '# new' });
    expect(
      publishBodyFields({ en: '# a', it: '# new' }, { en: '# a', it: '# b' })
    ).toEqual({ it: '# new' });
  });

  it('sends both locales when both changed', () => {
    expect(
      publishBodyFields({ en: '# e', it: '# i' }, { en: '# a', it: '# b' })
    ).toEqual({ en: '# e', it: '# i' });
  });

  it('drops a locale again once it is restored to its baseline', () => {
    const baseline = { en: '# a', it: '# b' };
    expect(publishBodyFields({ en: '# x', it: '# y' }, baseline)).toEqual({
      en: '# x',
      it: '# y',
    });
    expect(
      publishBodyFields({ en: '# a', it: '# y' }, baseline)
    ).toEqual({ it: '# y' });
    expect(publishBodyFields({ en: '# a', it: '# b' }, baseline)).toEqual({});
  });

  it('publishes a deliberately emptied body', () => {
    expect(publishBodyFields({ en: '', it: '# b' }, { en: '# a', it: '# b' })).toEqual(
      { en: '' }
    );
  });
});

describe('publishedBodies', () => {
  it('passes markdown only for published locales, so clean-locale staged images are excluded', () => {
    expect(
      publishedBodies({ en: '# new', it: '# b' }, { en: '# a', it: '# b' })
    ).toEqual(['# new', undefined]);
    expect(publishedBodies({}, undefined)).toEqual([undefined, undefined]);
  });
});

describe('mergeFetchedBodies', () => {
  const fetched = { en: '# server en', it: '# server it' };

  it('adopts the fetched text as baseline and current when nothing was edited', () => {
    expect(mergeFetchedBodies({ fetched })).toEqual({
      baseline: fetched,
      current: fetched,
    });
  });

  it('preserves a locally modified locale and rebases it on the fetched text', () => {
    const merged = mergeFetchedBodies({
      fetched,
      baseline: { en: '# old en', it: '# server it' },
      local: { en: '# local en', it: '# server it' },
    });
    expect(merged.baseline).toEqual(fetched);
    expect(merged.current).toEqual({
      en: '# local en',
      it: '# server it',
    });
    // Still dirty against the new baseline: the pending edit survives.
    expect(dirtyBodyLocales(merged.current, merged.baseline).en).toBe(true);
  });

  it('drops a local value that equals the previous baseline', () => {
    const merged = mergeFetchedBodies({
      fetched,
      baseline: { en: '# old en', it: '# server it' },
      local: { en: '# old en', it: '# server it' },
    });
    expect(merged.current).toEqual(fetched);
    expect(dirtyBodyLocales(merged.current, merged.baseline)).toEqual({
      en: false,
      it: false,
    });
  });

  it('keeps a locally emptied body', () => {
    const merged = mergeFetchedBodies({
      fetched,
      baseline: { en: '# old en', it: '# server it' },
      local: { en: '', it: '# server it' },
    });
    expect(merged.current.en).toBe('');
    expect(dirtyBodyLocales(merged.current, merged.baseline).en).toBe(true);
  });
});

describe('retainDraftBodies', () => {
  it('drops bodies entirely for a post with no unresolved draft', () => {
    const kept = retainDraftBodies({
      existing: { en: '# local', it: '# b' },
      baseline: { en: '# a', it: '# b' },
      modified: false,
    });
    expect(kept).toEqual({});
    expect(Object.keys(kept)).toEqual([]);
  });

  it('keeps only the dirty locale of an unresolved draft', () => {
    expect(
      retainDraftBodies({
        existing: { en: '# local', it: '# b' },
        baseline: { en: '# a', it: '# b' },
        modified: true,
      })
    ).toEqual({ en: '# local' });
  });

  it('keeps nothing for a metadata-only draft', () => {
    expect(
      retainDraftBodies({
        existing: { en: '# a', it: '# b' },
        baseline: { en: '# a', it: '# b' },
        modified: true,
      })
    ).toEqual({});
  });
});

describe('rowBodies / bodyColumnFields', () => {
  it('reads a row into the locale-keyed shape', () => {
    expect(rowBodies({ body_en: '# en', body_it: '# it' })).toEqual({
      en: '# en',
      it: '# it',
    });
    // A metadata-only row has no loaded bodies.
    expect(rowBodies({})).toEqual({ en: undefined, it: undefined });
  });

  it('renames locale keys back to payload columns, omitting absent ones', () => {
    const columns = bodyColumnFields({ en: '# en', it: '# it' });
    expect(columns).toEqual({ body_en: '# en', body_it: '# it' });
    expect(
      Object.keys(bodyColumnFields({ en: '# en' }))
    ).toEqual(['body_en']);
    expect(bodyColumnFields({})).toEqual({});
  });

  it('round-trips a row through both bridges without inventing bodies', () => {
    const row = { body_en: '# en' };
    expect(bodyColumnFields(rowBodies(row))).toEqual({ body_en: '# en' });
    expect(bodyColumnFields(rowBodies({}))).toEqual({});
  });

  it('carries an intentionally emptied body', () => {
    expect(bodyColumnFields({ en: '' })).toEqual({ body_en: '' });
  });
});

describe('withoutBodies', () => {
  it('removes the body fields without touching the rest of the row', () => {
    const row = { id: 4, title_en: 'T', body_en: '# en', body_it: '# it' };
    const stripped = withoutBodies(row);
    expect(Object.keys(stripped).sort()).toEqual(['id', 'title_en']);
    expect(stripped.id).toBe(4);
    expect(stripped.title_en).toBe('T');
    // The source row is untouched.
    expect(row.body_en).toBe('# en');
  });

  it('is a no-op for a row that already has no bodies', () => {
    expect(withoutBodies({ id: 4, title_en: 'T' })).toEqual({
      id: 4,
      title_en: 'T',
    });
  });
});

describe('reconcileListBodies', () => {
  type Row = {
    id: number;
    title_en: string;
    body_en?: string;
    body_it?: string;
  };
  const baseline = { en: '# committed en', it: '# committed it' };

  const run = (args: {
    rows: Row[];
    previousRows: Row[];
    baselines?: ReadonlyMap<number, OptionalBodies>;
    modified?: number[];
  }) =>
    reconcileListBodies({
      rows: args.rows,
      previousRows: args.previousRows,
      baselineFor: (id) => args.baselines?.get(id),
      isModified: (id) => (args.modified ?? []).includes(id),
    });

  it('leaves a metadata-only row without any body', () => {
    const rows = run({
      rows: [{ id: 4, title_en: 'Fresh' }],
      previousRows: [],
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'title_en']);
  });

  it('strips bodies a merged but unmodified draft still carried', () => {
    // `mergeServerWithDrafts` overlays the local draft snapshot, which can hold
    // bodies loaded when the editor was open. They are not owned by this row.
    const rows = run({
      rows: [{ id: 4, title_en: 'Draft title', body_en: '# en', body_it: '# it' }],
      previousRows: [{ id: 4, title_en: 'Draft title', body_en: '# en', body_it: '# it' }],
      baselines: new Map([[4, baseline]]),
      modified: [],
    });
    expect(rows[0]).toEqual({ id: 4, title_en: 'Draft title' });
    expect(Object.keys(rows[0] ?? {})).not.toContain('body_en');
    expect(Object.keys(rows[0] ?? {})).not.toContain('body_it');
  });

  it('keeps only the dirty locale of an unresolved body edit', () => {
    const rows = run({
      rows: [
        {
          id: 4,
          title_en: 'T',
          body_en: '# edited en',
          body_it: '# committed it',
        },
      ],
      previousRows: [
        {
          id: 4,
          title_en: 'T',
          body_en: '# edited en',
          body_it: '# committed it',
        },
      ],
      baselines: new Map([[4, baseline]]),
      modified: [4],
    });
    // EN is dirty and retained; the clean IT must not linger in list state.
    expect(rows[0]).toEqual({
      id: 4,
      title_en: 'T',
      body_en: '# edited en',
    });
    expect(Object.hasOwn(rows[0] ?? {}, 'body_it')).toBe(false);
  });

  it('keeps both locales when both differ from the baseline', () => {
    const rows = run({
      rows: [{ id: 4, title_en: 'T', body_en: '# e', body_it: '# i' }],
      previousRows: [{ id: 4, title_en: 'T', body_en: '# e', body_it: '# i' }],
      baselines: new Map([[4, baseline]]),
      modified: [4],
    });
    expect(rows[0]).toEqual({
      id: 4,
      title_en: 'T',
      body_en: '# e',
      body_it: '# i',
    });
  });

  it('drops every body for a modified row whose bodies match the baseline', () => {
    const rows = run({
      rows: [
        {
          id: 4,
          title_en: 'Renamed',
          body_en: baseline.en,
          body_it: baseline.it,
        },
      ],
      previousRows: [
        {
          id: 4,
          title_en: 'Renamed',
          body_en: baseline.en,
          body_it: baseline.it,
        },
      ],
      baselines: new Map([[4, baseline]]),
      modified: [4],
    });
    expect(rows[0]).toEqual({ id: 4, title_en: 'Renamed' });
  });

  it('preserves both authored languages of a pending create', () => {
    const rows = run({
      rows: [{ id: -1700000000000, title_en: 'New', body_en: '# new en', body_it: '# new it' }],
      previousRows: [],
      modified: [],
    });
    expect(rows[0]).toEqual({
      id: -1700000000000,
      title_en: 'New',
      body_en: '# new en',
      body_it: '# new it',
    });
  });

  it('tolerates a row with no previous state', () => {
    const rows = run({
      rows: [{ id: 9, title_en: 'Fresh', body_en: '# stray' }],
      previousRows: [],
      baselines: new Map([[9, baseline]]),
      modified: [9],
    });
    expect(rows[0]).toEqual({ id: 9, title_en: 'Fresh' });
  });
});

import { describe, expect, it } from 'vitest';
import { parseQueryJson } from '@/libs/cms/devMigrations/cliRunner';

const LIVE_ENVELOPE = JSON.stringify({
  boundary: 'ed6bcf41cdf9a4fedfa120f4bb607a99',
  rows: [{ probe: 1 }],
  warning: 'The query results below contain untrusted data from the database.',
});

describe('cliRunner parseQueryJson (live {rows} envelope)', () => {
  it('decodes the actual CLI {rows} envelope', () => {
    expect(parseQueryJson(LIVE_ENVELOPE)).toEqual([{ probe: 1 }]);
  });

  it('fails closed on empty stdout (never empty/success)', () => {
    expect(() => parseQueryJson('   \n')).toThrow(/\{rows/);
  });

  it('fails closed on non-JSON output', () => {
    expect(() => parseQueryJson('not json')).toThrow(/\{rows/);
  });

  it('fails closed on legacy {data} and bare-array shapes', () => {
    expect(() => parseQueryJson(JSON.stringify({ data: [{ a: 1 }] }))).toThrow(
      /\{rows/
    );
    expect(() => parseQueryJson(JSON.stringify([{ a: 1 }]))).toThrow(/\{rows/);
  });

  it('fails closed when rows is missing or not an array', () => {
    expect(() => parseQueryJson(JSON.stringify({ boundary: 'x' }))).toThrow(
      /\{rows/
    );
    expect(() =>
      parseQueryJson(JSON.stringify({ rows: { probe: 1 } }))
    ).toThrow(/\{rows/);
  });
});

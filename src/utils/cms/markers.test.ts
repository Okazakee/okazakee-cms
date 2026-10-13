// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  editorDomToMarkers,
  markersToHtml,
  parseMarkerRuns,
} from './markers';

// Cross-repo marker contract: mirrors okazakee-ws
// `src/utils/formatLabels.test.ts` (same `****([^*]+)****` semantics).
// Intentional differences: runs render as `<span data-marker="1">` here
// vs `<label>` on the site; this file escapes `&<>"` while the site also
// escapes `'` — inert as text either way.

const PAYLOAD =
  '<img src=x onerror="document.documentElement.dataset.xss=\'1\'">';

describe('parseMarkerRuns', () => {
  it('splits highlighted runs in order', () => {
    expect(parseMarkerRuns('a ****b**** c ****d**** e')).toEqual([
      { text: 'a ', highlighted: false },
      { text: 'b', highlighted: true },
      { text: ' c ', highlighted: false },
      { text: 'd', highlighted: true },
      { text: ' e', highlighted: false },
    ]);
  });

  it('splits adjacent runs without a separator', () => {
    expect(parseMarkerRuns('****a********b****')).toEqual([
      { text: 'a', highlighted: true },
      { text: 'b', highlighted: true },
    ]);
  });

  it('leaves unmatched markers as plain text', () => {
    expect(parseMarkerRuns('a **** b')).toEqual([
      { text: 'a **** b', highlighted: false },
    ]);
  });
});

describe('markersToHtml', () => {
  it('wraps runs in marker spans and escapes the rest', () => {
    expect(markersToHtml('Hi ****there**** <you>')).toBe(
      'Hi <span data-marker="1">there</span> &lt;you&gt;'
    );
  });

  it('neutralizes markup inside formatted regions', () => {
    const out = markersToHtml(`Hello ****${PAYLOAD}****`);
    expect(out).toContain('<span data-marker="1">&lt;img');
    expect(out).not.toMatch(/<[^>]*\sonerror=/);
    expect(out).toContain('</span>');
  });

  it('leaves single quotes literal (the site escapes them)', () => {
    expect(markersToHtml("a ****b**** 'q'")).toBe(
      'a <span data-marker="1">b</span> \'q\''
    );
  });
});

describe('editorDomToMarkers', () => {
  function roundTrip(value: string): string {
    const host = document.createElement('div');
    host.innerHTML = markersToHtml(value);
    return editorDomToMarkers(host);
  }

  it('round-trips plain, marked and multiline text', () => {
    expect(roundTrip('Hello world')).toBe('Hello world');
    expect(roundTrip('Cristian ****Di Carlo****')).toBe(
      'Cristian ****Di Carlo****'
    );
    expect(roundTrip('a ****b**** c ****d**** e')).toBe(
      'a ****b**** c ****d**** e'
    );
    expect(roundTrip('line one\nline two\n\nline four')).toBe(
      'line one\nline two\n\nline four'
    );
    expect(roundTrip('')).toBe('');
  });

  it('flattens foreign markup and nested markers', () => {
    const host = document.createElement('div');
    host.innerHTML =
      'a <b>bold</b> <span data-marker="1">x <span data-marker="1">y</span></span>';
    expect(editorDomToMarkers(host)).toBe('a bold ****x y****');
  });

  it('joins pasted block structure with newlines', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div>one</div><div>two</div>';
    expect(editorDomToMarkers(host)).toBe('one\ntwo');
  });
});

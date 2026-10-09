// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  editorDomToMarkers,
  markersToHtml,
  parseMarkerRuns,
} from './markers';

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

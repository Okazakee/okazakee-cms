// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  editorDomToMarkdown,
  markdownToEditorHtml,
  renderInlineRuns,
} from './bodyBlocks';

function roundTrip(markdown: string): string {
  const host = document.createElement('div');
  host.innerHTML = markdownToEditorHtml(markdown);
  return editorDomToMarkdown(host);
}

describe('renderInlineRuns', () => {
  it('maps bold, violet, code and links to tags', () => {
    expect(renderInlineRuns('a ****b**** c *d*')).toBe(
      'a <strong>b</strong> c <em>d</em>'
    );
    expect(renderInlineRuns('**b** and `c`')).toBe(
      '<strong>b</strong> and <code>c</code>'
    );
    expect(renderInlineRuns('[t](https://h.test/u)')).toBe(
      '<a data-href="https://h.test/u" title="https://h.test/u">t</a>'
    );
  });

  it('leaves unmatched markers and escapes literal', () => {
    expect(renderInlineRuns('a **** b <c>')).toBe('a **** b &lt;c&gt;');
  });
});

describe('markdownToEditorHtml', () => {
  it('hides headings, lists, fences, quotes, rules and tables', () => {
    const html = markdownToEditorHtml(
      '## Title\n\n- one\n- two\n\n```ts\ncode\n```\n\n> cited\n\n---\n\n| a | b |\n| --- | --- |\n| c | d |'
    );
    expect(html).toContain('<h2 data-block="heading" data-level="2">Title</h2>');
    expect(html).toContain('<ul data-block="list"');
    expect(html).toContain('<pre data-block="code" data-lang="ts">');
    expect(html).toContain('<blockquote data-block="quote">cited</blockquote>');
    expect(html).toContain('<hr data-block="hr">');
    expect(html).toContain('<table data-block="table">');
    expect(html).not.toContain('##');
    expect(html).not.toContain('```');
  });

  it('renders image lines as figures with hidden hash', () => {
    const html = markdownToEditorHtml(
      '![My photo-abc123](https://h.test/f.webp)'
    );
    expect(html).toContain('<figure data-block="image"');
    expect(html).toContain('<figcaption>My photo</figcaption>');
    // The hash rides along invisibly for serialization, never as text.
    expect(html).toContain('data-hash="abc123"');
    expect(html).not.toContain('>abc123<');
  });
});

describe('editorDomToMarkdown round-trips', () => {
  it('preserves headings, lists, fences and quotes', () => {
    const md = [
      '## Title',
      'Intro with ****bold**** and *violet* plus `code`.',
      '- one',
      '- two',
      '```ts\nconst a = 1;\n```',
      '> cited line',
      '---',
    ].join('\n\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('preserves numbered markers, tables, links and setext', () => {
    const md = [
      '1. one',
      '2. two',
      '| a | b |\n| --- | --- |\n| c | d |',
      'Read [more](https://h.test/u) here.',
      'Title text\n---',
    ].join('\n\n');
    expect(roundTrip(md)).toBe(md.replace('Title text\n---', '## Title text'));
  });

  it('preserves committed and pending images with hashes hidden', () => {
    const committed =
      '![My photo-abc123](https://h.test/f.webp)';
    const pending = '![cap-pending:9](blob:uuid)';
    // Single newlines between blocks normalize to blank lines (same render).
    expect(roundTrip(`x\n\n${committed}\n\n${pending}\ny`)).toBe(
      `x\n\n${committed}\n\n${pending}\n\ny`
    );
  });
});

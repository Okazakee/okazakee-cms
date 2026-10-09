import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownPreview } from './MarkdownPreview';

function render(markdown: string): string {
  return renderToStaticMarkup(<MarkdownPreview markdown={markdown} />);
}

describe('MarkdownPreview', () => {
  it('renders committed images as figures with caption only', () => {
    const html = render('![My photo-abc123](https://h.test/f.webp)');
    expect(html).toContain('<figure');
    expect(html).toContain('src="https://h.test/f.webp"');
    expect(html).toContain('<figcaption>My photo</figcaption>');
    expect(html).not.toContain('abc123');
  });

  it('renders blob-staged images without the pending marker', () => {
    const html = render('![cap-pending:9](blob:uuid)');
    expect(html).toContain('src="blob:uuid"');
    expect(html).toContain('<figcaption>cap</figcaption>');
    expect(html).not.toContain('pending');
  });

  it('keeps site truth: bold white, violet em, no label spans', () => {
    const html = render('a ****b**** c *d*');
    expect(html).toContain('<strong><strong>b</strong></strong>');
    expect(html).toContain('<em>d</em>');
    expect(html).not.toContain('data-marker');
  });

  it('renders code fences and headings without crashing', () => {
    const html = render('## Title\n\n```ts\nconst a = 1;\n```');
    expect(html).toContain('<h2');
    expect(html).toContain('const a = 1;');
  });

  it('never nests figures inside paragraphs', () => {
    const html = render('Some text\n\n![Cap-h](https://h.test/f.webp)');
    expect(html).toContain('<figure');
    expect(html).not.toMatch(/<p[^>]*>(\s|<[^/])*?<figure/);
  });
});

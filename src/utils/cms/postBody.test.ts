import { describe, expect, it } from 'vitest';
import {
  committedImageMarkdown,
  parseBodyImages,
  pendingImageMarkdown,
  rewritePendingRef,
  sanitizeImageAlt,
  toggleInlineMarker,
  validateBodyImages,
  wrapCodeFence,
} from './postBody';

describe('parseBodyImages', () => {
  it('parses committed and pending refs with caption/hash split', () => {
    const refs = parseBodyImages(
      'a\n![Alt text-abc123](https://x.test/f.webp)\n![cap-pending:9](blob:u)\n![](https://x.test/g.webp)'
    );
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({
      caption: 'Alt text',
      hash: 'abc123',
      pending: false,
      pendingId: null,
    });
    expect(refs[1]).toMatchObject({
      caption: 'cap',
      pending: true,
      pendingId: '9',
    });
    expect(refs[2]).toMatchObject({ caption: '', hash: '' });
  });

  it('parses the real legacy shape (data-uri blur placeholder)', () => {
    const refs = parseBodyImages(
      '![Raspberry Pi Homelab-data:image/png;base64,iVBOR](https://h.test/blog/1/x.webp)'
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.caption).toBe('Raspberry Pi Homelab');
    expect(refs[0]?.hash.startsWith('data:image/png')).toBe(true);
  });
});

describe('sanitizeImageAlt', () => {
  it('removes dashes and collapses space, falls back to filename', () => {
    expect(sanitizeImageAlt('my-photo 2024', 'f.webp')).toBe('my photo 2024');
    expect(sanitizeImageAlt('  ', 'my_file-name.PNG')).toBe('my file name');
    expect(sanitizeImageAlt('', '')).toBe('image');
  });
});

describe('pending/rewrite round-trip', () => {
  it('rewrites only the matching pending id', () => {
    const body = `x\n${pendingImageMarkdown('cap', 'a1', 'blob:u1')}\n${pendingImageMarkdown('cap', 'b2', 'blob:u2')}`;
    const next = rewritePendingRef(
      body,
      'a1',
      committedImageMarkdown('cap', 'h', 'https://h.test/f.webp')
    );
    expect(next).toContain('![cap-h](https://h.test/f.webp)');
    expect(next).toContain('pending:b2');
  });
});

describe('validateBodyImages', () => {
  it('flags unbalanced syntax and dangling pending refs', () => {
    const issues = validateBodyImages(
      'ok ![a-b](https://h.test/x.webp)\nbroken ![alt(url)\n![c-pending:zz](blob:u)',
      new Set(['aa'])
    );
    expect(issues.map((i) => i.line)).toEqual([2, 3]);
  });

  it('passes legacy committed lines untouched', () => {
    expect(
      validateBodyImages(
        '![No dash](https://h.test/x.webp)\n![ext](https://cdn.test/x.png)',
        new Set()
      )
    ).toEqual([]);
  });
});

describe('toggleInlineMarker', () => {
  it('wraps and unwraps bold runs', () => {
    const wrapped = toggleInlineMarker('hello world', 6, 11, '****');
    expect(wrapped.text).toBe('hello ****world****');
    const unwrapped = toggleInlineMarker(
      wrapped.text,
      wrapped.caretStart,
      wrapped.caretEnd,
      '****'
    );
    expect(unwrapped.text).toBe('hello world');
  });

  it('wraps violet runs and refuses to nest inside bold', () => {
    expect(toggleInlineMarker('hello world', 6, 11, '*').text).toBe(
      'hello *world*'
    );
    // Selection inside a **** run: refused, text unchanged.
    expect(toggleInlineMarker('****world****', 5, 10, '*').text).toBe(
      '****world****'
    );
  });

  it('inserts an empty pair on a collapsed caret', () => {
    expect(toggleInlineMarker('hi', 2, 2, '*')).toEqual({
      text: 'hi**',
      caretStart: 3,
      caretEnd: 3,
    });
  });
});

describe('wrapCodeFence', () => {
  it('isolates the selection on its own lines with blank gaps', () => {
    const out = wrapCodeFence('before\nline\n after', 7, 11);
    expect(out.text).toBe('before\n\n```\nline\n```\n\n after');
  });
});

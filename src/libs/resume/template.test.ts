import { describe, expect, it } from 'vitest';
import { DEFAULT_RESUME_CSS } from './defaultCss';
import { DEFAULT_EN, DEFAULT_IT } from './defaults';
import {
  escapeHtml,
  renderResumeHtml,
  resumeContinuationTitle,
  sanitizeHref,
  sanitizeRichText,
} from './template';
import { normalizeResumeContacts } from './types';
import { validateResumeCss, validateResumeData } from './validation';

describe('escapeHtml', () => {
  it('encodes element and attribute positions', () => {
    expect(escapeHtml('<a href="x">&')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;'
    );
  });
});

describe('sanitizeHref', () => {
  it('keeps http/https/mailto/tel', () => {
    expect(sanitizeHref('https://okazakee.dev')).toBe('https://okazakee.dev');
    expect(sanitizeHref('mailto:okazakee@proton.me')).toBe(
      'mailto:okazakee@proton.me'
    );
    expect(sanitizeHref('tel:+393883628480')).toBe('tel:+393883628480');
  });

  it('blocks javascript: and empty hrefs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeHref('   ')).toBeNull();
  });
});

describe('sanitizeRichText', () => {
  it('keeps strong/em/span.nowrap and strips scripts and handlers', () => {
    const out = sanitizeRichText(
      'Hello <strong>world</strong><script>alert(1)</script>' +
        '<span class="nowrap">keep</span><span onclick="x()">flat</span>' +
        '<a href="https://x.test">gone</a>'
    );
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('<span class="nowrap">keep</span>');
    expect(out).toContain('<span>flat</span>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<a');
  });
});

describe('renderResumeHtml', () => {
  it('renders the EN seed as a two-page A4 document', () => {
    const html = renderResumeHtml(DEFAULT_EN, DEFAULT_RESUME_CSS, {
      locale: 'en',
      docTitle: 'Resume – Cristian Di Carlo',
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Cristian Di Carlo');
    expect(html).toContain('Professional Summary');
    expect(html).toContain('paid24/7');
    expect(html).toContain('BlurKit');
    expect(html).toContain('Page 1 / 2');
    expect(html).toContain('Page 2 / 2');
    expect(html).toContain('@page');
    expect(html).toContain('Noto+Sans');
    // Two .page roots only (plus CSS mentions).
    expect(html.match(/<div class="page">/g)).toHaveLength(2);
  });

  it('renders the IT seed with Italian copy', () => {
    const html = renderResumeHtml(DEFAULT_IT, DEFAULT_RESUME_CSS, {
      locale: 'it',
      docTitle: 'Curriculum – Cristian Di Carlo',
    });
    expect(html).toContain('<html lang="it">');
    expect(html).toContain('Profilo Professionale');
    expect(html).toContain('Competenze Tecniche');
    expect(html).toContain('Esperienza Professionale');
    expect(html).toContain('Pagina 1 / 2');
  });

  it('derives footer data from name, website and locale', () => {
    const en = renderResumeHtml(DEFAULT_EN, DEFAULT_RESUME_CSS, {
      locale: 'en',
      docTitle: 't',
    });
    expect(en).toContain('Cristian Di Carlo · okazakee.dev');
    expect(en).toContain('Page 1 / 2');
    expect(en).toContain('Page 2 / 2');
    const it = renderResumeHtml(DEFAULT_IT, DEFAULT_RESUME_CSS, {
      locale: 'it',
      docTitle: 't',
    });
    expect(it).toContain('Pagina 1 / 2');
    expect(it).toContain('Pagina 2 / 2');
  });

  it('derives the page-2 header title from the headline', () => {
    expect(
      resumeContinuationTitle(
        'Full-Stack & Mobile Engineer · TypeScript · React Native / Node.js'
      )
    ).toBe('Full-Stack & Mobile Engineer');
    expect(
      resumeContinuationTitle(
        'Ingegnere Full-Stack & Mobile · TypeScript · React Native / Node.js'
      )
    ).toBe('Ingegnere Full-Stack & Mobile');
    expect(resumeContinuationTitle('Solo headline')).toBe('Solo headline');
    const html = renderResumeHtml(DEFAULT_EN, DEFAULT_RESUME_CSS, {
      locale: 'en',
      docTitle: 't',
    });
    expect(html).toContain(
      'continuation-title">Full-Stack &amp; Mobile Engineer<'
    );
  });

  it('honours a CSS override and escapes hostile text', () => {
    const hostile = {
      ...DEFAULT_EN,
      name: '<img src=x onerror=alert(1)>',
      contacts: [],
    };
    const html = renderResumeHtml(hostile, '.page{}', {
      locale: 'en',
      docTitle: 't',
    });
    expect(html).toContain('.page{}');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('validateResumeData', () => {
  it('accepts both seeds', () => {
    expect(validateResumeData(DEFAULT_EN, 'en')).toEqual([]);
    expect(validateResumeData(DEFAULT_IT, 'it')).toEqual([]);
  });

  it('rejects missing sections and oversized fields', () => {
    expect(validateResumeData(null, 'en')).toHaveLength(1);
    const issues = validateResumeData(
      { ...DEFAULT_EN, name: ' ', experience: [], contacts: [] },
      'en'
    );
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('en.name');
    expect(paths).toContain('en.experience');
    expect(paths).toContain('en.contacts');
  });

  it('rejects tampered contact rows and links on text-only rows', () => {
    const swapped = {
      ...DEFAULT_EN,
      contacts: [...DEFAULT_EN.contacts].reverse(),
    };
    expect(
      validateResumeData(swapped, 'en').map((issue) => issue.path)
    ).toContain('en.contacts[0].icon');
    const linkedLocation = {
      ...DEFAULT_EN,
      contacts: DEFAULT_EN.contacts.map((contact) =>
        contact.icon === 'location'
          ? { ...contact, href: 'https://x.test' }
          : contact
      ),
    };
    expect(
      validateResumeData(linkedLocation, 'en').map((issue) => issue.path)
    ).toContain('en.contacts[0].href');
  });

  it('normalizes stored contacts onto the fixed schema', () => {
    const normalized = normalizeResumeContacts(
      [{ icon: 'phone', text: 'changed', href: 'tel:1' }],
      DEFAULT_EN.contacts
    );
    expect(normalized.map((c) => c.icon)).toEqual(
      DEFAULT_EN.contacts.map((c) => c.icon)
    );
    expect(normalized[1]?.text).toBe('changed');
    expect(normalized[0]?.href).toBeUndefined();
  });
});

describe('validateResumeCss', () => {
  it('accepts empty override and rejects markup', () => {
    expect(validateResumeCss('')).toEqual([]);
    expect(validateResumeCss('.page{}')).toEqual([]);
    expect(validateResumeCss('</style><script>')).toHaveLength(1);
  });
});

describe('resume seeds', () => {
  it('mirror the original documents section counts', () => {
    for (const seed of [DEFAULT_EN, DEFAULT_IT]) {
      expect(seed.experience).toHaveLength(4);
      expect(seed.projects).toHaveLength(5);
      expect(seed.education).toHaveLength(3);
      expect(seed.skills).toHaveLength(4);
      expect(seed.contacts.length).toBe(7);
      expect(seed.languages).toHaveLength(2);
    }
  });
});

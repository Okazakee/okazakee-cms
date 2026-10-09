/**
 * Resume HTML renderer (client-safe: pure string building, no node imports).
 *
 * Produces the exact two-page print-perfect document the author used to
 * hand-print PDFs, from structured {@link ResumeData}. The same function
 * feeds the CMS live preview (iframe srcDoc) and the server-side Chromium
 * PDF export, so preview and published PDF cannot drift.
 */
import type {
  ResumeContact,
  ResumeContactIcon,
  ResumeData,
  ResumeLocale,
} from './types';

const RICH_TEXT_TAGS = new Set(['strong', 'em', 'b', 'i', 'span']);

/** Encodes plain text for HTML element/attribute positions. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Keeps admin hrefs to safe schemes only (http/https/mailto/tel).
 * Returns null for anything else (e.g. javascript:).
 */
export function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Minimal rich-text sanitizer for summary/bullet fields. Admin-authored
 * markup keeps <strong>/<em>/<b>/<i>/<span class="nowrap">; everything
 * else (scripts, styles, iframes, event handlers, links) is stripped.
 */
export function sanitizeRichText(html: string): string {
  const withoutDangerous = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed)[^>]*\/?>/gi, '');
  return withoutDangerous.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g,
    (match, tag: string) => {
      const name = tag.toLowerCase();
      if (!RICH_TEXT_TAGS.has(name)) return '';
      if (match.startsWith('</')) return `</${name}>`;
      if (name === 'span') {
        const cls = /class\s*=\s*["']([^"']*)["']/i.exec(match);
        if (cls?.[1].split(/\s+/).includes('nowrap')) {
          return '<span class="nowrap">';
        }
        return '<span>';
      }
      return `<${name}>`;
    }
  );
}

const CONTACT_ICON_PATHS: Record<
  ResumeContactIcon,
  { inner: string; filled: boolean }
> = {
  location: {
    filled: false,
    inner:
      '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"></path><circle cx="12" cy="9" r="2.5"></circle>',
  },
  phone: {
    filled: false,
    inner:
      '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.15 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.06 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 16.92z"></path>',
  },
  email: {
    filled: false,
    inner:
      '<rect height="16" rx="2" width="20" x="2" y="4"></rect><path d="M2 7l10 7 10-7"></path>',
  },
  github: {
    filled: true,
    inner:
      '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"></path>',
  },
  linkedin: {
    filled: true,
    inner:
      '<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"></path>',
  },
  website: {
    filled: false,
    inner:
      '<circle cx="12" cy="12" r="10"></circle><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
  },
  document: {
    filled: false,
    inner:
      '<path d="M6 2h9l5 5v15H6z"></path><path d="M14 2v6h6M9 13h6M9 17h6"></path>',
  },
};

function contactIcon(icon: ResumeContactIcon): string {
  const { inner, filled } = CONTACT_ICON_PATHS[icon];
  const attrs = filled
    ? 'class="ci" fill="currentColor" viewbox="0 0 24 24"'
    : 'class="ci" fill="none" stroke="currentColor" stroke-width="2" viewbox="0 0 24 24"';
  return `<svg ${attrs}>${inner}</svg>`;
}

function renderContact(contact: ResumeContact): string {
  const safeHref = contact.href ? sanitizeHref(contact.href) : null;
  const body = `${contactIcon(contact.icon)}${escapeHtml(contact.text)}`;
  if (!safeHref) return `<span>${body}</span>`;
  const external = /^https?:/i.test(safeHref);
  const target = external ? ' target="_blank"' : '';
  return `<a href="${escapeHtml(safeHref)}"${target}>${body}</a>`;
}

export type RenderResumeOptions = {
  locale: ResumeLocale;
  docTitle: string;
};

/** The document always renders exactly these two fixed pages. */
const TOTAL_PAGES = 2;

/**
 * Page-2 header title derives from the headline: the role phrase before
 * the "·" separator ("Full-Stack & Mobile Engineer · TypeScript …" →
 * "Full-Stack & Mobile Engineer"). Falls back to the full headline.
 */
export function resumeContinuationTitle(headline: string): string {
  const head = headline.split('·')[0]?.trim();
  return head === '' || head === undefined ? headline : head;
}

/**
 * Derived footer data (never user-edited): the left cell mirrors the
 * header name plus the website contact text, and page labels follow the
 * document locale.
 */
export function resumeFooter(
  data: ResumeData,
  locale: ResumeLocale
): { left: string; pages: [string, string] } {
  const website =
    data.contacts.find((c) => c.icon === 'website')?.text.trim() ||
    'okazakee.dev';
  const left = `${data.name} · ${website}`;
  const word = locale === 'it' ? 'Pagina' : 'Page';
  return {
    left,
    pages: [
      `${word} 1 / ${TOTAL_PAGES}`,
      `${word} 2 / ${TOTAL_PAGES}`,
    ],
  };
}

/**
 * Renders the full standalone HTML document. Webfonts include the print
 * fallbacks (Noto Sans / Noto Sans Mono) so server-side Chromium PDFs use
 * the same metrics as a local browser print — no installed-font lottery.
 */
export function renderResumeHtml(
  data: ResumeData,
  css: string,
  options: RenderResumeOptions
): string {
  const { locale, docTitle } = options;
  const footer = resumeFooter(data, locale);
  const contacts = data.contacts.map(renderContact).join('');
  const skills = data.skills
    .map(
      (group) =>
        `<div class="skill-row"><span class="skill-label">${escapeHtml(group.label)}</span><span>${group.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span></div>`
    )
    .join('');
  const experience = data.experience
    .map(
      (entry) =>
        `<div class="entry"><div class="entry-header"><div><div class="entry-title">${escapeHtml(entry.title)}</div><div class="entry-sub">${escapeHtml(entry.sub)}</div></div><div class="entry-meta">${escapeHtml(entry.meta)}</div></div><ul class="bullets">${entry.bullets.map((bullet) => `<li>${sanitizeRichText(bullet)}</li>`).join('')}</ul></div>`
    )
    .join('');
  const projects = data.projects
    .map((project) => {
      const links = project.links
        .map((link) => {
          const safeHref = sanitizeHref(link.href);
          if (!safeHref) return '';
          return `<a class="proj-link" href="${escapeHtml(safeHref)}" target="_blank">${escapeHtml(link.label)}</a>`;
        })
        .join('');
      return `<div class="entry"><div class="proj-header"><span class="proj-name">${escapeHtml(project.name)}</span>${links}</div><div class="proj-stack">${escapeHtml(project.stack)}</div><ul class="bullets" style="margin-top:3px">${project.bullets.map((bullet) => `<li>${sanitizeRichText(bullet)}</li>`).join('')}</ul></div>`;
    })
    .join('');
  const education = data.education
    .map(
      (row) =>
        `<div class="edu-row"><div><div class="edu-degree">${escapeHtml(row.degree)}</div><div class="edu-school">${escapeHtml(row.school)}</div></div><div class="edu-year">${escapeHtml(row.year)}</div></div>`
    )
    .join('');
  const languages = data.languages
    .map(
      (row) =>
        `<div class="lang-row"><span>${escapeHtml(row.name)}</span><span class="lang-level">${escapeHtml(row.level)}</span></div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>${escapeHtml(docTitle)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&amp;family=DM+Sans:wght@300;400;500;600&amp;family=Noto+Sans:wght@400;500;600&amp;family=Noto+Sans+Mono:wght@400;500&amp;display=swap" rel="stylesheet"/>
<style>
${css}
</style>
</head>
<body>
<div class="page">
<header>
<div class="header-top"><div class="header-copy">
<div class="name">${escapeHtml(data.name)}</div>
<div class="title">${escapeHtml(data.title)}</div>
<div class="contact">
${contacts}
</div>
</div></div>
</header>
<main>
<section><div class="section-title">${escapeHtml(data.summaryTitle)}</div><p class="summary">${sanitizeRichText(data.summaryHtml)}</p></section>
<section><div class="section-title">${escapeHtml(data.skillsTitle)}</div><div class="skills-grid">${skills}</div></section>
<section><div class="section-title">${escapeHtml(data.experienceTitle)}</div>${experience}</section>
</main>
<div class="page-footer"><span>${escapeHtml(footer.left)}</span><span>${escapeHtml(footer.pages[0])}</span></div>
</div>
<div class="page">
<div class="continuation-header"><span class="continuation-name">${escapeHtml(data.name)}</span><span class="continuation-title">${escapeHtml(resumeContinuationTitle(data.title))}</span></div>
<main>
<section><div class="section-title">${escapeHtml(data.projectsTitle)}</div>${projects}</section>
<div class="two-col">
<section><div class="section-title">${escapeHtml(data.educationTitle)}</div>${education}</section>
<section><div class="section-title">${escapeHtml(data.languagesTitle)}</div>${languages}</section>
</div>
</main>
<div class="page-footer"><span>${escapeHtml(footer.left)}</span><span>${escapeHtml(footer.pages[1])}</span></div>
</div>
</body>
</html>
`;
}

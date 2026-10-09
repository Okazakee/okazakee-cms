/**
 * Block model for the visual post-body editor (client-safe, unit-tested).
 *
 * Bodies are markdown documents with house conventions (see MarkdownRenderer
 * on the public site): `****` white-bold, `*` violet, `![alt-hash](url)`
 * figures, fenced code, headings, lists, quotes, tables, `---` rules.
 * `markdownToEditorHtml` renders storage text as editable blocks with all
 * syntax hidden; `editorDomToMarkdown` serializes the DOM back to the exact
 * storage text. Round-trip fidelity is covered by tests, including the
 * shapes found in real bodies (setext headings, numbered lists, langs).
 */
import { parseBodyImages } from './postBody';

const FENCE_PATTERN = /^```(\w*)\s*$/;
const HEADING_PATTERN = /^(#{1,6})\s(.*)$/;
const IMAGE_LINE_PATTERN = /^\s*(!\[[^\]]*\]\([^)\s]+\))\s*$/;
const HR_PATTERN = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const SETEXT_PATTERN = /^(=+|-+)\s*$/;
const LIST_PATTERN = /^(\s*)([-*+]|\d+[.)])\s(.*)$/;
const QUOTE_PATTERN = /^>\s?(.*)$/;
const TABLE_ROW_PATTERN = /^\|.*\|\s*$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline runs: strong, em, code, links and inline images become tags. */
export function renderInlineRuns(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i);
    // Image (must precede link: `![` contains `[`). Session-local sources
    // can never resolve: mark them so the editor shows a removable stub.
    if (rest.startsWith('![')) {
      const image = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
      if (image) {
        const src = image[2] ?? '';
        const broken = /^(blob|data):/i.test(src);
        out +=
          `<img data-inline="1"${broken ? ' data-broken="1"' : ''} src="${escapeHtml(src)}" alt="${escapeHtml(image[1] ?? '')}"` +
          (broken
            ? ' title="Dead image: remove it and re-add with the Image button">'
            : '>');
        i += image[0].length;
        continue;
      }
    }
    // Link.
    if (text[i] === '[') {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        const href = escapeHtml(link[2] ?? '');
        out += `<a data-href="${href}" title="${href}">${renderInlineRuns(link[1] ?? '')}</a>`;
        i += link[0].length;
        continue;
      }
    }
    // Bold quad, then double, then violet single.
    if (rest.startsWith('****')) {
      const bold = /\*\*\*\*([^*]+?)\*\*\*\*/.exec(rest);
      if (bold) {
        out += `<strong>${renderInlineRuns(bold[1] ?? '')}</strong>`;
        i += bold[0].length;
        continue;
      }
    } else if (rest.startsWith('**')) {
      const bold = /\*\*([^*]+?)\*\*/.exec(rest);
      if (bold) {
        out += `<strong>${renderInlineRuns(bold[1] ?? '')}</strong>`;
        i += bold[0].length;
        continue;
      }
    } else if (text[i] === '*') {
      const em = /^\*(?!\*)([^*\n]+?)\*(?!\*)/.exec(rest);
      if (em) {
        out += `<em>${renderInlineRuns(em[1] ?? '')}</em>`;
        i += em[0].length;
        continue;
      }
    }
    // Inline code.
    if (text[i] === '`') {
      const code = /^`([^`\n]+)`/.exec(rest);
      if (code) {
        out += `<code>${escapeHtml(code[1] ?? '')}</code>`;
        i += code[0].length;
        continue;
      }
    }
    // Backslash escape: keep the escaped char literal.
    if (text[i] === '\\' && i + 1 < n && '\\`*_[]!#'.includes(text[i + 1] ?? '')) {
      out += escapeHtml(text[i + 1] ?? '');
      i += 2;
      continue;
    }
    out += escapeHtml(text[i] ?? '');
    i += 1;
  }
  return out;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function renderFigure(alt: string, src: string, captionHint: string): string {
  const dash = alt.indexOf('-');
  const caption = dash < 0 ? alt : alt.slice(0, dash);
  const hash = dash < 0 ? '' : alt.slice(dash + 1);
  const pending =
    src.startsWith('blob:') && hash.startsWith('pending:');
  return (
    `<figure data-block="image" contenteditable="false"${pending ? ` data-pending="1" data-local-id="${escapeHtml(hash.slice('pending:'.length))}" data-hash=""` : ` data-hash="${escapeHtml(hash)}"`}>` +
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(caption)}" draggable="false">` +
    `<figcaption contenteditable="true" data-caption-hint="${escapeHtml(captionHint)}">${escapeHtml(caption)}</figcaption>` +
    `<button type="button" data-remove-image="1" aria-label="Remove image">×</button>` +
    `</figure>`
  );
}

/** Renders a full storage document as editor block HTML. */
export function markdownToEditorHtml(
  markdown: string,
  options?: { captionHint?: string }
): string {
  const captionHint = options?.captionHint ?? '';
  const lines = markdown.split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: Array<{ marker: string; text: string }> | null = null;
  let quoteLines: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(
        `<p data-block="paragraph">${renderInlineRuns(paragraph.join('\n'))}</p>`
      );
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems && listItems.length > 0) {
      const ordered = /^\d/.test(listItems[0]?.marker ?? '');
      const tag = ordered ? 'ol' : 'ul';
      const items = listItems
        .map(
          (item) =>
            `<li data-marker="${escapeHtml(item.marker)}">${renderInlineRuns(item.text)}</li>`
        )
        .join('');
      blocks.push(
        `<${tag} data-block="list" data-style="${escapeHtml(listItems[0]?.marker ?? '-')}">${items}</${tag}>`
      );
      listItems = null;
    }
  };
  const flushQuote = () => {
    if (quoteLines && quoteLines.length > 0) {
      blocks.push(
        `<blockquote data-block="quote">${renderInlineRuns(quoteLines.join('\n'))}</blockquote>`
      );
      quoteLines = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Fenced code (consume through the closer).
    const fence = FENCE_PATTERN.exec(trimmed);
    if (fence) {
      flushAll();
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      const badge =
        lang !== '' ? `<span data-badge="1" contenteditable="false">${escapeHtml(lang)}</span>` : '';
      blocks.push(
        `<pre data-block="code" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(codeLines.join('\n'))}</code>${badge}</pre>`
      );
      i += 1; // skip the closer (or EOF)
      continue;
    }

    if (trimmed === '') {
      flushAll();
      i += 1;
      continue;
    }

    // Setext underline directly under a paragraph becomes a heading.
    const setext = SETEXT_PATTERN.exec(trimmed);
    if (setext && paragraph.length > 0) {
      const level = setext[1]?.startsWith('=') ? 1 : 2;
      const text = paragraph.join('\n');
      paragraph = [];
      blocks.push(
        `<h${level} data-block="heading" data-level="${level}">${renderInlineRuns(text)}</h${level}>`
      );
      i += 1;
      continue;
    }

    const heading = HEADING_PATTERN.exec(trimmed);
    if (heading) {
      flushAll();
      const level = Math.min(6, (heading[1] ?? '#').length);
      blocks.push(
        `<h${level} data-block="heading" data-level="${level}">${renderInlineRuns(heading[2] ?? '')}</h${level}>`
      );
      i += 1;
      continue;
    }

    const imageLine = IMAGE_LINE_PATTERN.exec(line);
    if (imageLine) {
      flushAll();
      const refs = parseBodyImages(imageLine[1] ?? '');
      const ref = refs[0];
      blocks.push(
        ref
          ? renderFigure(ref.alt, ref.url, captionHint)
          : `<p data-block="paragraph">${escapeHtml(line)}</p>`
      );
      i += 1;
      continue;
    }

    if (TABLE_ROW_PATTERN.test(trimmed)) {
      flushAll();
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW_PATTERN.test((lines[i] ?? '').trim())) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      const body = rows.filter(
        (_, index) =>
          index === 0 || !rows[index]?.every((cell) => /^-+$/.test(cell))
      );
      const cells = (row: string[], header: boolean) =>
        row
          .map((cell) =>
            header
              ? `<th>${renderInlineRuns(cell)}</th>`
              : `<td>${renderInlineRuns(cell)}</td>`
          )
          .join('');
      blocks.push(
        `<table data-block="table"><tbody>${body.map((row, index) => `<tr>${cells(row, index === 0)}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    if (HR_PATTERN.test(trimmed)) {
      flushAll();
      blocks.push('<hr data-block="hr">');
      i += 1;
      continue;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      if (!quoteLines) quoteLines = [];
      quoteLines.push(quote[1] ?? '');
      i += 1;
      continue;
    }

    const list = LIST_PATTERN.exec(line);
    if (list) {
      flushParagraph();
      flushQuote();
      if (!listItems) listItems = [];
      listItems.push({ marker: list[2] ?? '-', text: list[3] ?? '' });
      i += 1;
      continue;
    }

    // Any other line continues the paragraph (soft breaks preserved).
    flushList();
    flushQuote();
    paragraph.push(line);
    i += 1;
  }
  flushAll();

  if (blocks.length === 0) {
    return '<p data-block="paragraph"><br></p>';
  }
  return blocks.join('');
}

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'FIGURE',
  'HR',
  'SECTION',
  'ARTICLE',
  'LI',
]);

function isBlockElement(node: Node): boolean {
  return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName);
}

/** Inline DOM back to markdown runs (code spans stay literal inside pre). */
function inlineToMarkdown(node: Node, inPre: boolean): string {
  if (node.nodeType === 3) return (node as Text).data;
  if (node.nodeName === 'BR') return '\n';
  if (node.nodeType !== 1) return '';
  const element = node as HTMLElement;
  if (element.hasAttribute('data-badge') || element.hasAttribute('data-remove-image')) {
    return '';
  }
  if (inPre) {
    // Code content is raw: tags never carry meaning here.
    if (isBlockElement(element)) return `\n${childrenMarkdown(element, true)}`;
    return childrenMarkdown(element, true);
  }
  const tag = element.tagName;
  // Structural elements reached from an inline position (legacy nesting)
  // serialize as their own blocks instead of flattening into text.
  if (tag === 'FIGURE') return `\n${figureToMarkdown(element)}\n`;
  if (tag === 'PRE') return `\n${preToMarkdown(element)}\n`;
  if (tag === 'TABLE') return `\n${tableToMarkdown(element)}\n`;
  if (tag === 'UL' || tag === 'OL') return `\n${listToMarkdown(element)}\n`;
  if (tag === 'BLOCKQUOTE') {
    const text = childrenMarkdown(element, false).trim();
    return `\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n`;
  }
  if (tag === 'HR') return '\n---\n';
  if (tag === 'STRONG' || tag === 'B') {
    return `****${childrenMarkdown(element, false)}****`;
  }
  if (tag === 'EM' || tag === 'I') {
    return `*${childrenMarkdown(element, false)}*`;
  }
  if (tag === 'CODE') {
    return `\`${childrenMarkdown(element, false)}\``;
  }
  if (tag === 'A') {
    const href =
      element.getAttribute('data-href') ?? element.getAttribute('href') ?? '';
    return `[${childrenMarkdown(element, false)}](${href})`;
  }
  if (tag === 'IMG') {
    const img = element as HTMLImageElement;
    const alt = img.getAttribute('alt') ?? '';
    return `![${alt}](${img.getAttribute('src') ?? ''})`;
  }
  if (isBlockElement(element)) {
    return `\n${childrenMarkdown(element, false)}`;
  }
  return childrenMarkdown(element, false);
}

function childrenMarkdown(root: Element, inPre: boolean): string {
  let out = '';
  root.childNodes.forEach((child) => {
    out += inlineToMarkdown(child, inPre);
  });
  return out;
}

function figureToMarkdown(figure: HTMLElement): string {
  const img = figure.querySelector('img');
  const caption = figure.querySelector('figcaption');
  const src = img?.getAttribute('src') ?? '';
  if (!src) return '';
  const captionText = caption
    ? childrenMarkdown(caption, false).replace(/\n+/g, ' ').trim()
    : (img?.getAttribute('alt') ?? '');
  if (figure.hasAttribute('data-pending')) {
    const localId = figure.getAttribute('data-local-id') ?? '';
    return `![${captionText}-pending:${localId}](${src})`;
  }
  const hash = figure.getAttribute('data-hash') ?? '';
  return `![${captionText}-${hash}](${src})`;
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  const lines = rows.map((row) => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    // Cells are single-line by construction: collapse structural breaks.
    const text = (cell: Element): string =>
      childrenMarkdown(cell, false).replace(/\s+/g, ' ').trim();
    return `| ${cells.map((cell) => text(cell).replace(/\|/g, '\\|')).join(' | ')} |`;
  });
  if (lines.length > 1) {
    const columns = rows[0]?.querySelectorAll('th, td').length ?? 0;
    const separator = `| ${Array.from({ length: Math.max(columns, 1) }, () => '---').join(' | ')} |`;
    lines.splice(1, 0, separator);
  }
  return lines.join('\n');
}

function listToMarkdown(list: HTMLElement, depth = 0): string {
  const ordered = list.tagName === 'OL';
  const fallback = ordered ? '1.' : '-';
  const lines: string[] = [];
  let counter = 0;
  list.childNodes.forEach((child) => {
    if (child.nodeType !== 1 || (child as Element).tagName !== 'LI') return;
    counter += 1;
    const item = child as HTMLElement;
    const marker = item.getAttribute('data-marker') || (ordered ? `${counter}.` : fallback);
    const parts: string[] = [];
    item.childNodes.forEach((grand) => {
      if (grand.nodeType === 1 && ((grand as Element).tagName === 'UL' || (grand as Element).tagName === 'OL')) {
        parts.push(`\n${listToMarkdown(grand as HTMLElement, depth + 1)}`);
      } else {
        parts.push(inlineToMarkdown(grand, false));
      }
    });
    // Continuation lines stay inside the item via indentation so the
    // list never splits open on the site.
    const text = parts
      .join('')
      .split('\n')
      .map((line, index) =>
        index === 0 || line.startsWith(' ') ? line : `  ${line}`
      )
      .join('\n')
      .replace(/\n+$/, '');
    lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
  });
  return lines.join('\n');
}

function preToMarkdown(pre: HTMLElement): string {
  const lang = pre.getAttribute('data-lang') ?? '';
  const code = pre.querySelector('code');
  // Leading/trailing blank lines inside fences are meaningless: trim them
  // so the first edit normalizes once and every later round-trip is exact.
  const text = childrenMarkdown(code ?? pre, true)
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

/** Serializes one root-level block element to markdown ('' when empty). */
function blockToMarkdown(element: HTMLElement): string {
  const block = element.getAttribute('data-block');
  const tag = element.tagName;
  switch (block ?? tag) {
    case 'heading':
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level =
        Number(element.getAttribute('data-level') ?? 0) ||
        Number(tag.slice(1)) ||
        2;
      const text = childrenMarkdown(element, false).trim();
      return text ? `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${text}` : '';
    }
    case 'list':
    case 'UL':
    case 'OL':
      return listToMarkdown(element);
    case 'code':
    case 'PRE':
      return preToMarkdown(element);
    case 'image':
    case 'FIGURE':
      return figureToMarkdown(element);
    case 'quote':
    case 'BLOCKQUOTE': {
      const text = childrenMarkdown(element, false).trim();
      return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    }
    case 'table':
    case 'TABLE':
      return tableToMarkdown(element);
    case 'hr':
    case 'HR':
      return '---';
    case 'paragraph':
    case 'P':
    case 'DIV':
    case 'LI': {
      // A structural block nested inside running text (e.g. a figure
      // dropped mid-paragraph before insertion was block-aware) splits
      // back out into its own blocks, so captions and hashes are never
      // flattened into text.
      const parts: string[] = [];
      let run = '';
      const flushRun = () => {
        if (run.trim() !== '') parts.push(run);
        run = '';
      };
      element.childNodes.forEach((child) => {
        if (
          child.nodeType === 1 &&
          NESTED_BLOCK_OUT.has((child as Element).tagName)
        ) {
          flushRun();
          parts.push(blockToMarkdown(child as HTMLElement));
        } else {
          run += inlineToMarkdown(child, false);
        }
      });
      flushRun();
      return parts.join('\n\n');
    }
    default:
      return childrenMarkdown(element, false).trim();
  }
}

const NESTED_BLOCK_OUT = new Set([
  'FIGURE',
  'PRE',
  'TABLE',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'HR',
]);

/**
 * Serializes the editor DOM back to storage markdown. Blocks join with
 * blank lines; empty blocks vanish (a trailing Enter leaves no residue).
 */
export function editorDomToMarkdown(root: Element): string {
  const blocks: string[] = [];
  root.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = (child as Text).data.trim();
      if (text) blocks.push(childrenMarkdown(child.parentElement ?? root, false).trim() && text);
      return;
    }
    if (child.nodeName === 'BR') return;
    if (child.nodeType !== 1) return;
    const text = blockToMarkdown(child as HTMLElement);
    if (text) blocks.push(text);
  });
  return blocks.join('\n\n');
}

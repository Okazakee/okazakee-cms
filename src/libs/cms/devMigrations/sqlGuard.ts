/**
 * Read-only SQL comparison helpers for dev-only migration checks
 * (dev_staging scope only).
 *
 * Lexer-aware: single-quoted strings ('' doubled), double-quoted
 * identifiers ("" doubled), $tag$...$tag$ bodies. normDef/normType compare
 * catalog values without firing inside string or dollar payloads.
 * No mutation guard lives here; check-only tooling only.
 */
export const DEV_SCOPE = 'dev_staging';

// Private-use marker for masked literal placeholders (never valid SQL).
const LIT_MARK = String.fromCharCode(0xe000);

function dollarOpenAt(text: string, i: number): string | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
  return m ? m[0] : null;
}

/** Replace string/dollar literals and quoted ids with placeholders. */
export function maskLiterals(stmt: string): {
  masked: string;
  literals: string[];
} {
  const literals: string[] = [];
  let out = '';
  let i = 0;
  const n = stmt.length;
  while (i < n) {
    const c = stmt[i];
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (stmt[j] === "'" && stmt[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (stmt[j] === "'") break;
        j += 1;
      }
      if (j >= n) throw new Error('unterminated string literal');
      literals.push(stmt.slice(i, j + 1));
      out += LIT_MARK + String(literals.length - 1) + LIT_MARK;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (stmt[j] === '"' && stmt[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (stmt[j] === '"') break;
        j += 1;
      }
      if (j >= n) throw new Error('unterminated quoted identifier');
      literals.push(stmt.slice(i, j + 1));
      out += LIT_MARK + String(literals.length - 1) + LIT_MARK;
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const tag = dollarOpenAt(stmt, i);
      if (tag) {
        const end = stmt.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error('unterminated dollar body');
        literals.push(stmt.slice(i, end + tag.length));
        out += LIT_MARK + String(literals.length - 1) + LIT_MARK;
        i = end + tag.length;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return { masked: out, literals };
}

/** Lexer-aware definition equality: schema/whitespace/type alias outside. */
export function normDef(s: string): string {
  let masked: string;
  let literals: string[];
  try {
    const r = maskLiterals(String(s ?? ''));
    masked = r.masked;
    literals = r.literals;
  } catch {
    return `UNPARSEABLE:${String(s ?? '')}`;
  }
  let out = masked
    .replace(/dev_staging\.|public\.|ref\./g, '<S>.')
    .replace(/\s+/g, ' ')
    .trim();
  const aliases: Record<string, string> = {
    int4: 'integer',
    int8: 'bigint',
    bool: 'boolean',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'character varying': 'varchar',
  };
  for (const [k, v] of Object.entries(aliases)) {
    out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  }
  literals.forEach((lit, idx) => {
    out = out.split(LIT_MARK + String(idx) + LIT_MARK).join(lit);
  });
  return out;
}

/** Case-preserving type equality (literals/CHECK vocabularies untouched). */
export function normType(s: string): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const aliases: Record<string, string> = {
    int4: 'integer',
    int8: 'bigint',
    bool: 'boolean',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'character varying': 'varchar',
  };
  return aliases[t] ?? t;
}

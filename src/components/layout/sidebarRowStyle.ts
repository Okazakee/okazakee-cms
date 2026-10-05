/**
 * One row shape per sidebar surface, shared by the section navigation and the
 * bottom cluster — theme, language, account, home and logout.
 *
 * These rows drifted apart because each was styled at its own call site: the
 * desktop toggles carried a filled card background the navigation rows did
 * not have, the two halves mixed `h-5`, `h-4` and `h-[18px]` icons and two
 * type sizes, and the mobile footer pasted the desktop pill shape into a list
 * of heading rows. Keeping the shapes here means only the semantic state
 * differs between the navigation and the controls below it.
 *
 * `SIDEBAR_ROW` deliberately carries geometry and nothing else. Tailwind
 * resolves conflicting utilities by stylesheet order, not by the order they
 * appear in a class attribute, so every colour belongs to exactly one variant
 * and no composed pair can disagree. The border is always declared, never
 * absent: an active row raises its colour without shifting its label.
 */

/** Desktop row: navigation sections and the bottom cluster alike. */
export const SIDEBAR_ROW =
  'flex min-h-11 w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors duration-200';

export const SIDEBAR_ROW_NEUTRAL =
  'border-transparent text-text-muted hover:bg-surface-raised hover:text-text-white';

export const SIDEBAR_ROW_ACTIVE =
  'border-accent-violet/30 bg-accent-violet/10 text-accent-violet hover:bg-accent-violet/20';

export const SIDEBAR_ROW_DESTRUCTIVE =
  'border-transparent text-text-muted hover:bg-red-500/10 hover:text-red-400';

export const SIDEBAR_ROW_ICON = 'h-5 w-5 shrink-0';

export const SIDEBAR_ROW_LABEL = 'flex-1 truncate text-sm font-medium';

/**
 * Mobile row: the public drawer's canon (docs/DESIGN.md §4) — heading-size
 * labels, hairline dividers, active row in accent violet. Section rows carry a
 * mono `01`–`N` index over one continuous sequence; the footer controls use the
 * same row shape but sit outside that sequence and take no index, so their
 * labels align with the drawer's own left edge.
 */
export const SIDEBAR_MOBILE_ROW =
  'flex w-full items-baseline gap-3.5 border-b border-border-subtle/50 px-1 py-3.5 text-left transition-[opacity,translate,background-color] duration-200 ease-out';

export const SIDEBAR_MOBILE_ROW_NEUTRAL =
  'text-text-white hover:bg-surface-raised active:bg-surface-raised';

export const SIDEBAR_MOBILE_ROW_ACTIVE =
  'font-semibold text-accent-violet-light hover:bg-accent-violet/5';

export const SIDEBAR_MOBILE_ROW_DESTRUCTIVE =
  'text-red-400 hover:bg-red-500/10 active:bg-red-500/15';

export const SIDEBAR_MOBILE_INDEX =
  'min-w-6 font-mono text-[11px] tracking-[0.2em] text-text-dim';

export const SIDEBAR_MOBILE_LABEL = 'font-heading flex-1 text-3xl tracking-tight';
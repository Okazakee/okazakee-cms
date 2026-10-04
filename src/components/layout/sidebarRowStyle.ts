/**
 * One row shape for the sidebar's bottom cluster — theme, language, account,
 * home and logout — shared by the desktop sidebar and the mobile menu.
 *
 * These five drifted apart because each was styled at its own call site: the
 * toggles lost the border the navigation rows had, the navigation rows mixed
 * `h-5` and `h-4` icons, and the mobile footer grew its own heights and tints.
 * Keeping the shape here means only the semantic state differs between them.
 *
 * `SIDEBAR_ROW` deliberately carries geometry and nothing else. Tailwind
 * resolves conflicting utilities by stylesheet order, not by the order they
 * appear in a class attribute, so every colour belongs to exactly one variant
 * and no composed pair can disagree. The border is always declared, never
 * absent: an active row raises its colour without shifting its label.
 */
export const SIDEBAR_ROW =
  'flex min-h-11 w-full items-center gap-3 rounded-lg border p-3 transition-colors duration-200';

export const SIDEBAR_ROW_NEUTRAL =
  'border-transparent bg-surface-card text-text-main hover:bg-surface-raised';

export const SIDEBAR_ROW_ACTIVE =
  'border-accent-violet/30 bg-accent-violet/10 text-accent-violet hover:bg-accent-violet/20';

export const SIDEBAR_ROW_DESTRUCTIVE =
  'border-transparent bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300';

export const SIDEBAR_ROW_ICON = 'h-[18px] w-[18px] shrink-0';

export const SIDEBAR_ROW_LABEL = 'truncate text-sm font-medium';

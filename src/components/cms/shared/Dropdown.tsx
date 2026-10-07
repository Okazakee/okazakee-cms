'use client';

import { Check, ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type DropdownOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type DropdownProps = {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Trigger id, so an external `<label htmlFor>` names the control. */
  id?: string;
  /** Accessible name when no external label points at `id`. */
  label?: string;
  /** Shown when no option matches `value` (an empty "none" entry). */
  placeholder?: string;
  disabled?: boolean;
  /** Root wrapper classes. Replaces the default `relative inline-block w-full`. */
  className?: string;
  /** Replaces the default trigger chrome (the editor field canon). */
  triggerClassName?: string;
  /** Appended to the portalled menu chrome. */
  menuClassName?: string;
};

/** Editor field canon (docs/DESIGN.md §5.8): the trigger matches its siblings. */
const DEFAULT_TRIGGER_CLASS =
  'w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-sm text-text-main focus:border-accent-violet focus:outline-none';

/** Floating panel: the card surface plus the shadow that lifts it. */
const MENU_CANON =
  'overflow-y-auto overscroll-contain rounded-xl border border-border-subtle bg-surface-card shadow-xl py-1 max-h-64';

const OPTION_CANON = 'flex items-center justify-between gap-3 px-3 py-2';

const TRIGGER_LAYOUT =
  'inline-flex items-center justify-between gap-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const TYPEAHEAD_RESET_MS = 500;
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;
const MENU_MAX_WIDTH = 352;
const MENU_MIN_HEIGHT = 96;
const Z_INDEX = 60;

type Placement = {
  top: number;
  left?: number;
  right?: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
};

type OpenEdge = 'selected' | 'first' | 'last';

export function Dropdown({
  value,
  options,
  onChange,
  id,
  label,
  placeholder,
  disabled = false,
  className,
  triggerClassName,
  menuClassName,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef('');
  const typeaheadTimer = useRef<number | undefined>(undefined);

  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listId = `${baseId}-listbox`;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const enabled = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);

  // Anchored to the trigger and re-measured while the page scrolls, so the
  // menu stays with its control inside a scrolling pane.
  const position = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const maxWidth = Math.min(
      MENU_MAX_WIDTH,
      window.innerWidth - 2 * VIEWPORT_MARGIN
    );
    const minWidth = Math.min(rect.width, maxWidth);
    const below =
      window.innerHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
    const above = rect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
    const flip = menuHeight > below && above > below;
    const alignRight =
      rect.left + minWidth > window.innerWidth - VIEWPORT_MARGIN;

    setPlacement({
      top: flip
        ? Math.max(VIEWPORT_MARGIN, rect.top - TRIGGER_GAP - menuHeight)
        : rect.bottom + TRIGGER_GAP,
      left: alignRight ? undefined : Math.max(VIEWPORT_MARGIN, rect.left),
      right: alignRight
        ? Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right)
        : undefined,
      minWidth,
      maxWidth,
      maxHeight: Math.max(MENU_MIN_HEIGHT, flip ? above : below),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    position();
    // The first pass runs before the menu has a height, so settle once it does.
    const frame = window.requestAnimationFrame(position);
    return () => window.cancelAnimationFrame(frame);
  }, [open, position]);

  useEffect(() => {
    if (!open) return;

    const onScroll = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        setPlacement(null);
        return;
      }
      position();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
      setPlacement(null);
    };

    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('pointerdown', onPointerDown, true);

    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, position]);

  useEffect(() => () => window.clearTimeout(typeaheadTimer.current), []);

  const openAt = (edge: OpenEdge) => {
    const selectedUsable =
      selectedIndex >= 0 && options[selectedIndex]?.disabled !== true;
    const fallback = selectedUsable ? selectedIndex : (enabled[0] ?? 0);
    setActive(
      edge === 'first'
        ? (enabled[0] ?? fallback)
        : edge === 'last'
          ? (enabled[enabled.length - 1] ?? fallback)
          : fallback
    );
    typeahead.current = '';
    position();
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    setPlacement(null);
    if (refocus) triggerRef.current?.focus();
  };

  const move = (step: number) => {
    if (enabled.length === 0) return;
    const current = enabled.indexOf(active);
    const next = Math.min(
      enabled.length - 1,
      Math.max(0, (current === -1 ? 0 : current) + step)
    );
    setActive(enabled[next]);
  };

  const select = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (open) move(event.key === 'ArrowDown' ? 1 : -1);
        else openAt(event.key === 'ArrowUp' ? 'last' : 'first');
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) select(active);
        else openAt('selected');
        return;
      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActive(enabled[0] ?? 0);
        return;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActive(enabled[enabled.length - 1] ?? 0);
        return;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        close(true);
        return;
      case 'Tab':
        if (open) close(false);
        return;
      default:
        break;
    }

    const typed =
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey;
    if (!open || !typed) return;

    // Letter typeahead, reset after a short pause.
    typeahead.current += event.key.toLowerCase();
    window.clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = window.setTimeout(() => {
      typeahead.current = '';
    }, TYPEAHEAD_RESET_MS);
    const match = options.findIndex(
      (option) =>
        !option.disabled &&
        option.label.toLowerCase().startsWith(typeahead.current)
    );
    if (match >= 0) setActive(match);
  };

  const triggerClass = `${TRIGGER_LAYOUT} ${triggerClassName ?? DEFAULT_TRIGGER_CLASS}`;
  const menuClass = `${MENU_CANON} ${menuClassName ?? 'text-sm'}`.trim();

  return (
    <div className={className ?? 'relative inline-block w-full'} ref={rootRef}>
      <button
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className={triggerClass}
        disabled={disabled}
        id={baseId}
        onClick={() => {
          if (disabled) return;
          if (open) close(true);
          else openAt('selected');
        }}
        onKeyDown={onKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="truncate">{selected?.label ?? placeholder ?? ''}</span>
        <ChevronDown aria-hidden className="h-4 w-4 shrink-0 opacity-70" />
      </button>

      {open &&
        placement &&
        createPortal(
          <div
            aria-label={label}
            aria-labelledby={id && !label ? id : undefined}
            className={menuClass}
            id={listId}
            ref={menuRef}
            role="listbox"
            style={{
              left: placement.left,
              maxHeight: placement.maxHeight,
              maxWidth: placement.maxWidth,
              minWidth: placement.minWidth,
              position: 'fixed',
              right: placement.right,
              top: placement.top,
              zIndex: Z_INDEX,
            }}
          >
            {options.map((option, index) => {
              const highlighted = index === active && !option.disabled;
              const isSelected = option.value === value;
              const rowClass = [
                OPTION_CANON,
                option.disabled
                  ? 'cursor-not-allowed text-text-dim'
                  : `cursor-pointer ${highlighted ? 'bg-accent-violet/10' : 'text-text-main'}`,
                isSelected ? 'text-accent-violet-light font-semibold' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  aria-disabled={option.disabled || undefined}
                  aria-selected={isSelected}
                  className={rowClass}
                  id={`${listId}-${index}`}
                  key={option.value}
                  onMouseEnter={() => {
                    if (!option.disabled) setActive(index);
                  }}
                  // Selection happens on pointerdown so the trigger keeps focus
                  // and no blur/click race can hand the click underneath.
                  onPointerDown={(event) => {
                    event.preventDefault();
                    select(index);
                  }}
                  role="option"
                  tabIndex={-1}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  )}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

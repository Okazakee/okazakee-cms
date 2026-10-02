'use client';

import { type RefObject, useEffect, useRef } from 'react';

const focusableSelector =
  'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Modal-only focus ownership; inactive drawers never intercept keyboard input. */
export function useDialogFocus<T extends HTMLElement>(
  active: boolean,
  ref: RefObject<T | null>,
  onClose: () => void
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active || !ref.current) return;
    const panel = ref.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const targets = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) =>
          el.getClientRects().length > 0 && !el.closest('[hidden], [inert]')
      );
    (targets()[0] || panel).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = targets();
      const first = items[0] || panel;
      const last = items[items.length - 1] || panel;
      if (
        !panel.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, ref]);
}

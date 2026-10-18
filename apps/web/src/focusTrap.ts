/** Keeps Tab inside a modal dialog. */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab (or Shift+Tab) should move focus among `count` elements from `current` (-1: focus is
 * outside them): wraps at the ends and pulls focus back in; null leaves the move to the browser.
 */
export function nextFocusIndex(current: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}

/** Handles a Tab keydown inside `container` so focus never leaves it. */
export function trapTab(container: HTMLElement | null, event: KeyboardEvent | ReactKeyboardEvent): void {
  if (!container || event.key !== 'Tab') return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

/** Keeps Tab inside a modal dialog. */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE = 'a[href], summary, button, input, select, textarea, [tabindex]';

/** The part of an element {@link isTabbable} reads (an HTMLElement in the browser). */
export interface FocusCandidate {
  getClientRects(): { length: number };
  closest(selector: string): Element | null;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
}

/**
 * Whether Tab can land on the element: rendered (not display:none, not a hidden file input), not
 * in an `[inert]` subtree, not `visibility: hidden`, not disabled (a disabled fieldset included),
 * and without a negative tabindex.
 */
export function isTabbable(el: FocusCandidate): boolean {
  if (el.getClientRects().length === 0) return false;
  if (el.closest('[inert]')) return false;
  if (el.matches(':disabled')) return false;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  // Browsers without checkVisibility: the computed style still tells.
  return (
    typeof getComputedStyle !== 'function' ||
    getComputedStyle(el as unknown as Element).visibility !== 'hidden'
  );
}

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
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isTabbable);
  const next = nextFocusIndex(
    items.indexOf(document.activeElement as HTMLElement),
    items.length,
    event.shiftKey,
  );
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

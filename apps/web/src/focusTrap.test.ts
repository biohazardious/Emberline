import { describe, expect, it } from 'vitest';
import { type FocusCandidate, isTabbable, nextFocusIndex } from './focusTrap';

describe('nextFocusIndex', () => {
  it('wraps Tab from the last element to the first and Shift+Tab from the first to the last', () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });
  it('leaves Tab inside the dialog to the browser', () => {
    expect(nextFocusIndex(0, 3, false)).toBeNull();
    expect(nextFocusIndex(2, 3, true)).toBeNull();
  });
  it('pulls focus back in from outside the dialog', () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });
  it('does nothing without focusable elements', () => {
    expect(nextFocusIndex(-1, 0, false)).toBeNull();
  });
});

/** A stand-in element: visible, enabled, not inert, no tabindex unless set. */
function el(o: { rects?: number; inert?: boolean; disabled?: boolean; tabindex?: string; visible?: boolean; noCheckVisibility?: boolean } = {}): FocusCandidate {
  return {
    getClientRects: () => ({ length: o.rects ?? 1 }),
    closest: (selector: string) => (selector === '[inert]' && o.inert ? ({} as Element) : null),
    matches: (selector: string) => selector === ':disabled' && Boolean(o.disabled),
    getAttribute: (name: string) => (name === 'tabindex' ? (o.tabindex ?? null) : null),
    ...(o.noCheckVisibility ? {} : { checkVisibility: () => o.visible ?? true }),
  };
}

describe('isTabbable', () => {
  it('takes a visible, enabled element', () => {
    expect(isTabbable(el())).toBe(true);
    expect(isTabbable(el({ tabindex: '0' }))).toBe(true);
    expect(isTabbable(el({ noCheckVisibility: true }))).toBe(true);
  });
  it('skips hidden, inert, disabled and negative-tabindex elements', () => {
    expect(isTabbable(el({ rects: 0 }))).toBe(false);
    expect(isTabbable(el({ inert: true }))).toBe(false);
    expect(isTabbable(el({ disabled: true }))).toBe(false);
    expect(isTabbable(el({ tabindex: '-1' }))).toBe(false);
    expect(isTabbable(el({ tabindex: '-5' }))).toBe(false);
    expect(isTabbable(el({ visible: false }))).toBe(false);
  });
});

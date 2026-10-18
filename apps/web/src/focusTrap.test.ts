import { describe, expect, it } from 'vitest';
import { nextFocusIndex } from './focusTrap';

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

import { describe, expect, it } from 'vitest';
import { ANCHOR_WINDOW, anchorTextOf, reanchor } from './anchor.js';

const lines = (...l: string[]) => l;

describe('anchorTextOf', () => {
  it('trims and caps at 500 characters', () => {
    expect(anchorTextOf('   const a = 1;  ')).toBe('const a = 1;');
    expect(anchorTextOf('x'.repeat(900))).toHaveLength(500);
  });
});

describe('reanchor', () => {
  it('keeps the line when the text is still there', () => {
    expect(reanchor(2, 'b', lines('a', 'b', 'c'))).toEqual({ currentLine: 2, outdated: false });
  });

  it('follows a moved line to the nearest match within the window', () => {
    const file = lines('x', 'x', 'x', 'target', 'x', 'x', 'target');
    // original line 6: the match at 7 is nearer than the one at 4
    expect(reanchor(6, 'target', file)).toEqual({ currentLine: 7, outdated: false });
  });

  it('uses the whole file when exactly one match lies outside the window', () => {
    const file = Array.from({ length: 200 }, (_, i) => (i === 150 ? 'needle' : `l${i}`));
    expect(ANCHOR_WINDOW).toBe(50);
    expect(reanchor(10, 'needle', file)).toEqual({ currentLine: 151, outdated: false });
  });

  it('is outdated when several matches lie only outside the window', () => {
    const file = Array.from({ length: 300 }, (_, i) => (i === 150 || i === 250 ? 'dup' : `l${i}`));
    expect(reanchor(10, 'dup', file)).toEqual({ currentLine: null, outdated: true });
  });

  it('is outdated when the text is gone', () => {
    expect(reanchor(2, 'gone', lines('a', 'b'))).toEqual({ currentLine: null, outdated: true });
  });

  it('matches ignoring surrounding whitespace', () => {
    expect(reanchor(1, 'foo()', lines('', '    foo()  '))).toEqual({ currentLine: 2, outdated: false });
  });

  it('treats one-character lines as weak: never searches the whole file', () => {
    const file = Array.from({ length: 200 }, (_, i) => (i === 150 ? '}' : `l${i}`));
    expect(reanchor(10, '}', file)).toEqual({ currentLine: null, outdated: true });
    expect(reanchor(140, '}', file)).toEqual({ currentLine: 151, outdated: false });
  });
});

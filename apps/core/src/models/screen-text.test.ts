import { describe, expect, it } from 'vitest';
import { screenTextOf } from './screen-text.js';

describe('screenTextOf', () => {
  it('turns cursor moves over blank cells back into the gap they leave', () => {
    expect(screenTextOf('\x1b[3C❯ 1. Opus\x1b[20CMost capable', 80)).toBe(
      `   ❯ 1. Opus${' '.repeat(20)}Most capable`,
    );
  });

  it('does not count an erase and the move over the same cells twice', () => {
    expect(screenTextOf('a\x1b[4X\x1b[4Cb\r\nc', 80)).toBe('a    b\nc');
  });

  it('ignores colours and modes, and keeps rows apart', () => {
    expect(screenTextOf('\x1b[1;31mred\x1b[0m\r\n\x1b[?25l  two\x1b]0;title\x07', 80)).toBe('red\n  two');
  });

  it('wraps a long line at the terminal width', () => {
    expect(screenTextOf('abcdef', 4)).toBe('abcd\nef');
  });

  it('keeps only the alternate screen once the snapshot switches to it', () => {
    expect(screenTextOf('normal\r\nscreen\x1b[?1049h\x1b[Halt', 80)).toBe('alt');
  });

  it('places text written after absolute and relative cursor moves', () => {
    expect(screenTextOf('one\r\ntwo\x1b[A\x1b[2D-\x1b[2;6Hx', 80)).toBe('o-e\ntwo  x');
  });

  it('gives a wide character its two cells as one character', () => {
    expect(screenTextOf('中\x1b[1Cx', 80)).toBe('中 x');
  });
});

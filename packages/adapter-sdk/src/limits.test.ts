import { describe, expect, it } from 'vitest';
import {
  decorateWithPersona,
  headlessAskProblem,
  lastLimitOnScreen,
  parseDurationMs,
  resolveWallClock,
  stripAnsi,
  transcriptTail,
  zoneFromLabel,
} from './index.js';

const NOW = new Date('2026-10-13T09:30:00Z');

describe('parseDurationMs', () => {
  const cases: [string, number | undefined][] = [
    ['2h31m12s', (2 * 3600 + 31 * 60 + 12) * 1000],
    ['38.06s', 38_060],
    ['450ms', 450],
    ['2 days 3 hours 15 minutes', (2 * 86_400 + 3 * 3600 + 15 * 60) * 1000],
    ['4h 12m', (4 * 60 + 12) * 60_000],
    ['soon', undefined],
  ];
  it.each(cases)('%s', (text, expected) => {
    expect(parseDurationMs(text)).toBe(expected);
  });
});

describe('zoneFromLabel', () => {
  it('reads UTC, offsets and IANA names; abbreviations are ambiguous', () => {
    expect(zoneFromLabel('UTC')).toBe('UTC');
    expect(zoneFromLabel('GMT+3')).toBe('+03:00');
    expect(zoneFromLabel('UTC-04:00')).toBe('-04:00');
    expect(zoneFromLabel('+05:30')).toBe('+05:30');
    expect(zoneFromLabel('Europe/Istanbul')).toBe('Europe/Istanbul');
    expect(zoneFromLabel('EDT')).toBeUndefined();
    expect(zoneFromLabel('Mars/Olympus')).toBeUndefined();
  });
});

describe('resolveWallClock', () => {
  it('rolls a passed time to tomorrow and keeps an explicit year', () => {
    expect(resolveWallClock({ hour: 8, minute: 0 }, NOW)).toEqual(new Date('2026-10-14T08:00:00Z'));
    expect(resolveWallClock({ hour: 9, minute: 0, month: 0, day: 2, year: 2027 }, NOW)).toEqual(
      new Date('2027-01-02T09:00:00Z'),
    );
    expect(resolveWallClock({ hour: 24, minute: 0 }, NOW)).toBeUndefined();
  });
});

describe('lastLimitOnScreen', () => {
  it('takes the last matching line and the lines after it, borders and escapes removed', () => {
    const screen =
      '\x1b[31m│ limit hit │\x1b[0m\r\n│ old │\r\n│ \x1b[1mlimit hit again\x1b[0m │\r\n│ resets 5pm │\r\n';
    expect(lastLimitOnScreen(screen, (line) => line.includes('limit hit'))).toEqual({
      line: 'limit hit again',
      text: 'limit hit again resets 5pm',
    });
  });
});

describe('transcriptTail', () => {
  it('decodes the base64 excerpt of a wrapper failure hook, including UTF-8', () => {
    const line = '{"note":"résumé ✓"}';
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(line)));
    expect(transcriptTail({ transcript_tail: encoded })).toBe(line);
    expect(transcriptTail({ transcript_tail: '' })).toBe('');
    expect(transcriptTail({ transcript_tail: 'not base64!' })).toBe('');
    expect(transcriptTail({})).toBe('');
  });
});

describe('persona and headless helpers', () => {
  it('frames a persona before the task, and leaves the prompt alone without one', () => {
    expect(decorateWithPersona('go', { roleTitle: 'Architect', systemPrompt: 'Design.', rules: '' })).toBe(
      '[Role: Architect]\nDesign.\n\n---\nTask:\ngo',
    );
    expect(decorateWithPersona('go', undefined)).toBe('go');
  });

  it('only refuses asking modes for a prompted run', () => {
    expect(headlessAskProblem('Copilot', 'acceptEdits', true)).toContain('in Accept edits mode');
    expect(headlessAskProblem('Copilot', 'auto', true)).toBeNull();
    expect(headlessAskProblem('Copilot', 'default', false)).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes OSC, CSI and two-byte escapes and control characters, keeping tabs and line feeds', () => {
    const osc = '\x1b]0;title\x07a\x1b]8;;https://x.test\x1b\\b';
    expect(stripAnsi(osc)).toBe('ab');
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b[?25l\x1b[2J')).toBe('red ');
    expect(stripAnsi('\x1bDsaved\x1bE \x1bMup')).toBe('saved up');
    expect(stripAnsi('a\tb\r\nc\x00\x08\x7fd')).toBe('a\tb\ncd');
  });

  it('drops only the lead-in of an unterminated sequence', () => {
    expect(stripAnsi('\x1b]0;no end')).toBe('0;no end');
    expect(stripAnsi('\x1b[12')).toBe('[12');
    expect(stripAnsi('end\x1b')).toBe('end');
  });
});

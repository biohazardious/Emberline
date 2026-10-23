/**
 * Command output and git errors without the credentials of a hand-set origin, whatever the password
 * holds: whitespace (TAB, NBSP, other Unicode spaces) and typographic quote marks included.
 */
import { describe, expect, it } from 'vitest';
import { type ScanMeter, withoutUrlCredentials } from './gateway.js';

/** Whitespace and quote marks a password may hold. */
const ODD = ['\t', ' ', ' ', ' ', '’', '“', '”', '«', '»'];

describe('withoutUrlCredentials', () => {
  it('a password holding whitespace or a typographic quote never shows, in any address form', () => {
    for (const c of ODD) {
      const secret = `S3C${c}R3T`;
      for (const [text, shown] of [
        [
          `fatal: unable to access 'https://u:${secret}@h/o/r/': The requested URL returned error: 403`,
          "fatal: unable to access 'https://h/o/r/': The requested URL returned error: 403",
        ],
        [`https://u:${secret}@h/o/r`, 'https://h/o/r'],
        [`ssh://git:${secret}@host:2222/o/r.git`, 'ssh://host:2222/o/r.git'],
        [`alice:${secret}@host:o/r`, 'alice:***@host:o/r'],
        [
          `fatal: '${secret}@host:o/r' does not appear to be a git repository`,
          "fatal: '***@host:o/r' does not appear to be a git repository",
        ],
        [`remote: mirror alice:${secret}@host/o/r done`, 'remote: mirror alice:***@host/o/r done'],
        [`me@corp.com:${secret}@host:o/r`, 'me@corp.com:***@host:o/r'],
        [`https://u:p@${secret}@h/o/r`, 'https://h/o/r'],
      ] as const) {
        const out = withoutUrlCredentials(text);
        expect(out, JSON.stringify(text)).not.toMatch(/S3C|R3T/);
        expect(out, JSON.stringify(text)).toBe(shown);
      }
    }
  });

  it('any quote mark around the path git quotes opens it', () => {
    for (const [open, close] of [
      ['‘', '’'],
      ['“', '”'],
      ['«', '»'],
      ['`', '`'],
      ['„', '“'],
    ])
      expect(withoutUrlCredentials(`fatal: ${open}S3CRET@host:o/r${close} not found`)).toBe(
        `fatal: ${open}***@host:o/r${close} not found`,
      );
  });

  it('leaves the rest of git and server output as it is', () => {
    for (const text of [
      'To git@github.com:o/r.git',
      ' * [new branch]      emberline/run-1 -> emberline/run-1',
      'remote: Create a pull request: https://git.example.com/o/r/pulls/new by bob@example.com',
      'Author: Bob <bob@example.com> at 12:30',
      'error: refs/heads/main:refs/heads/main rejected',
      // An address ends at its line.
      'see https://git.example.com\nthen ask bob@example.com',
      "fatal: 'origin' does not appear to be a git repository",
    ])
      expect(withoutUrlCredentials(text)).toBe(text);
  });

  it('reads each character a fixed number of times, whatever the text (no backtracking, no rescans)', () => {
    const texts = (n: number) => [
      `${'a1'.repeat(n)} ${'x:'.repeat(n / 2)} ${'@h'.repeat(n / 2)}`,
      // Runs that each may open an address, then one `@` far away on the same line.
      `${"'x ".repeat(n / 3)}y@h`,
      `${'u:p '.repeat(n / 4)}y@h`,
      `${'https://h '.repeat(n / 10)}y@h`,
      `${'u:p@ss '.repeat(n / 7)}end`,
      `${'@'.repeat(n)}:${'a@'.repeat(n / 2)}`,
      `${' '.repeat(n)}https://u:p${'\t'.repeat(n)}@h`,
    ];
    const steps = (text: string) => {
      const meter: ScanMeter = { steps: 0 };
      withoutUrlCredentials(text, meter);
      return meter.steps;
    };
    const small = texts(30_000);
    const large = texts(60_000);
    small.forEach((text, i) => {
      const s = steps(text);
      const l = steps(large[i]!);
      expect(s, `text ${i}`).toBeLessThanOrEqual(4 * text.length);
      expect(l / s, `text ${i}`).toBeLessThan(2.1);
    });
  });
});

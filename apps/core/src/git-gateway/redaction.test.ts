/**
 * Command output and git errors without the credentials of a hand-set origin, whatever the password
 * holds. The rule masks too much rather than too little; the generated test below tries thousands of
 * hostile passwords in every message git prints an address in.
 */
import { describe, expect, it } from 'vitest';
import { remoteUrlForDisplay } from '../forge/hosts.js';
import { describeGitError, type ScanMeter, withoutUrlCredentials } from './gateway.js';

/** A small seeded PRNG (mulberry32): the same cases on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Letters that appear in no message, host, user or path below: any of them in the output is a leak. */
const MARKERS = 'QXZJKVW';
const HOSTILE = [
  ' ',
  '\t',
  ' ',
  ' ',
  ...`'"\`‘’‚‛“”„‟«»‹›＂＇`,
  ':',
  '/',
  '@',
  '#',
  '?',
  ...'0123456789',
  ...'abcdefgh',
];

function hostilePassword(next: () => number): string {
  const pick = (chars: readonly string[] | string) => chars[Math.floor(next() * chars.length)]!;
  const length = 3 + Math.floor(next() * 12);
  const chars = Array.from({ length }, () => pick(HOSTILE));
  // Markers at the start, the end and somewhere between, so a leak of any part shows.
  chars[0] = pick(MARKERS);
  chars[length - 1] = pick(MARKERS);
  chars[1 + Math.floor(next() * (length - 2))] = pick(MARKERS);
  // Now and then the hostile character comes first (a password that starts with a space or a quote).
  if (next() < 0.3) chars.unshift(pick(HOSTILE));
  return chars.join('');
}

const HOST = 'git.example.com';
/** User names, the git prefixes among them: a line's own prefix opens nothing, an address's does. */
const USERS = ['u', 'alice', 'fatal', 'error', 'warning', 'hint', 'remote', 'ssh'];
/** The ways an origin holds a password. */
const ADDRESSES = (pw: string, user: string) => [
  `https://${user}:${pw}@${HOST}/o/r.git`,
  `http://${user}:${pw}@${HOST}:3000/o/r.git`,
  `ssh://${user}:${pw}@${HOST}:2222/o/r.git`,
  `${user}:${pw}@${HOST}:o/r.git`,
  `me@corp.com:${pw}@${HOST}:o/r.git`,
  `${user}:${pw}@${HOST}/o/r.git`,
  `https://${user}:2024/${pw}@${HOST}/o`,
];
/** git splits an scp-like address at its first `:` and quotes the rest as a path. */
const SPLIT = (pw: string) => `${pw}@${HOST}:o/r.git`;
/**
 * The messages that carry an address, as git, ssh and servers print them, with the text before the
 * address that must survive and the text after it (null: an `@` there may take the mask on).
 */
const message = (before: string, after: string | null) => ({
  make: (a: string) => `${before}${a}${after ?? ' by bob@example.com'}`,
  before,
  after,
});
const QUOTED = [
  message("fatal: '", "' does not appear to be a git repository"),
  message("fatal: unable to access '", "/': The requested URL returned error: 403"),
  message("fatal: repository '", "/' not found"),
  message("Cloning into '", "'..."),
  message("error: failed to push some refs to '", "'"),
  message("hint: Updates were rejected; see '", "'"),
  message("warning: redirecting to '", "'"),
];
const UNQUOTED = [
  message('To ', ''),
  message('remote: mirrored to ', null),
  message('remote: ', ''),
  message('ssh: Could not resolve hostname ', ': Name or service not known'),
];

describe('withoutUrlCredentials', () => {
  it('never shows any part of a hostile password, in any address form or message, and keeps the message (generated)', () => {
    const next = random(20261023);
    let cases = 0;
    for (let n = 0; n < 1500; n++) {
      const pw = hostilePassword(next);
      const user = USERS[n % USERS.length]!;
      const texts = [
        ...ADDRESSES(pw, user).flatMap((address) => [...QUOTED, ...UNQUOTED].map((m) => ({ m, address }))),
        // The path git quotes is quoted wherever git prints it.
        ...QUOTED.map((m) => ({ m, address: SPLIT(pw) })),
      ];
      for (const { m, address } of texts) {
        const text = m.make(address);
        // Line by line, also with other lines around it and as describeGitError reads it.
        const alone = withoutUrlCredentials(text);
        for (const shown of [
          alone,
          withoutUrlCredentials(`Pushing...\n${text}\nDone`).replace(/^Pushing\.\.\.\n|\nDone$/g, ''),
          describeGitError(Object.assign(new Error('git failed'), { stderr: text })),
        ]) {
          if (/[QXZJKVW]/.test(shown))
            throw new Error(`leak: ${JSON.stringify(text)} → ${JSON.stringify(shown)}`);
          if (m.after !== null && !shown.endsWith(m.after))
            throw new Error(`message lost: ${JSON.stringify(text)} → ${JSON.stringify(shown)}`);
        }
        // The git prefix, and the message words before the address, are kept.
        if (!alone.startsWith(m.before))
          throw new Error(`prefix lost: ${JSON.stringify(text)} → ${JSON.stringify(alone)}`);
        cases++;
      }
      // An address shown on its own (Project settings) keeps nothing of the password either.
      for (const address of ADDRESSES(pw, user)) {
        const { display } = remoteUrlForDisplay(address);
        if (/[QXZJKVW]/.test(display))
          throw new Error(`display leak: ${JSON.stringify(address)} → ${display}`);
      }
    }
    expect(cases).toBe(1500 * (7 * 11 + 7));
  });

  it('keeps the address without its user info after a scheme, and masks with *** otherwise', () => {
    expect(withoutUrlCredentials('To https://alice:tok3n@git.example.com/o/r.git')).toBe(
      'To https://git.example.com/o/r.git',
    );
    expect(withoutUrlCredentials('To alice:pw@host:o/r')).toBe('To alice:***@host:o/r');
    expect(withoutUrlCredentials("'pw@host:o/r' does not appear to be a git repository")).toBe(
      "'***@host:o/r' does not appear to be a git repository",
    );
    // A git prefix that starts the line opens nothing: the quote does.
    expect(withoutUrlCredentials("fatal: 'pw@host:o/r' does not appear to be a git repository")).toBe(
      "fatal: '***@host:o/r' does not appear to be a git repository",
    );
  });

  it('leaves lines without an `@` that a host follows, or without an opener before it, as they are', () => {
    for (const text of [
      'To git@github.com:o/r.git',
      ' * [new branch]      emberline/run-1 -> emberline/run-1',
      'remote: Resolving deltas: 100% (3/3), completed with 2 local objects.',
      "fatal: 'origin' does not appear to be a git repository",
      'fatal: Could not read from remote repository.',
      'see https://git.example.com\nthen ask bob@example.com',
    ])
      expect(withoutUrlCredentials(text)).toBe(text);
  });

  it('reads each character a fixed number of times, whatever the text (no backtracking, no rescans)', () => {
    const texts = (n: number) => [
      `${'a1'.repeat(n)} ${'x:'.repeat(n / 2)} ${'@h'.repeat(n / 2)}`,
      `${"'x ".repeat(n / 3)}y@h`,
      `${'u:p '.repeat(n / 4)}y@h`,
      `${'https://h '.repeat(n / 10)}y@h`,
      `${'u:p@ss '.repeat(n / 7)}end`,
      `${'@'.repeat(n)}:${'a@'.repeat(n / 2)}`,
      `${' '.repeat(n)}https://u:p${'\t'.repeat(n)}@h`,
      `${'x@y\n'.repeat(n / 4)}`,
    ];
    // The meter counts what the scan reports about itself: every pass over the text adds to it, so
    // a change that reads the text again must count that pass too.
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
      expect(s, `text ${i}`).toBeLessThanOrEqual(2 * text.length);
      expect(l / s, `text ${i}`).toBeLessThan(2.1);
    });
  });
});

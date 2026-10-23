/**
 * Command output and git errors without the credentials of a hand-set origin, whatever the password
 * holds. The rule masks too much rather than too little; the generated test below tries thousands of
 * hostile passwords in every message git prints an address in.
 */
import { describe, expect, it } from 'vitest';
import { remoteUrlForDisplay } from '../forge/hosts.js';
import { HttpError } from '../errors.js';
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
const PREFIXES = ['fatal', 'error', 'warning', 'hint', 'remote', 'ssh'];
/** The ways an origin holds a password. */
const ADDRESSES = (pw: string, user: string) => [
  `https://${user}:${pw}@${HOST}/o/r.git`,
  `http://${user}:${pw}@${HOST}:3000/o/r.git`,
  `ssh://${user}:${pw}@${HOST}:2222/o/r.git`,
  `${user}:${pw}@${HOST}:o/r.git`,
  `me@corp.com:${pw}@${HOST}:o/r.git`,
  `${user}:${pw}@${HOST}/o/r.git`,
  `${user}:${pw}@${HOST}`,
  `https://${user}:2024/${pw}@${HOST}/o`,
];
/** git splits an scp-like address at its first `:` and quotes the rest as a path. */
const SPLIT = (pw: string) => `${pw}@${HOST}:o/r.git`;
/**
 * The messages that carry an address, as git, ssh and servers print them: the text before it (kept
 * whole when `keeps`, else at least its git prefix) and after it (null: an `@` there may take the
 * mask on).
 */
const message = (before: string, after: string | null, keeps: boolean) => ({
  make: (a: string) => `${before}${a}${after ?? ' by bob@example.com'}`,
  before,
  after,
  keeps,
});
// After a git prefix only the prefix and one space are kept (it may be a user name).
const QUOTED = [
  message("fatal: '", "' does not appear to be a git repository", false),
  message("fatal: unable to access '", "/': The requested URL returned error: 403", false),
  message("fatal: repository '", "/' not found", false),
  message("fatal: Authentication failed for '", "/'", false),
  message("Cloning into '", "'...", true),
  message("error: failed to push some refs to '", "'", false),
  message("warning: redirecting to '", "'", false),
  message("hint: see '", "'", false),
];
const UNQUOTED = [
  // The address starts the line: bare, as ssh prints it, after From, in `git remote -v`.
  message('', '', true),
  message('', ': Permission denied (publickey).', true),
  message('From ', '', true),
  message('origin\t', ' (fetch)', true),
  message('To ', '', true),
  message('remote: mirrored to ', null, false),
  message('ssh: Could not resolve hostname ', ': Name or service not known', false),
  // After each prefix, as a server or ssh may print it.
  ...PREFIXES.map((prefix) => message(`${prefix}: `, '', false)),
  ...PREFIXES.map((prefix) => message(`${prefix}: `, ': Permission denied (publickey).', false)),
];

/** 600 passwords: 134,400 texts, each read eight ways (about 4 s alone; more under a full run). */
const PASSWORDS = 600;

describe('withoutUrlCredentials', () => {
  it('never shows any part of a hostile password, in any address form or message, and keeps the message (generated)', () => {
    const next = random(20261023);
    let cases = 0;
    for (let n = 0; n < PASSWORDS; n++) {
      const pw = hostilePassword(next);
      const user = USERS[n % USERS.length]!;
      const texts = [
        ...ADDRESSES(pw, user).flatMap((address) => [...QUOTED, ...UNQUOTED].map((m) => ({ m, address }))),
        // The path git quotes is quoted wherever git prints it.
        ...QUOTED.map((m) => ({ m, address: SPLIT(pw) })),
      ];
      for (const { m, address } of texts) {
        const text = m.make(address);
        // Line by line; between other lines (LF, CRLF, a CR progress line); and every way
        // describeGitError reads a failure.
        const alone = withoutUrlCredentials(text);
        const shownAll = [
          alone,
          withoutUrlCredentials(`Pushing...\n${text}\nDone`),
          withoutUrlCredentials(`Pushing...\r\n${text}\r\nDone`),
          withoutUrlCredentials(`Counting objects: 50%\r${text}\rDone`),
          describeGitError(Object.assign(new Error('git failed'), { stderr: text })),
          describeGitError(Object.assign(new Error('git failed'), { stderr: `Pushing...\r\n${text}` })),
          describeGitError(new Error(text)),
          describeGitError(new HttpError(409, 'push_failed', text)),
        ];
        for (const shown of shownAll)
          if (/[QXZJKVW]/.test(shown))
            throw new Error(`leak: ${JSON.stringify(text)} → ${JSON.stringify(shown)}`);
        if (m.after !== null && !alone.endsWith(m.after))
          throw new Error(`message lost: ${JSON.stringify(text)} → ${JSON.stringify(alone)}`);
        // The message before the address is kept where no git prefix starts the line; a git prefix
        // and the one space after it always are.
        const kept = m.keeps ? m.before : m.before.slice(0, m.before.indexOf(':') + 2).trimEnd();
        if (!alone.startsWith(kept))
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
    expect(cases).toBe(PASSWORDS * (8 * (8 + 19) + 8));
  }, 60_000);

  it('a password that copies the start of a git message, for a user named like a git prefix, never shows (generated)', () => {
    const next = random(5);
    const COPIES = [
      " '",
      ' https://',
      " unable to access '",
      " repository '",
      " failed to push some refs to '",
      ' Could not resolve hostname ',
      ' redirecting to ',
      "\t'",
      ' ssh://',
    ];
    for (let n = 0; n < 400; n++) {
      const user = PREFIXES[n % PREFIXES.length]!;
      const pw = COPIES[n % COPIES.length]! + hostilePassword(next);
      for (const [address, host] of [
        [`${user}:${pw}@${HOST}:o/r.git`, `${HOST}:o/r.git`],
        [`${user}:${pw}@${HOST}/o/r.git`, `${HOST}/o/r.git`],
        [`${user}:${pw}@${HOST}`, HOST],
      ] as const) {
        for (const after of [
          '',
          ': Permission denied (publickey).',
          "' does not appear to be a git repository",
        ]) {
          // The address starts the line: only the user name, its `:` and one space can show.
          const kept = `${user}:${/\s/.test(pw[0]!) ? pw[0] : ''}`;
          const masked = `***@${host}${after}`;
          expect(withoutUrlCredentials(`${address}${after}`), address).toBe(kept + masked);
          expect(withoutUrlCredentials(`Pushing...\r\n${address}${after}\r\n`)).toBe(
            `Pushing...\r\n${kept}${masked}\r\n`,
          );
          // describeGitError drops git's own prefixes (fatal, error, remote) once masked.
          expect(
            describeGitError(Object.assign(new Error('git failed'), { stderr: `${address}${after}` })),
          ).toBe(['fatal', 'error', 'remote'].includes(user) ? masked : (kept + masked).trim());
        }
      }
    }
  });

  it('an address without an `@` stays as it is, in every message', () => {
    for (const address of [
      'https://git.example.com/o/r.git',
      'git.example.com:o/r.git',
      'ssh://host:2222/o/r',
    ])
      for (const m of [...QUOTED, ...UNQUOTED].filter((x) => x.after !== null)) {
        const text = m.make(address);
        expect(withoutUrlCredentials(text), text).toBe(text);
      }
  });

  it('keeps the address without its user info after a scheme, and masks with *** otherwise', () => {
    expect(withoutUrlCredentials('To https://alice:tok3n@git.example.com/o/r.git')).toBe(
      'To https://git.example.com/o/r.git',
    );
    expect(withoutUrlCredentials('To alice:pw@host:o/r')).toBe('To alice:***@host:o/r');
    expect(withoutUrlCredentials("'pw@host:o/r' does not appear to be a git repository")).toBe(
      "'***@host:o/r' does not appear to be a git repository",
    );
    // A git prefix that starts the line may be a user name: only it and one space are kept.
    expect(withoutUrlCredentials("fatal: 'pw@host:o/r' does not appear to be a git repository")).toBe(
      "fatal: ***@host:o/r' does not appear to be a git repository",
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

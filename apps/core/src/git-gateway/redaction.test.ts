/**
 * Command output and git errors without the credentials of a hand-set origin, whatever the password
 * holds, and git's own messages still readable. Two layers: the password of an address core knows
 * (the one git was given) is masked exactly wherever it shows; any other address is masked by a
 * rule that masks too much rather than too little. The generated tests below try thousands of
 * hostile passwords in every message git prints an address in, with and without the address known.
 */
import { describe, expect, it } from 'vitest';
import { remoteUrlForDisplay } from '../forge/hosts.js';
import { HttpError } from '../errors.js';
import {
  describeGitError,
  type KnownSecrets,
  redactGitText,
  type ScanMeter,
  withoutUrlCredentials,
} from './gateway.js';

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
  ' ',
  ' ',
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
 * Where git prints an address: `url`, only a `scheme://` URL (curl's messages); `any`, any address;
 * `path`, a path or no address at all (in git's own output), so an `@` there may always be masked.
 */
type Kind = 'url' | 'any' | 'path';
/**
 * A message that carries an address, as git, ssh and servers print it: the text before it (kept
 * whole when `keeps`, else at least its git prefix and one space) and after it (null: an `@` there
 * may take the mask on).
 */
const message = (before: string, after: string | null, keeps: boolean, kind: Kind) => ({
  make: (a: string) => `${before}${a}${after ?? ' by bob@example.com'}`,
  before,
  after,
  keeps,
  kind,
});
const QUOTED = [
  // git's own messages: the prefix, the phrase and the quote mark stay.
  message("fatal: '", "' does not appear to be a git repository", true, 'path'),
  message("fatal: unable to access '", "/': The requested URL returned error: 403", true, 'url'),
  message("fatal: repository '", "/' not found", true, 'url'),
  message("fatal: Authentication failed for '", "/'", true, 'url'),
  message("fatal: could not read Password for '", "': terminal prompts disabled", true, 'url'),
  message("error: failed to push some refs to '", "'", true, 'any'),
  message("Cloning into '", "'...", true, 'path'),
  // Not git's: after the prefix and one space, everything up to the address's `@` goes.
  message("warning: redirecting to '", "'", false, 'path'),
  message("hint: see '", "'", false, 'path'),
];
const UNQUOTED = [
  // The address starts the line: bare, as ssh prints it, after From, in `git remote -v`.
  message('', '', true, 'any'),
  message('', ': Permission denied (publickey).', true, 'any'),
  message('From ', '', true, 'any'),
  message('origin\t', ' (fetch)', true, 'any'),
  message('To ', '', true, 'any'),
  message('remote: mirrored to ', null, false, 'path'),
  message('ssh: Could not resolve hostname ', ': Name or service not known', false, 'path'),
  // After each prefix, as a server or ssh may print it.
  ...PREFIXES.map((prefix) => message(`${prefix}: `, '', false, 'path')),
  ...PREFIXES.map((prefix) => message(`${prefix}: `, ': Permission denied (publickey).', false, 'path')),
];
const TEMPLATES = [...QUOTED, ...UNQUOTED];

/** Every way a text is read: line by line, between other lines, and every way describeGitError reads a failure. */
const readings = (text: string, known?: KnownSecrets) => [
  redactGitText(`Pushing...\n${text}\nDone`, known),
  redactGitText(`Pushing...\r\n${text}\r\nDone`, known),
  redactGitText(`Counting objects: 50%\r${text}\rDone`, known),
  describeGitError(Object.assign(new Error('git failed'), { stderr: text }), known),
  describeGitError(Object.assign(new Error('git failed'), { stderr: `Pushing...\r\n${text}` }), known),
  describeGitError(new Error(text), known),
  describeGitError(new HttpError(409, 'push_failed', text), known),
];

/** 200 passwords: 98,800 texts, each read eight ways (about 5 s alone; more under a full run). */
const PASSWORDS = 200;

describe('git output and errors', () => {
  it('never show any part of a hostile password, known or not, in any address form or message, and keep the message (generated)', () => {
    const next = random(20261023);
    let cases = 0;
    const check = (m: (typeof TEMPLATES)[number], address: string, known?: KnownSecrets) => {
      const text = m.make(address);
      const alone = redactGitText(text, known);
      for (const shown of [alone, ...readings(text, known)])
        if (/[QXZJKVW]/.test(shown))
          throw new Error(
            `leak${known ? ' (known)' : ''}: ${JSON.stringify(text)} → ${JSON.stringify(shown)}`,
          );
      if (m.after !== null && !alone.endsWith(m.after))
        throw new Error(`message lost: ${JSON.stringify(text)} → ${JSON.stringify(alone)}`);
      const kept = m.keeps ? m.before : m.before.slice(0, m.before.indexOf(':') + 2).trimEnd();
      if (!alone.startsWith(kept))
        throw new Error(`prefix lost: ${JSON.stringify(text)} → ${JSON.stringify(alone)}`);
      cases++;
    };
    for (let n = 0; n < PASSWORDS; n++) {
      const pw = hostilePassword(next);
      const user = USERS[n % USERS.length]!;
      for (const address of ADDRESSES(pw, user))
        for (const m of TEMPLATES) {
          check(m, address);
          check(m, address, { addresses: [address] });
        }
      // The path git quotes after splitting the address: masked as a path where git prints one, and
      // wherever it shows once the address is known.
      const split = { addresses: [`${user}:${pw}@${HOST}:o/r.git`] };
      for (const m of TEMPLATES) {
        if (m.kind === 'path') check(m, SPLIT(pw));
        check(m, SPLIT(pw), split);
      }
      // An address shown on its own (Project settings) keeps nothing of the password either.
      for (const address of ADDRESSES(pw, user)) {
        const { display } = remoteUrlForDisplay(address);
        if (/[QXZJKVW]/.test(display))
          throw new Error(`display leak: ${JSON.stringify(address)} → ${display}`);
      }
    }
    const paths = TEMPLATES.filter((m) => m.kind === 'path').length;
    expect(cases).toBe(PASSWORDS * (8 * TEMPLATES.length * 2 + TEMPLATES.length + paths));
  }, 60_000);

  it('a password that copies the start of a git message, for a user named like a git prefix (generated)', () => {
    const next = random(5);
    /** A password's start that copies git's wording, and what of it may show with the address unknown. */
    const COPIES: [copy: string, visible: string][] = [
      // git's own phrases: the copy shows, the password's own characters after it never.
      ...[" '", "\t'", " unable to access '", " repository '", " failed to push some refs to '"].map(
        (c): [string, string] => [c, c],
      ),
      [" Authentication failed for '", " Authentication failed for '"],
      [" could not read Password for 'https://", " could not read Password for '"],
      [" unable to access 'https://", " unable to access '"],
      // Anything else: one whitespace character after the prefix.
      [' https://', ' '],
      [' Could not resolve hostname ', ' '],
      [' redirecting to ', ' '],
      [' ssh://', ' '],
    ];
    for (let n = 0; n < 400; n++) {
      const user = PREFIXES[n % PREFIXES.length]!;
      const [copy, visible] = COPIES[n % COPIES.length]!;
      const pw = copy + hostilePassword(next);
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
          const text = `${address}${after}`;
          const masked = `***@${host}${after}`;
          // Unknown, at the start of a line: the user name, its `:`, and a copy of a phrase of git's
          // (else one whitespace character) can show; never the password's own characters.
          expect(withoutUrlCredentials(text), text).toBe(`${user}:${visible}${masked}`);
          expect(withoutUrlCredentials(`Pushing...\r\n${text}\r\n`)).toBe(
            `Pushing...\r\n${user}:${visible}${masked}\r\n`,
          );
          const described = describeGitError(Object.assign(new Error('git failed'), { stderr: text }));
          expect(`${user}:${visible}${masked}`.endsWith(described), described).toBe(true);
          expect(described.endsWith(masked.trim()), described).toBe(true);
          // Known: nothing of it, the copy too.
          const known = { addresses: [address] };
          expect(redactGitText(text, known), text).toBe(`${user}:${masked}`);
          // describeGitError drops git's own prefixes (fatal, error, remote) once masked.
          expect(describeGitError(Object.assign(new Error('git failed'), { stderr: text }), known)).toBe(
            ['fatal', 'error', 'remote'].includes(user) ? masked : `${user}:${masked}`,
          );
        }
      }
    }
  });

  it("keeps git's messages whole for addresses without a password", () => {
    const CLEAN = [
      'git@github.com:o/r.git',
      'https://github.com/o/r.git',
      `http://${HOST}:3000/o/r.git`,
      `ssh://git@${HOST}:2222/o/r.git`,
      `ssh://${HOST}:2222/o/r`,
      `${HOST}:o/r.git`,
    ];
    const fits = (kind: Kind, address: string) =>
      kind === 'any' || (kind === 'url' ? /^https?:\/\//.test(address) : !address.includes('@'));
    let checked = 0;
    for (const address of CLEAN)
      for (const m of TEMPLATES.filter((x) => x.after !== null && fits(x.kind, address))) {
        const text = m.make(address);
        expect(withoutUrlCredentials(text), text).toBe(text);
        expect(redactGitText(text, { addresses: [address] }), text).toBe(text);
        expect(describeGitError(Object.assign(new Error('git failed'), { stderr: text }))).toBe(
          text.replace(/^(?:fatal|error|remote): /, '').trim(),
        );
        checked++;
      }
    expect(checked).toBeGreaterThan(100);
  });

  it('keeps the prefix, the phrase and what follows the address, and shows *** where it cut', () => {
    for (const [text, shown] of [
      // An address without a password, as before.
      ["error: failed to push some refs to 'git@github.com:o/r.git'", null],
      // An http user name may be a token: masked.
      [
        "fatal: could not read Password for 'https://alice@github.com': terminal prompts disabled",
        "fatal: could not read Password for 'https://***@github.com': terminal prompts disabled",
      ],
      ["fatal: 'origin' does not appear to be a git repository", null],
      // A path's `@` cannot be told from a password's end: masked inside the quote.
      [
        "fatal: unable to access 'https://github.com/o/r@v2.git/': The requested URL returned error: 403",
        "fatal: unable to access 'https://***@v2.git/': The requested URL returned error: 403",
      ],
      [
        "fatal: 'git@github.com:o/r.git' does not appear to be a git repository",
        "fatal: '***@github.com:o/r.git' does not appear to be a git repository",
      ],
      // With a password: the user name and host stay where git quotes the address.
      [
        "fatal: unable to access 'https://u:p@github.com/o/r.git/': Could not resolve host: github.com",
        "fatal: unable to access 'https://***@github.com/o/r.git/': Could not resolve host: github.com",
      ],
      [
        "fatal: repository 'https://u:tok@h/o/r.git/' not found",
        "fatal: repository 'https://***@h/o/r.git/' not found",
      ],
      [
        "fatal: Authentication failed for 'https://u:tok@h/o/r.git/'",
        "fatal: Authentication failed for 'https://***@h/o/r.git/'",
      ],
      [
        "error: failed to push some refs to 'alice:pw@h:o/r.git'",
        "error: failed to push some refs to 'alice:***@h:o/r.git'",
      ],
      // A word with whitespace or a quote mark in it is no address git quotes: all of it goes.
      [
        "fatal: unable to access 'https://u:p w@h/o/r.git/': error",
        "fatal: unable to access '***@h/o/r.git/': error",
      ],
      // Not git's end of that message: the line may be an address whose user is `fatal`.
      [
        "fatal: unable to access 'pw@h: Permission denied",
        "fatal: unable to access '***@h: Permission denied",
      ],
      ["fatal: unable to access 'pw@h/o' x", "fatal: unable to access '***@h/o' x"],
      // Outside a git prefix: from the first opener, `***` where it cut.
      ['To https://alice:tok3n@git.example.com/o/r.git', 'To https://***@git.example.com/o/r.git'],
      ['To https://github.com/o/r@v2.git', 'To https://***@v2.git'],
      ['To ssh://git@host:2222/o/r.git', null],
      // Its own `@` only: another address after it is no user name.
      ["To ssh://git@host/x 'pw@h2:o/r'", "To ssh://***@h2:o/r'"],
      ['To ssh://git:pw@host:2222/o/r.git', 'To ssh://***@host:2222/o/r.git'],
      ['To git+ssh://git@host/o/r.git', 'To git+ssh://***@host/o/r.git'],
      ['To alice:pw@host:o/r', 'To alice:***@host:o/r'],
      [
        "'pw@host:o/r' does not appear to be a git repository",
        "'***@host:o/r' does not appear to be a git repository",
      ],
      // Any other prefixed line: the prefix and one space.
      ['remote: Commit by alice <alice@example.com>', 'remote: ***@example.com>'],
    ] as const)
      expect(withoutUrlCredentials(text), text).toBe(shown ?? text);
    expect(
      describeGitError(
        Object.assign(new Error('git failed'), {
          stderr:
            "fatal: unable to access 'https://u:p@github.com/o/r.git/': Could not resolve host: github.com",
        }),
      ),
    ).toBe("unable to access 'https://***@github.com/o/r.git/': Could not resolve host: github.com");
  });

  it('masks a known password wherever it shows, as written, percent-decoded and percent-encoded', () => {
    const known = { addresses: ['https://u:S3C%2FR3T@h/o/r.git'] };
    expect(redactGitText('remote: token S3C%2FR3T and S3C/R3T expired', known)).toBe(
      'remote: token *** and *** expired',
    );
    expect(redactGitText('remote: who? SECRET', { addresses: ['me@corp.com:SECRET@h:o/r'] })).toBe(
      'remote: who? ***',
    );
    expect(redactGitText('ssh: S3CRET read', { addresses: ['ssh://git:S3CRET@h/o'] })).toBe('ssh: *** read');
    // A password read as a port and a path: all of it, wherever it shows.
    expect(redactGitText('x 2024/S3CRET y', { addresses: ['https://u:2024/S3CRET@h/o'] })).toBe('x *** y');
    // A short one only where it sits in its address, between its user name and `@`.
    expect(redactGitText('ab: ab', { addresses: ['https://u:ab@h/o'] })).toBe('ab: ab');
    expect(redactGitText('To https://u:ab@h/o', { addresses: ['https://u:ab@h/o'] })).toBe(
      'To https://***@h/o',
    );
    // Even where the line could be git's own words: a user named `fatal`, the password ` '`.
    expect(redactGitText("fatal: '@h: Permission denied", { addresses: ["fatal: '@h:o/r"] })).toBe(
      'fatal:***@h: Permission denied',
    );
    expect(withoutUrlCredentials("fatal: '@h: Permission denied")).toBe("fatal: '***@h: Permission denied");
    // The account's token and its Basic value, as before.
    const credential = { serverUrl: 'https://h', username: 'x-access-token', token: 'ghp_T0KEN' };
    expect(redactGitText('remote: ghp_T0KEN', { credential })).toBe('remote: [redacted]');
    // An address without a password, or none: nothing to mask.
    expect(redactGitText('git fetch git', { addresses: ['git@github.com:o/r.git', null] })).toBe(
      'git fetch git',
    );
  });

  it('reads each character a fixed number of times, whatever the text (no backtracking, no rescans)', () => {
    const texts = (n: number) => [
      `${'a1'.repeat(n)} ${'x:'.repeat(n / 2)} ${'@h'.repeat(n / 2)}`,
      `${"'x ".repeat(n / 3)}y@h`,
      `${'u:p '.repeat(n / 4)}y@h`,
      `${'https://h '.repeat(n / 10)}y@h`,
      `${'u:p@ss '.repeat(n / 7)}end`,
      `${'@'.repeat(n)}:${'a@'.repeat(n / 2)}`,
      `${' '.repeat(n)}https://u:p${'\t'.repeat(n)}@h`,
      `${'x@y\n'.repeat(n / 4)}`,
      // git's messages: the quoted word, the end of the message, the scheme, the mask.
      `fatal: unable to access '${'a'.repeat(n)}@h'${' '.repeat(n)}`,
      `fatal: unable to access 'https://${'u:'.repeat(n / 2)}@h': x`,
      `error: failed to push some refs to '${'a@b'.repeat(n / 3)}'${' '.repeat(n)}x`,
      `fatal: ${"'".repeat(n)}@h`,
      `To ssh://${'a'.repeat(n)}@h ssh://${'b'.repeat(n)}@h`,
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
      expect(s, `text ${i}`).toBeLessThanOrEqual(4 * text.length);
      expect(l / s, `text ${i}`).toBeLessThan(2.1);
    });
  });
});

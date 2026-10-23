/**
 * Text as a person or a log may read it: no capability URL, and no credential of an address in it
 * (git, ssh and servers print addresses in their messages). Nothing here knows any secret; what core
 * knows is masked first by the caller (gateway.ts, redactGitText).
 */

export function redactCapabilityUrls(text: string): string {
  return text.replace(/\/api\/internal\/git\/[A-Za-z0-9_-]{20,}/g, '/api/internal/git/[capability]');
}

/** Whitespace as `\s` reads it. */
const isSpace = (c: number) =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;
/** ASCII, typographic and fullwidth quote marks. */
const QUOTES = new Set(`'"\`‘’‚‛“”„‟«»‹›＂＇`);
/** A character that may start a host after an `@` (an email's domain counts too). */
const startsHost = (ch: string | undefined) =>
  ch !== undefined && ch !== '@' && ch !== '/' && ch !== ':' && !QUOTES.has(ch) && !isSpace(ch.charCodeAt(0));

/**
 * Counts the characters a redaction handles (the linear-time test reads it).
 * Every pass over the text adds what it reads; a new pass that does not would hide from that test.
 */
export interface ScanMeter {
  steps: number;
}

/**
 * Text without the credentials of the addresses in it (a token typed into an origin, or one a
 * server quotes back), for an address core does not know (what it knows goes first, see
 * redactGitText). One rule, line by line, that masks too much rather than ever too little: from the
 * first credential opener on the line to the last `@` on it that a host follows, all goes, and
 * `***` takes its place.
 * - The openers: a `scheme://` (from after `://`), a quote mark of any kind (from after it), and a
 *   `:` in a word (from after the word's first `:`, so `user:` keeps its user name). An `ssh://`
 *   whose own `@` is that `@`, with no `:` before it, opens nothing: a user name, never a password.
 * - A git prefix that starts the line (`fatal: `, `remote: `, …, see LINE_PREFIX) is read apart,
 *   so git's own messages stay readable (see withoutPrefixedLineCredentials).
 * So a password never shows, whatever it holds (whitespace, quote marks, `:`, `/`, `@`, `#`, `?`),
 * and so may an email, a path or a git message's words between an opener and an `@`.
 * Linear: each line is read at most four times.
 */
export function withoutUrlCredentials(text: string, meter?: ScanMeter): string {
  let out = '';
  for (let start = 0; ;) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    out += withoutLineCredentials(text.slice(start, end), meter);
    if (newline < 0) return out;
    out += '\n';
    start = newline + 1;
  }
}

/**
 * The prefixes git, ssh and a server put at the start of a line (`fatal: …`; `ssh://…` is an
 * address). Such a word may as well be the user name of an address that starts the line
 * (`ssh: S3CRET@host: Permission denied`), so the word, its `:` and one whitespace character after
 * it are kept, and what follows only when it is one of git's messages (GIT_QUOTES).
 */
const LINE_PREFIX = /^(?:fatal|error|warning|hint|remote|ssh):(?!\/\/)\s?/;

/**
 * git's messages that quote an address after a line prefix. The phrase and its quote mark always
 * stay. The quoted text is read as the address git quotes (so a user name and host show, and only
 * what a password may hold goes) when it is one word (no whitespace or quote mark) that holds the
 * line's last `@` before a host and is closed by a quote mark that the message's own end (`end`)
 * follows; curl's messages (`url`) quote only a `scheme://` URL. Otherwise everything from the quote
 * mark to that `@` goes: the line may as well be an address whose user name is the prefix word and
 * whose password copies the phrase (only that copy then shows).
 * `'` alone (`'<path>' does not appear to be a git repository`) quotes a path, which may start with
 * a password (git reads `user:pw@host:path` as the path `pw@host:path` on `user`): masked from the
 * quote mark.
 * What this lets show of an address core does not know (every caller passes the addresses it knows,
 * which are masked first), in texts git and ssh never print: after a line-start address whose user
 * name is a prefix word and whose password copies one of these messages up to its quote mark, and
 * whose host is followed by that message's own end, the copied phrase (with a curl phrase's
 * `scheme://`) and, for a quoted word without an opener, the password; and git's split path quoted
 * after `failed to push some refs to '`. git anonymises the address in all of these messages, and
 * ssh's `user@host` line never ends with a quote mark.
 */
const GIT_QUOTES: readonly { phrase: string; end?: RegExp; url?: boolean }[] = [
  { phrase: "unable to access '", end: /^': /, url: true },
  { phrase: "repository '", end: /^' not found\s*$/, url: true },
  { phrase: "Authentication failed for '", end: /^'\s*$/, url: true },
  { phrase: "could not read Username for '", end: /^': /, url: true },
  { phrase: "could not read Password for '", end: /^': /, url: true },
  { phrase: "failed to push some refs to '", end: /^'\s*$/ },
  { phrase: "'" },
];

function withoutLineCredentials(line: string, meter?: ScanMeter): string {
  if (meter) meter.steps += line.length;
  let at = line.length - 1;
  while (at >= 0 && !(line[at] === '@' && startsHost(line[at + 1]))) at--;
  if (at < 0) return line;
  const prefixLength = LINE_PREFIX.exec(line)?.[0].length ?? 0;
  if (prefixLength > 0) return withoutPrefixedLineCredentials(line, prefixLength, at, meter);
  return masked(line, 0, at, meter);
}

/**
 * `line` with everything from its first opener at or after `from` up to `at` (its last `@` that a
 * host follows) masked, or as it is without such an opener.
 */
function masked(line: string, from: number, at: number, meter?: ScanMeter): string {
  let i = from;
  while (i < at && line[i] !== ':' && !QUOTES.has(line[i]!)) i++;
  if (meter) meter.steps += i - from;
  if (i >= at) return line;
  if (line[i] !== ':' || !line.startsWith('//', i + 1)) return `${line.slice(0, i + 1)}***${line.slice(at)}`;
  // `ssh://user@host`, its `@` the one at `at`: a user name, never a password.
  let end = i + 3;
  while (end < at && line[end] !== ':' && !QUOTES.has(line[end]!) && !isSpace(line.charCodeAt(end))) end++;
  if (meter) meter.steps += end - i;
  if (end === at && /(?:^|[^a-z0-9+.-])ssh$/i.test(line.slice(Math.max(from, i - 4), i))) return line;
  return `${line.slice(0, i + 3)}***${line.slice(at)}`;
}

/**
 * A line that starts with a git prefix, `at` its last `@` that a host follows: the prefix stays, and
 * so does one of git's messages after it (GIT_QUOTES); everything else up to `at` goes
 * (`fatal: ***@host:o/r`).
 */
function withoutPrefixedLineCredentials(
  line: string,
  prefixLength: number,
  at: number,
  meter?: ScanMeter,
): string {
  const quote = GIT_QUOTES.find((q) => line.startsWith(q.phrase, prefixLength));
  if (!quote) return `${line.slice(0, prefixLength)}***${line.slice(at)}`;
  const inside = prefixLength + quote.phrase.length;
  if (quote.end) {
    // The quoted word: up to the first whitespace or quote mark.
    let close = inside;
    while (close < line.length && !QUOTES.has(line[close]!) && !isSpace(line.charCodeAt(close))) close++;
    if (meter) meter.steps += 2 * (close - inside) + (line.length - close);
    const isAddress =
      close > at &&
      QUOTES.has(line[close] ?? '') &&
      quote.end.test(line.slice(close)) &&
      (!quote.url || /^[a-z][a-z0-9+.-]*:\/\//i.test(line.slice(inside, close)));
    if (isAddress) return masked(line, inside, at, meter);
  }
  return `${line.slice(0, inside)}***${line.slice(at)}`;
}

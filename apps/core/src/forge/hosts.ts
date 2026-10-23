export function hostOf(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  const trimmed = url.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      // An ssh port never serves the API: `ssh://git@host:2222/…` trusts `host`.
      return (parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host).toLowerCase();
    }
  } catch {
    return null;
  }
  // SCP-style SSH: git@host:owner/repo.git. The user info runs to the last `@` before the first `/`
  // that a host and its `:` follow (`user:p@ss@host:path` is on `host`), as remoteUrlForDisplay reads it.
  return /^(?:[^/]*@)?([^:/@]+):/.exec(trimmed)?.[1]?.toLowerCase() ?? null;
}

/**
 * A remote as two of the same repository compare: its scheme and host in lower case (DNS and git
 * read them so), everything else as it is. For remotes already without credentials
 * (remoteUrlForDisplay's `url`).
 */
export function remoteCompareKey(url: string): string {
  const lower = (host: string) => host.toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url))
    return url.replace(
      /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^/?#@]*)/i,
      (_m, scheme: string, user: string | undefined, host: string) =>
        lower(scheme) + (user ?? '') + lower(host),
    );
  return url.replace(
    /^([^/]*@)?([^:/@]+)(?=:)/,
    (_m, user: string | undefined, host: string) => (user ?? '') + lower(host),
  );
}

/**
 * Whether two remotes of a repository name the same server. The port counts only when both are
 * http(s) URLs: an ssh remote on a custom port (`ssh://git@host:2222/…`, common for Gitea) and an
 * https URL on the same hostname are the same server.
 */
export function sameForgeServer(a: string, b: string): boolean {
  const isHttp = (url: string) => /^https?:\/\//i.test(url.trim());
  const hostA = hostOf(a);
  const hostB = hostOf(b);
  if (!hostA || !hostB) return false;
  if (isHttp(a) && isHttp(b)) return hostA === hostB;
  const hostname = (host: string) => host.replace(/:\d+$/, '');
  return hostname(hostA) === hostname(hostB);
}

/**
 * Counts the characters a read of an address handles (the linear-time test reads it).
 * Every pass over the text adds what it reads; a new pass that does not would hide from that test.
 */
export interface ScanMeter {
  steps: number;
}

/**
 * Reads an address left to right, each scan from a given index to the first of some characters,
 * counting the characters it passes. No pattern backtracks, so a long hand-set address is read in
 * linear time.
 */
class AddressReader {
  constructor(
    readonly text: string,
    private readonly meter?: ScanMeter,
  ) {}

  /** The first index at or after `from` holding one of `stops`, else the length. */
  next(stops: string, from: number): number {
    let i = from;
    while (i < this.text.length && !stops.includes(this.text[i]!)) i++;
    if (this.meter) this.meter.steps += i - from + 1;
    return i;
  }

  /** The last `@` after `from` and before `to`, else -1. */
  lastAt(from: number, to: number): number {
    let i = to - 1;
    while (i > from && this.text[i] !== '@') i--;
    if (this.meter) this.meter.steps += to - i;
    return i > from ? i : -1;
  }

  /**
   * After a host starting at `at` (a name without `/@:[]`, or `[v6]`): the index right after it,
   * else -1. It stops at the next `@` at the latest.
   */
  afterHost(at: number): number {
    const end = this.next('/@:[]', at);
    if (end > at) return end;
    if (this.text[at] !== '[') return -1;
    const close = this.next(']/@', at + 1);
    return this.text[close] === ']' ? close + 1 : -1;
  }

  /** The length of a leading `scheme://`, else 0. */
  scheme(): number {
    const t = this.text;
    if (!/[a-z]/i.test(t[0] ?? '')) return 0;
    let i = 1;
    while (i < t.length && /[a-z0-9+.-]/i.test(t[i]!)) i++;
    if (this.meter) this.meter.steps += i;
    return t.startsWith('://', i) ? i + 3 : 0;
  }
}

/**
 * The scp-like forms that may hold `user:secret@`:
 * - `plain`: the one read as credentials without doubt, `user:secret@host:path` with a single `@`
 *   before the first `/` and a host (or `[v6]`) and its `:` right after it, and no `@` after the
 *   first `/` that a host follows. `user` ends at `userEnd`, the secret at the `@` at `at`.
 * - `masked`: any other `user:…@` before the first `/`, up to its last such `@` (the user runs to the
 *   first of `/@:[`); or a user name that holds an `@` (`me@corp.com:secret@host:o/r`, the user runs
 *   to the first of `/:[`), up to the last `@` before the first `/` that a host and its `:` or `/` (or
 *   the end) follow. Git itself reads the latter as the host `corp.com`, so it is never rewritten.
 *   An `@` after the first `/` that a host and its `/` or `:` follow (a `/` in the password, or a
 *   path's `@`: they cannot be told apart) takes the mask on to it.
 * `beforePath`: a `user:…@` comes before the first `/` (what Connect refuses).
 */
function scpCredentials(
  r: AddressReader,
): { kind: 'plain' | 'masked'; userEnd: number; at: number; beforePath: boolean } | null {
  const t = r.text;
  const n = t.length;
  const colon = r.next('/@:[', 0);
  let userEnd: number;
  let slash: number;
  let found: { kind: 'plain' | 'masked'; at: number } | null = null;
  if (t[colon] === ':') {
    userEnd = colon;
    slash = r.next('/', colon + 1);
    const firstAt = r.next('/@', colon + 1);
    if (t[firstAt] === '@') {
      const host = r.afterHost(firstAt + 1);
      if (host >= 0 && t[host] === ':') {
        const rest = r.next('/@', host + 1);
        if (rest === n || t[rest] === '/') found = { kind: 'plain', at: firstAt };
      }
    }
    if (!found) {
      const at = r.lastAt(colon, slash);
      if (at >= 0) found = { kind: 'masked', at };
    }
  } else {
    // A user name with an `@`: it runs to the first of `/:[`, and must hold an `@` before it.
    userEnd = r.next('/:[', 0);
    if (t[userEnd] !== ':' || r.lastAt(-1, userEnd) < 0) return null;
    slash = r.next('/', userEnd + 1);
    for (let at = r.lastAt(userEnd, slash); at >= 0 && !found; at = r.lastAt(userEnd, at)) {
      const host = r.afterHost(at + 1);
      if (host >= 0 && (host === n || t[host] === ':' || t[host] === '/')) found = { kind: 'masked', at };
    }
  }
  const pathAt = lastAtBeforePath(r, slash);
  if (pathAt >= 0) return { kind: 'masked', userEnd, at: pathAt, beforePath: found !== null };
  return found ? { ...found, userEnd, beforePath: true } : null;
}

/**
 * `user:pa/ss@host/path` or `user:pa/ss@host`: a `/` in the password puts its `@` after the first
 * `/` (at `slash`). The last `@` after it that a host and its `/`, `:` or the end follow, else -1.
 * A path's `@` reads the same (`gitea:team/app@v2.git`): shown masked too, as it may be a password's.
 */
function lastAtBeforePath(r: AddressReader, slash: number): number {
  const t = r.text;
  for (let at = r.lastAt(slash, t.length); at >= 0; at = r.lastAt(slash, at)) {
    const host = r.afterHost(at + 1);
    if (host >= 0 && (host === t.length || t[host] === ':' || t[host] === '/')) return at;
  }
  return -1;
}

/**
 * Whether an scp-like address holds `user:…@` before its first `/`: what Connect refuses. An `@`
 * after the first `/` (`gitea:team/app@v2/x.git`, `git@host:o/r@v2/x.git`) is a path's, as git reads
 * it, even when the display masks it.
 */
export function scpUserInfoBeforePath(raw: string): boolean {
  return scpCredentials(new AddressReader(raw.trim()))?.beforePath ?? false;
}

/** A character that may start a host after an `@`. */
const startsHost = (ch: string | undefined) => ch !== undefined && !/[\s@/:'"`]/.test(ch);

/**
 * Where the authority of a `scheme://` address ends, as the URL parser reads it: at the first `/`,
 * `?` or `#`, and for the schemes it treats as special (http, https, ws, wss, ftp, file) at a `\`
 * too.
 */
function authorityEndOf(r: AddressReader, schemeEnd: number): number {
  const special = /^(?:https?|wss?|ftp|file):/i.test(r.text);
  return r.next(special ? '/\\?#' : '/?#', schemeEnd);
}

/**
 * A remote URL as core may store, compare and quote it.
 * - `url`: an http(s) URL without user info, query or fragment; an ssh URL without a password (its
 *   user name picks the key and stays); `user:secret@host:path` as `user@host:path`. An scp-like
 *   address that may or may not hold credentials (`host:a@x/y` is the path `a@x/y` on `host`, or the
 *   user `host` on `x`; `alice:p@ss:w@host:o`), and a URL whose password reads as a port
 *   (`https://u:2024/rest@host/…`, the same shape as `https://host:8443/g/n@v2/r.git`), comes back
 *   as it was, so two such remotes never compare equal.
 * - `display`: `url`, except that an address cut at an `@` shows `***` where it was cut
 *   (`https://***@v2/r.git`, `user:***@host:path`), never a clean-looking other address. Anything
 *   shown to a person or written to a log uses this.
 * - `hadCredentials`: something was removed, or may be a secret.
 * A clean URL comes back exactly as it was. Read in linear time (`meter` counts the steps).
 */
export function remoteUrlForDisplay(
  raw: string,
  meter?: ScanMeter,
): { url: string; display: string; hadCredentials: boolean } {
  const url = raw.trim();
  const r = new AddressReader(url, meter);
  const schemeEnd = r.scheme();
  if (schemeEnd > 0) {
    const withoutQuery = (text: string) => text.slice(0, new AddressReader(text, meter).next('?#', 0));
    // `scheme://***@…` from the `@` at `at` on, without its query or fragment.
    const cutAt = (at: number) => withoutQuery(`${url.slice(0, schemeEnd)}***${url.slice(at)}`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Not parseable: cut everything from `//` to the last `@` (whitespace in a password too),
      // and from `?` or `#` on.
      const at = r.lastAt(schemeEnd - 1, url.length);
      const clean = withoutQuery(at >= 0 ? url.slice(0, schemeEnd) + url.slice(at + 1) : url);
      return { url: clean, display: at >= 0 ? cutAt(at) : clean, hadCredentials: clean !== url };
    }
    const clean = (() => {
      const ssh = parsed.protocol === 'ssh:';
      if (!(ssh ? parsed.password : parsed.username || parsed.password || parsed.search || parsed.hash))
        return url;
      parsed.password = '';
      if (!ssh) {
        parsed.username = '';
        parsed.search = '';
        parsed.hash = '';
      }
      return parsed.toString();
    })();
    // A password holding `/`, `?` or `#` ends what the parser reads as user info and host early:
    // `https://u:2024/Secret@h/o/r` reads as the port 2024 and a path, as git reads it, and so does
    // `https://host:8443/g/n@v2/r.git`; the two cannot be told apart. For http(s) the parser ends
    // them at a `\` too, which git sends as part of the user info (`https://u:2024\S3CRET@host/`).
    // When a `:` comes before the first of these, or a `\` ends them, and an `@` that a host
    // follows comes after it, the address is shown cut up to that `@` (it is kept as the parser
    // cleans it, so Connect may take it).
    const authorityEnd = authorityEndOf(r, schemeEnd);
    if (url.slice(schemeEnd, authorityEnd).includes(':') || url[authorityEnd] === '\\') {
      let at = url.length - 1;
      while (at >= authorityEnd && !(url[at] === '@' && startsHost(url[at + 1]))) at--;
      if (meter) meter.steps += url.length - at;
      if (at >= authorityEnd) return { url: clean, display: cutAt(at), hadCredentials: true };
    }
    return { url: clean, display: clean, hadCredentials: clean !== url };
  }
  const found = scpCredentials(r);
  if (!found) return { url, display: url, hadCredentials: false };
  const user = url.slice(0, found.userEnd);
  const host = url.slice(found.at + 1);
  if (found.kind === 'plain') {
    const clean = `${user}@${host}`;
    return { url: clean, display: clean, hadCredentials: true };
  }
  return { url, display: `${user}:***@${host}`, hadCredentials: true };
}

/** How many `@`s may end a password (the last one too): enough for any real address, and linear. */
const MAX_PASSWORD_ENDS = 16;

/**
 * The credentials an address may hold, as user name and password pairs (as written; the caller
 * masks their encoded and decoded forms too). More than a password may come back (a port and a
 * path), never less:
 * - the user info as the URL parser and as git read it: up to the last `@` in the authority (it
 *   ends at the first `/`, `?` or `#`, for the parser at a `\` too) that a host follows, the
 *   password after its first `:` (`https://u:x@y@host/o/r@v2.git` holds `x@y`). An
 *   http(s) user name without a password may be a token (`https://ghp_…@github.com/…`): it comes
 *   back with a null password;
 * - from the `:` that may start a password (the first one in a URL's authority, the one after the
 *   user name of an scp-like address) to each `@` that a host follows (the first 16 and the last),
 *   for the addresses the parser reads otherwise (a password holding `/`, `?`, `#` or `\`).
 * An ssh user name, alone, is no secret. Read in linear time.
 */
export function addressSecrets(raw: string, meter?: ScanMeter): { user: string; password: string | null }[] {
  const url = raw.trim();
  const r = new AddressReader(url, meter);
  const schemeEnd = r.scheme();
  const found: { user: string; password: string | null }[] = [];
  let colon: number;
  if (schemeEnd > 0) {
    const authorityEnd = authorityEndOf(r, schemeEnd);
    // As the parser reads the user info, and as git does (it ends it at `/`, `?` or `#` only).
    for (const end of new Set([authorityEnd, r.next('/?#', schemeEnd)])) {
      const at = r.lastAt(schemeEnd - 1, end);
      if (at < 0 || !startsHost(url[at + 1])) continue;
      const info = url.slice(schemeEnd, at);
      const split = info.indexOf(':');
      if (split >= 0) found.push({ user: info.slice(0, split), password: info.slice(split + 1) });
      else if (/^https?:/i.test(url) && info) found.push({ user: info, password: null });
    }
    colon = r.next(':', schemeEnd);
    if (colon >= authorityEnd) return found;
  } else {
    const scp = scpCredentials(r);
    if (!scp) return found;
    colon = scp.userEnd;
  }
  const ats: number[] = [];
  let last = -1;
  for (let at = url.indexOf('@', colon + 1); at >= 0; at = url.indexOf('@', at + 1))
    if (startsHost(url[at + 1])) {
      if (ats.length < MAX_PASSWORD_ENDS) ats.push(at);
      last = at;
    }
  if (last >= 0 && !ats.includes(last)) ats.push(last);
  const user = url.slice(schemeEnd, colon);
  for (const at of ats) found.push({ user, password: url.slice(colon + 1, at) });
  // The scan for `@`s, and each password taken (at most MAX_PASSWORD_ENDS + 1 of them).
  if (meter) meter.steps += url.length - colon + ats.reduce((sum, at) => sum + at - colon, 0);
  return found;
}

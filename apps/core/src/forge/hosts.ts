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
 * An scp-like address that may hold `user:secret@` before its first `/`: up to the last such `@`
 * (`$1` is the user).
 */
const SCP_CREDENTIALS = /^([^/@:[]*):[^/]*@/;
/**
 * The one scp-like form read as credentials without doubt: `user:secret@host:path`, with a single
 * `@` before the first `/` and a host (or `[v6]`) and its `:` right after it.
 */
const SCP_PLAIN_CREDENTIALS = /^([^/@:[]*):[^/@]*@(?=(?:[^/@:[\]]+|\[[^\]/@]*\]):[^/@]*(?:\/|$))/;
/**
 * `user:secret@host:path` or `user:secret@host/path` whose user name holds an `@`
 * (`me@corp.com:secret@host:o/r`): up to the last `@` before the first `/` that a host and its `:`
 * or `/` (or the end) follow. Git itself reads such an address as the host `corp.com`, so it is never
 * rewritten, only masked. The user name runs to the first `:` (one split, no backtracking over its
 * `@`s), so a long address is read in linear time.
 */
const SCP_AT_USER_CREDENTIALS = /^(?=[^/:[]*@)([^/:[]*):[^/]*@(?=(?:[^/@:[\]]+|\[[^\]/@]*\])(?:[:/]|$))/;

/**
 * A remote URL as core may store, compare and quote it.
 * - `url`: an http(s) URL without user info, query or fragment; an ssh URL without a password (its
 *   user name picks the key and stays); `user:secret@host:path` as `user@host:path`. An scp-like
 *   address that may or may not hold credentials (`host:a@x/y` is the path `a@x/y` on `host`, or the
 *   user `host` on `x`; `alice:p@ss:w@host:o`) comes back as it was, so two such remotes never
 *   compare equal.
 * - `display`: `url`, except that such an ambiguous address shows `user:***@` in place of what may
 *   be a secret. Anything shown to a person or written to a log uses this.
 * - `hadCredentials`: something was removed, or may be a secret.
 * A clean URL comes back exactly as it was.
 */
export function remoteUrlForDisplay(raw: string): { url: string; display: string; hadCredentials: boolean } {
  const url = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const clean = (() => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // Not parseable: cut everything from `//` to the last `@`, and from `?` or `#` on.
        return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)\S*@/i, '$1').replace(/[?#].*$/s, '');
      }
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
    return { url: clean, display: clean, hadCredentials: clean !== url };
  }
  if (SCP_PLAIN_CREDENTIALS.test(url)) {
    const clean = url.replace(SCP_PLAIN_CREDENTIALS, '$1@');
    return { url: clean, display: clean, hadCredentials: true };
  }
  if (SCP_CREDENTIALS.test(url))
    return { url, display: url.replace(SCP_CREDENTIALS, '$1:***@'), hadCredentials: true };
  if (SCP_AT_USER_CREDENTIALS.test(url))
    return { url, display: url.replace(SCP_AT_USER_CREDENTIALS, '$1:***@'), hadCredentials: true };
  return { url, display: url, hadCredentials: false };
}

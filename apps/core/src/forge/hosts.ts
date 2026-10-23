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
  // SCP-style SSH: git@host:owner/repo.git
  return /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed)?.[1]?.toLowerCase() ?? null;
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
 * A remote URL as core may return or quote it: an http(s) URL without user info, query or
 * fragment; an ssh URL (or scp-like address) without a password (its user name picks the key and
 * stays). `hadCredentials`: something was removed. A clean URL comes back exactly as it was.
 */
export function remoteUrlForDisplay(raw: string): { url: string; hadCredentials: boolean } {
  const url = raw.trim();
  const clean = (() => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // Not parseable: cut anything between `//` and `@`, and from `?` or `#` on.
        return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1').replace(/[?#].*$/s, '');
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
    }
    // scp-like `user:password@host:path` (or a schemeless `user:token@host/path`): keep the user,
    // drop the password. Only when a host and its `:` or `/` follow the `@`: `host:repo@x` is the
    // path `repo@x` on `host`. The password runs to the last such `@` before any `/`, so no part of
    // one holding `@` or `:` is ever shown (an scp path holding `@x:` is then shown short), and an
    // IPv6 `[host]` is never read as a user.
    return url.replace(/^([^/@:[]*):[^/]*@(?=[^/@:]+[:/])/, '$1@');
  })();
  return { url: clean, hadCredentials: clean !== url };
}

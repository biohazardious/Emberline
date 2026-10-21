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

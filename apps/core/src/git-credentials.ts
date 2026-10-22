/**
 * A forge account's credentials for Emberline's own git over HTTP. They never leave core: core's
 * credential gateway (git-gateway/) adds them to requests under the account's server only, and nothing
 * credential-related is passed to ptyd, the runner or a PTY (agents run as the same user there).
 */
export interface GitHttpCredential {
  /** The account's server URL (`https://github.com`, `http://127.0.0.1:3000`, `https://example.com/gitea`). */
  serverUrl: string;
  /** Basic-auth user: `x-access-token` (GitHub), `oauth2` (GitLab), the account's username (Gitea). */
  username: string;
  token: string;
}

export function basicAuthValue(c: GitHttpCredential): string {
  return Buffer.from(`${c.username}:${c.token}`).toString('base64');
}

/** Same scheme, host and port as the server and a path at or below its path (by segment); never a URL with user info. */
export function urlUnderServer(raw: string | URL, serverUrl: string): boolean {
  let url: URL;
  let server: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw.trim()) : raw;
    server = new URL(serverUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.origin !== server.origin) return false;
  const base = server.pathname.replace(/\/+$/, '');
  return base === '' || url.pathname === base || url.pathname.startsWith(`${base}/`);
}

/** Replaces the token and its Basic value in any text that may reach a person, a log or an event. */
export function redactCredential(text: string, c: GitHttpCredential | null | undefined): string {
  if (!c) return text;
  let out = text;
  for (const secret of [basicAuthValue(c), c.token]) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

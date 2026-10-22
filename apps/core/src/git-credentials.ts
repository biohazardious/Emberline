/**
 * An account's credentials for one git process: an `http.<server>/.extraHeader` Authorization
 * header passed through GIT_CONFIG_COUNT variables (never argv, a URL, `.git/config` or the
 * runner home). git only sends it to URLs under the server, and redirects are not followed.
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

/** GIT_CONFIG_COUNT/KEY_n/VALUE_n: the header scoped to the server, no redirects, no helper. */
export function credentialGitEnv(c: GitHttpCredential): Record<string, string> {
  const entries: [string, string][] = [
    [`http.${c.serverUrl}/.extraHeader`, `Authorization: Basic ${basicAuthValue(c)}`],
    // A redirect (even to the same server) is never followed with the header.
    ['http.followRedirects', 'false'],
    ['credential.helper', ''],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** For a PTY (the import clone): also ignores the runner's global and system git config. */
export function credentialPtyEnv(c: GitHttpCredential): Record<string, string> {
  return {
    ...credentialGitEnv(c),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Replaces the token and its Basic value in git output or an error message. */
export function redactCredential(text: string, c: GitHttpCredential | null | undefined): string {
  if (!c) return text;
  let out = text;
  for (const secret of [basicAuthValue(c), c.token]) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

/** A failed credentialed git call: redacted output, and no request (its env holds the header). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/**
 * The gateway's requests to the forge. The Authorization header is built here, only for URLs under
 * the account's server (never with user info); a GET follows redirects only within the same origin
 * and the account's server path (a cross-origin or https→http redirect fails), a POST none; the
 * agents are core's own (Node's global agents may use an environment proxy, NODE_USE_ENV_PROXY);
 * an idle limit and the operation's signal bound every request. Bodies are streamed, never parsed.
 */
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { basicAuthValue, type GitHttpCredential, urlUnderServer } from '../git-credentials.js';

export type GitGatewayErrorCode =
  | 'url_refused'
  | 'redirect_refused'
  | 'auth_refused'
  | 'not_found'
  | 'http_status'
  | 'service_refused'
  | 'ref_refused'
  | 'too_large'
  | 'timeout'
  | 'network'
  | 'git_failed';

/** Every gateway failure: a plain sentence that never holds the token, a capability or a server's body. */
export class GitGatewayError extends Error {
  constructor(
    readonly code: GitGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitGatewayError';
  }
}

export function authorizationFor(url: URL, credential: GitHttpCredential): string | null {
  return urlUnderServer(url, credential.serverUrl) ? `Basic ${basicAuthValue(credential)}` : null;
}

export function redirectTarget(from: URL, location: string, credential: GitHttpCredential): URL | null {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return null;
  }
  if (next.username || next.password || next.origin !== from.origin) return null;
  return urlUnderServer(next, credential.serverUrl) ? next : null;
}

/** Created without proxyEnv: never Node's global agents. */
export class UpstreamAgents {
  readonly http = new http.Agent({ keepAlive: true });
  readonly https = new https.Agent({ keepAlive: true });
  destroy(): void {
    this.http.destroy();
    this.https.destroy();
  }
}

export interface UpstreamRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Readable;
  credential: GitHttpCredential;
  agents: UpstreamAgents;
  signal: AbortSignal;
  idleTimeoutMs: number;
  maxRedirects?: number;
}

const stopped = (url: URL) =>
  new GitGatewayError('timeout', `The git operation with ${url.host} ran out of time or was stopped.`);

function send(url: URL, r: UpstreamRequest, authorization: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (r.signal.aborted) return reject(stopped(url));
    const secure = url.protocol === 'https:';
    const req = (secure ? https : http).request(url, {
      method: r.method,
      headers: { ...r.headers, authorization },
      agent: secure ? r.agents.https : r.agents.http,
      signal: r.signal,
      timeout: r.idleTimeoutMs,
    });
    req.on('timeout', () => req.destroy(new GitGatewayError('timeout', `${url.host} stopped answering.`)));
    req.on('response', (res) => {
      res.setTimeout(r.idleTimeoutMs, () =>
        res.destroy(new GitGatewayError('timeout', `${url.host} stopped sending.`)),
      );
      resolve(res);
    });
    req.on('error', (error) => {
      if (error instanceof GitGatewayError) reject(error);
      else if (r.signal.aborted) reject(stopped(url));
      else
        reject(
          new GitGatewayError(
            'network',
            `Couldn't reach ${url.host} (${(error as NodeJS.ErrnoException).code ?? 'network error'}).`,
          ),
        );
    });
    if (r.body) {
      r.body.on('error', (error) => req.destroy(error));
      r.body.pipe(req); // pipe: the forge's pace sets ours (backpressure)
    } else {
      req.end();
    }
  });
}

/** One request to the forge; resolves with its response whatever the status. Refuses a URL outside the account's server before sending. */
export async function openUpstream(r: UpstreamRequest): Promise<http.IncomingMessage> {
  let url = r.url;
  for (let hop = 0; ; hop++) {
    const authorization = authorizationFor(url, r.credential);
    if (!authorization)
      throw new GitGatewayError(
        'url_refused',
        `Emberline uses this account only for repositories under ${r.credential.serverUrl}.`,
      );
    const res = await send(url, r, authorization);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume();
      const next = r.method === 'GET' ? redirectTarget(url, location, r.credential) : null;
      if (!next || hop >= (r.maxRedirects ?? 3)) {
        throw new GitGatewayError(
          'redirect_refused',
          `${url.host} redirected to another address; Emberline does not follow it with the account's token.`,
        );
      }
      url = next;
      continue;
    }
    return res;
  }
}

/**
 * Core's HTTP client for isomorphic-git (git's smart HTTP protocol), carrying one forge account's
 * credentials. Requests go only to the repository URL Emberline chose (never a proxy, never a URL
 * from repository config); the Authorization header is built here, only for URLs under the
 * account's server, and any header isomorphic-git or a URL brings is dropped; redirects are
 * followed only within the same origin and server path (a cross-origin or https→http redirect
 * fails); the agents are its own (never Node's global agents, which may use an environment proxy);
 * an idle and a total time limit and caps on what is sent and received bound every operation.
 */
import http from 'node:http';
import https from 'node:https';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { basicAuthValue, type GitHttpCredential, urlUnderServer } from '../git-credentials.js';

const MB = 1024 * 1024;

export type GitTransportErrorCode =
  | 'url_refused'
  | 'redirect_refused'
  | 'auth_refused'
  | 'not_found'
  | 'http_status'
  | 'timeout'
  | 'network'
  | 'too_large'
  | 'unsafe_repo'
  | 'unsupported'
  | 'rejected'
  | 'push_refused'
  | 'protocol';

/** Every transport failure: a plain sentence that never holds the token or a server's body. */
export class GitTransportError extends Error {
  constructor(
    readonly code: GitTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitTransportError';
  }
}

export interface GitHttpLimits {
  /** No byte from the server for this long ends the request. */
  idleTimeoutMs: number;
  /** The whole operation: every request of one ls-remote, fetch or push. */
  totalTimeoutMs: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  maxRedirects: number;
}

export const DEFAULT_GIT_HTTP_LIMITS: GitHttpLimits = {
  idleTimeoutMs: 15_000,
  totalTimeoutMs: 120_000,
  maxResponseBytes: 512 * MB,
  maxRequestBytes: 512 * MB,
  maxRedirects: 3,
};

/** Never passed on from isomorphic-git: credentials are Emberline's to add, framing is Node's. */
const DROPPED = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

/** The Authorization value for one request URL: only under the account's server, never with user info. */
export function authorizationFor(url: URL, credential: GitHttpCredential): string | null {
  return urlUnderServer(url, credential.serverUrl) ? `Basic ${basicAuthValue(credential)}` : null;
}

/** Where a redirect may lead: same scheme, host and port, still under the account's server; else null. */
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

async function collectBody(body: GitHttpRequest['body'], max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  // isomorphic-git passes arrays of Uint8Array as well as async iterators.
  for await (const chunk of body as AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    size += chunk.length;
    if (size > max)
      throw new GitTransportError(
        'too_large',
        `What Emberline would send is larger than ${Math.round(max / MB)} MB.`,
      );
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

export interface GitHttpClient extends HttpClient {
  close(): void;
}

export function createGitHttp(options: {
  remoteUrl: string;
  credential: GitHttpCredential;
  limits?: Partial<GitHttpLimits>;
  signal?: AbortSignal;
}): GitHttpClient {
  const limits = { ...DEFAULT_GIT_HTTP_LIMITS, ...options.limits };
  const { credential } = options;
  let base: URL;
  try {
    base = new URL(options.remoteUrl);
  } catch {
    throw new GitTransportError('url_refused', 'The repository URL does not parse.');
  }
  if (!urlUnderServer(base, credential.serverUrl)) {
    throw new GitTransportError(
      'url_refused',
      `Emberline uses this account only for repositories under ${credential.serverUrl}.`,
    );
  }
  const host = base.host;
  const deadline = AbortSignal.timeout(limits.totalTimeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const stopped = () =>
    options.signal?.aborted
      ? new GitTransportError('network', 'Cancelled.')
      : new GitTransportError(
          'timeout',
          `${host} did not finish within ${Math.round(limits.totalTimeoutMs / 1000)} s.`,
        );
  // Own agents, created without proxyEnv: Node's global agents may use HTTP(S)_PROXY (NODE_USE_ENV_PROXY).
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });

  /** The idle-limit error of a response whose socket went quiet (its body then breaks off). */
  const idleOf = new WeakMap<http.IncomingMessage, () => GitTransportError | null>();
  const send = (url: URL, method: string, headers: Record<string, string>, body: Buffer) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      if (signal.aborted) return reject(stopped());
      const secure = url.protocol === 'https:';
      const req = (secure ? https : http).request(url, {
        method,
        headers:
          method === 'GET' || method === 'HEAD'
            ? headers
            : { ...headers, 'content-length': String(body.length) },
        agent: secure ? httpsAgent : httpAgent,
        signal,
        timeout: limits.idleTimeoutMs,
      });
      let idle: GitTransportError | null = null;
      req.on('timeout', () => {
        idle = new GitTransportError('timeout', `${url.host} stopped answering.`);
        req.destroy(idle);
      });
      req.on('response', (res) => {
        idleOf.set(res, () => idle);
        resolve(res);
      });
      req.on('error', (error) => {
        if (error instanceof GitTransportError) reject(error);
        else if (signal.aborted) reject(stopped());
        else
          reject(
            new GitTransportError(
              'network',
              `Couldn't reach ${url.host} (${(error as NodeJS.ErrnoException).code ?? 'network error'}).`,
            ),
          );
      });
      req.end(method === 'GET' || method === 'HEAD' ? undefined : body);
    });

  const readCapped = async (res: http.IncomingMessage): Promise<Buffer[]> => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > limits.maxResponseBytes) {
          res.destroy();
          throw new GitTransportError(
            'too_large',
            `${host} sent more than ${Math.round(limits.maxResponseBytes / MB)} MB; Emberline stops there.`,
          );
        }
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      if (error instanceof GitTransportError) throw error;
      const stalled = idleOf.get(res)?.();
      if (stalled) throw stalled;
      throw signal.aborted
        ? stopped()
        : new GitTransportError('network', `The connection to ${host} broke off.`);
    }
    return chunks;
  };

  const request = async (req: GitHttpRequest): Promise<GitHttpResponse> => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new GitTransportError('url_refused', 'isomorphic-git asked for a URL that does not parse.');
    }
    // The repository URL itself is the base: same origin, at or below its path by segment.
    if (!urlUnderServer(url, base.href)) {
      throw new GitTransportError(
        'url_refused',
        `Emberline sends this account's requests only to ${base.origin}${base.pathname}.`,
      );
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const body = await collectBody(req.body, limits.maxRequestBytes);
    const passed: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers ?? {}))
      if (!DROPPED.has(key.toLowerCase())) passed[key] = value;
    for (let hop = 0; ; hop++) {
      const auth = authorizationFor(url, credential);
      const res = await send(url, method, auth ? { ...passed, authorization: auth } : passed, body);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        const next = redirectTarget(url, location, credential);
        if (!next || hop >= limits.maxRedirects) {
          throw new GitTransportError(
            'redirect_refused',
            `${host} redirected to another address; Emberline does not follow it with the account's token.`,
          );
        }
        url = next;
        continue;
      }
      const chunks = await readCapped(res);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      return {
        url: url.href,
        method,
        statusCode: status,
        statusMessage: res.statusMessage ?? '',
        headers,
        body: (async function* () {
          yield* chunks;
        })(),
      };
    }
  };

  return {
    request,
    close: () => {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

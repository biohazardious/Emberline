/**
 * Credential gateway (spec §2 revision 2). The runner's git, which holds no credentials, talks smart
 * HTTP to `/api/internal/git/<capability>/…`; core adds the account's Basic header and streams both
 * bodies to and from the one repository the capability names. A capability is 256 random bits for one
 * git command:
 * - it is bound to project, account, upstream URL, service and, for a push, ref and commit;
 * - it must be used within `firstUseMs`, ends after `operationMs`, and is released when the command
 *   ends; a receive-pack capability carries one push (git's lone-flush auth probe before it is answered here);
 * - it is accepted only from the runner's address.
 * Its value is never logged: the routes log nothing, errors redact it. Core never parses git objects;
 * it reads only the receive-pack command list (receive-pack.ts).
 */
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { pipeline, Readable, Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContainerAddresses } from '../auth/container-addresses.js';
import { HttpError } from '../errors.js';
import { type GitHttpCredential, redactCredential, urlUnderServer } from '../git-credentials.js';
import { PUSH_PROBE, type PushPlan, readPushRequest } from './receive-pack.js';
import { GitGatewayError, type GitGatewayErrorCode, openUpstream, UpstreamAgents } from './upstream.js';

export type GitService = 'git-upload-pack' | 'git-receive-pack';
export interface GatewayGrant {
  projectId: string;
  upstreamUrl: string;
  credential: GitHttpCredential;
  service: GitService;
  push?: PushPlan;
  firstUseMs?: number;
  operationMs?: number;
}
export interface GatewayOutcome {
  code: GitGatewayErrorCode;
  message: string;
}

interface Capability extends GatewayGrant {
  firstUseMs: number;
  operationMs: number;
  createdAt: number;
  usedAt: number | null;
  requests: number;
  pushSent: boolean;
  bytes: number;
  controller: AbortController;
  outcome: GatewayOutcome | null;
}

const MINUTE = 60_000;
const GB = 1024 ** 3;
const MAX_REQUESTS = 100;
export const CAPABILITY_ROUTE_PREFIX = '/api/internal/git/';
const PASSED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma', 'content-encoding'];

export function redactCapabilityUrls(text: string): string {
  return text.replace(/\/api\/internal\/git\/[A-Za-z0-9_-]{20,}/g, '/api/internal/git/[capability]');
}

/** One plain line for a gateway, core or runner-git failure: no token, no capability. */
export function describeGitError(error: unknown, credential?: GitHttpCredential | null): string {
  let text: string;
  if (error instanceof GitGatewayError || error instanceof HttpError) text = error.message;
  else {
    const stderr = (error as { stderr?: unknown }).stderr;
    const raw =
      typeof stderr === 'string' && stderr.trim()
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error);
    text =
      raw
        .split('\n')
        .map((l) => l.replace(/^(fatal|error|remote): /, '').trim())
        .find(Boolean) ?? 'git failed';
  }
  return redactCapabilityUrls(redactCredential(text, credential)).slice(0, 300);
}

const sizeText = (bytes: number) =>
  bytes >= GB
    ? `${Math.round(bytes / GB)} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${bytes} bytes`;

const plain = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).type('text/plain; charset=utf-8').send(`${message}\n`);

type GitRequest = FastifyRequest<{ Params: { capability: string }; Querystring: { service?: string } }>;

export class GitGateway {
  baseUrl: string;
  private readonly caps = new Map<string, Capability>();
  private readonly clones = new Map<
    string,
    { capability: string; ended: boolean; outcome: GatewayOutcome | null }
  >();
  private readonly agents = new UpstreamAgents();
  private addresses: ContainerAddresses | null = null;
  private readonly maxBytes: number;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly options: {
      baseUrl: string;
      runnerHosts: string[];
      maxBytes?: number;
      idleTimeoutMs?: number;
      lookup?: (host: string) => Promise<string[]>;
    },
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.maxBytes = options.maxBytes ?? 4 * GB;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 2 * MINUTE;
  }

  get size(): number {
    return this.caps.size;
  }

  issue(grant: GatewayGrant): { capability: string; url: string } {
    if (!urlUnderServer(grant.upstreamUrl, grant.credential.serverUrl)) {
      throw new GitGatewayError(
        'url_refused',
        `Emberline uses this account only for repositories under ${grant.credential.serverUrl}.`,
      );
    }
    if ((grant.service === 'git-receive-pack') !== Boolean(grant.push))
      throw new Error('a push capability needs a push plan, and only it');
    this.sweep();
    const capability = randomBytes(32).toString('base64url');
    this.caps.set(capability, {
      ...grant,
      firstUseMs: grant.firstUseMs ?? 2 * MINUTE,
      operationMs: grant.operationMs ?? 10 * MINUTE,
      createdAt: Date.now(),
      usedAt: null,
      requests: 0,
      pushSent: false,
      bytes: 0,
      controller: new AbortController(),
      outcome: null,
    });
    return { capability, url: `${this.baseUrl}${CAPABILITY_ROUTE_PREFIX}${capability}` };
  }

  /** The git command ended: the capability stops working. Returns why core refused or the forge failed, if it did. */
  release(capability: string): GatewayOutcome | null {
    const cap = this.caps.get(capability);
    if (!cap) return null;
    cap.controller.abort();
    this.caps.delete(capability);
    return cap.outcome;
  }

  /** One runner git command with a fresh capability, released when it ends; failures become one plain GitGatewayError. */
  async run<T>(grant: GatewayGrant, command: (url: string) => Promise<T>): Promise<T> {
    const { capability, url } = this.issue(grant);
    try {
      return await command(url);
    } catch (error) {
      const outcome = this.caps.get(capability)?.outcome;
      throw outcome
        ? new GitGatewayError(outcome.code, outcome.message)
        : new GitGatewayError('git_failed', describeGitError(error, grant.credential));
    } finally {
      this.release(capability);
    }
  }

  trackClone(projectId: string, capability: string): void {
    this.clones.set(projectId, { capability, ended: false, outcome: null });
  }

  /** The import clone's PTY ended: release its capability (first call only); the outcome stays for the tail. */
  endClone(projectId: string): { first: boolean; outcome: GatewayOutcome | null } | null {
    const clone = this.clones.get(projectId);
    if (!clone) return null;
    if (clone.ended) return { first: false, outcome: clone.outcome };
    clone.ended = true;
    clone.outcome = this.release(clone.capability);
    return { first: true, outcome: clone.outcome };
  }

  forgetClone(projectId: string): void {
    const clone = this.clones.get(projectId);
    if (clone) this.release(clone.capability);
    this.clones.delete(projectId);
  }

  register(app: FastifyInstance): void {
    void app.register(async (scope) => {
      // Smart HTTP bodies stay streams: nothing buffers or parses them here.
      scope.addContentTypeParser(
        ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
        (_request, payload, done) => done(null, payload),
      );
      // The path holds the capability: these routes log nothing.
      const options = { logLevel: 'silent' as const };
      scope.get(`${CAPABILITY_ROUTE_PREFIX}:capability/info/refs`, options, (request, reply) =>
        this.handle(request as GitRequest, reply, 'advertise'),
      );
      scope.post(`${CAPABILITY_ROUTE_PREFIX}:capability/git-upload-pack`, options, (request, reply) =>
        this.handle(request as GitRequest, reply, 'git-upload-pack'),
      );
      scope.post(`${CAPABILITY_ROUTE_PREFIX}:capability/git-receive-pack`, options, (request, reply) =>
        this.handle(request as GitRequest, reply, 'git-receive-pack'),
      );
      // Any other path or method under the prefix (dumb HTTP, a typo): the same 404, and no request log with its URL.
      scope.all(`${CAPABILITY_ROUTE_PREFIX}*`, options, (_request, reply) =>
        plain(reply, 404, 'No such git operation (it ended or expired).'),
      );
    });
  }

  dispose(): void {
    for (const capability of [...this.caps.keys()]) this.release(capability);
    this.clones.clear();
    this.addresses?.stop();
    this.agents.destroy();
  }

  private sweep(): void {
    for (const capability of [...this.caps.keys()]) this.live(capability);
  }

  /** The capability if it may still be used; an expired one is released. */
  private live(capability: string): Capability | null {
    const cap = this.caps.get(capability);
    if (!cap) return null;
    const now = Date.now();
    if (
      now > cap.createdAt + cap.operationMs ||
      (cap.usedAt === null && now > cap.createdAt + cap.firstUseMs)
    ) {
      this.release(capability);
      return null;
    }
    return cap;
  }

  private fromRunner(ip: string | undefined): Promise<boolean> {
    this.addresses ??= new ContainerAddresses(this.options.runnerHosts, { lookup: this.options.lookup });
    return this.addresses.has(ip);
  }

  private refuse(
    cap: Capability,
    reply: FastifyReply,
    status: number,
    code: GitGatewayErrorCode,
    message: string,
  ) {
    cap.outcome ??= { code, message };
    return plain(reply, status, message);
  }

  /** Counts bytes in both directions against the operation's cap. */
  private meter(cap: Capability, source: Readable): Readable {
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        cap.bytes += chunk.length;
        if (cap.bytes > this.maxBytes) {
          const message = `This git operation moved more than ${sizeText(this.maxBytes)}; Emberline stopped it.`;
          cap.outcome ??= { code: 'too_large', message };
          done(new GitGatewayError('too_large', message));
          return;
        }
        done(null, chunk);
      },
    });
    return pipeline(source, counter, () => undefined);
  }

  private async handle(request: GitRequest, reply: FastifyReply, kind: 'advertise' | GitService) {
    if (!(await this.fromRunner(request.raw.socket.remoteAddress)))
      return plain(reply, 403, 'Only the runner may use the git gateway.');
    const cap = this.live(request.params.capability);
    // Unknown, used up and expired get the same answer.
    if (!cap) return plain(reply, 404, 'No such git operation (it ended or expired).');
    const service = kind === 'advertise' ? request.query.service : kind;
    if (service !== cap.service)
      return this.refuse(
        cap,
        reply,
        403,
        'service_refused',
        `This git operation may only use ${cap.service}.`,
      );
    // A POST body is git's own request, kept a stream by the parser above; anything else is refused.
    const contentType = request.headers['content-type'];
    if (
      kind !== 'advertise' &&
      !(request.body instanceof Readable && contentType === `application/x-${kind}-request`)
    )
      return this.refuse(cap, reply, 415, 'service_refused', 'This is not a git request.');
    if (++cap.requests > MAX_REQUESTS)
      return this.refuse(cap, reply, 429, 'service_refused', 'Too many requests for one git operation.');
    if (kind === 'git-receive-pack') {
      if (cap.pushSent) return this.refuse(cap, reply, 403, 'service_refused', 'This push was already sent.');
      cap.pushSent = true;
    }
    cap.usedAt ??= Date.now();
    const signal = AbortSignal.any([
      cap.controller.signal,
      AbortSignal.timeout(Math.max(1, cap.createdAt + cap.operationMs - Date.now())),
    ]);
    const agent = request.headers['user-agent'];
    const headers: Record<string, string> = {
      'user-agent':
        typeof agent === 'string' && agent.startsWith('git/') ? agent.slice(0, 200) : 'git/emberline',
    };
    const gitProtocol = request.headers['git-protocol'];
    // Protocol v2 only for upload-pack: receive-pack's command list must stay the v0 one core reads.
    if (cap.service === 'git-upload-pack' && typeof gitProtocol === 'string')
      headers['git-protocol'] = gitProtocol;
    let body: Readable | undefined;
    if (kind === 'advertise') {
      headers.accept = '*/*';
    } else {
      headers['content-type'] = `application/x-${kind}-request`;
      headers.accept = `application/x-${kind}-result`;
      const encoding = request.headers['content-encoding'];
      const source = request.body as Readable;
      if (kind === 'git-receive-pack') {
        if (encoding && encoding !== 'identity')
          return this.refuse(cap, reply, 403, 'ref_refused', 'A compressed push request is not accepted.');
        let pushed: Readable | typeof PUSH_PROBE;
        try {
          // Nothing reaches the forge before the command list passed.
          pushed = await readPushRequest(source, cap.push!);
        } catch (error) {
          const message =
            error instanceof GitGatewayError ? error.message : 'The push request could not be read.';
          return this.refuse(cap, reply, 403, 'ref_refused', message);
        }
        if (pushed === PUSH_PROBE) {
          // git's auth probe before a large push: answered here, nothing to send; the push follows.
          cap.pushSent = false;
          return reply
            .code(200)
            .header('cache-control', 'no-cache')
            .type('application/x-git-receive-pack-result')
            .send('');
        }
        body = this.meter(cap, pushed);
      } else {
        if (typeof encoding === 'string') headers['content-encoding'] = encoding;
        body = this.meter(cap, source);
      }
    }
    const upstream = new URL(
      `${cap.upstreamUrl.replace(/\/+$/, '')}/${kind === 'advertise' ? `info/refs?service=${cap.service}` : kind}`,
    );
    let res: http.IncomingMessage;
    try {
      res = await openUpstream({
        url: upstream,
        method: kind === 'advertise' ? 'GET' : 'POST',
        headers,
        body,
        credential: cap.credential,
        agents: this.agents,
        signal,
        idleTimeoutMs: this.idleTimeoutMs,
      });
    } catch (error) {
      const e =
        error instanceof GitGatewayError
          ? error
          : new GitGatewayError('network', `Couldn't reach ${upstream.host}.`);
      return this.refuse(cap, reply, 502, e.code, e.message);
    }
    const status = res.statusCode ?? 502;
    if (status === 401 || status === 403) {
      res.resume();
      // Never 401 to git: it would ask a credential helper or askPass from the repository's config.
      return this.refuse(
        cap,
        reply,
        403,
        'auth_refused',
        `The forge refused the account's token for ${upstream.host}.`,
      );
    }
    if (status === 404) {
      res.resume();
      return this.refuse(
        cap,
        reply,
        404,
        'not_found',
        `${upstream.host} has no repository at ${new URL(cap.upstreamUrl).pathname} that this account can see.`,
      );
    }
    if (status >= 300) {
      res.resume();
      return this.refuse(cap, reply, 502, 'http_status', `${upstream.host} answered HTTP ${status}.`);
    }
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = res.headers[name];
      if (typeof value === 'string') reply.header(name, value);
    }
    return reply.code(status).send(this.meter(cap, res));
  }
}

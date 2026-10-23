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
import http from 'node:http';
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
  /** Set when it ran out of time: it no longer works, but `release` still reports why. */
  expiredAt: number | null;
}

const MINUTE = 60_000;
const GB = 1024 ** 3;
const MAX_REQUESTS = 100;
/** How long an expired capability's outcome waits for its `release` before it is dropped. */
const EXPIRED_KEPT_MS = 10 * MINUTE;
const TIMED_OUT: GatewayOutcome = {
  code: 'timeout',
  message: 'This git operation ran out of time; Emberline stopped it.',
};
/** Every method Node parses (CONNECT never reaches a route): the ones git does not use get a silent 405. */
const OTHER_METHODS = http.METHODS.filter((m) => m !== 'CONNECT' && m !== 'GET' && m !== 'POST');
export const CAPABILITY_ROUTE_PREFIX = '/api/internal/git/';
const PASSED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma', 'content-encoding'];

export function redactCapabilityUrls(text: string): string {
  return text.replace(/\/api\/internal\/git\/[A-Za-z0-9_-]{20,}/g, '/api/internal/git/[capability]');
}

/**
 * A request URL as it may be logged. Git sends the gateway's own spelling, which its routes keep out
 * of the log (`logLevel: 'silent'`); any other spelling (`/API/…`, `/api//…`, `internal%2Fgit`)
 * misses those routes, so any capability-shaped run (20+ base64url characters) of a path naming `internal` and `git`
 * is redacted here, wherever the path puts it. Other URLs are returned as they are.
 */
export function requestUrlForLog(url: string): string {
  let decoded = url;
  for (let i = 0; i < 3; i++) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === decoded) break;
    decoded = next;
  }
  if (!/internal/i.test(decoded) || !/git/i.test(decoded)) return url;
  // Any capability-shaped run (base64url, 20+), wherever the path puts it.
  const redacted = decoded.replace(/[A-Za-z0-9_-]{20,}/g, '[capability]');
  return redacted === decoded ? url : redacted;
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
/** A character that ends the host of an `@host:`. */
const endsHost = (ch: string) =>
  ch === '/' || ch === '@' || ch === ':' || QUOTES.has(ch) || isSpace(ch.charCodeAt(0));

/**
 * Counts the characters a redaction handles (the linear-time test reads it).
 * Every pass over the text adds what it reads; a new pass that does not would hide from that test.
 */
export interface ScanMeter {
  steps: number;
}

/**
 * Text without the credentials of the addresses in it (a token typed into an origin, or one a
 * server quotes back). Better too much than a secret: an ssh user name, an `@` in a path or the
 * words between a password's whitespace and a later `@` on its line may go too.
 * - An address is a run of non-whitespace. One that may still be in its credentials (a `scheme://`
 *   without a path yet, a `user:` with something after it, or an `@` not followed by a path) runs
 *   on across whitespace, on the same line, through each next run holding an `@`, until one whose
 *   last `@` a path or a port follows. So a TAB, NBSP or other space in a password does not end it
 *   early.
 * - A run starting with a quote mark, or a `user:` with nothing after it (a password that starts
 *   with whitespace), runs on only to the next run holding an `@`, and only when that one is a
 *   whole address (a host and its path, `:path` or port after its last `@`) with no run that may
 *   start another address before it. After a `user:`, that address must have no user name or
 *   quote of its own (`fatal: 'secret@host:path'`: the quoted run is the address).
 * - Any `scheme://` (https, ssh, git+ssh, ssh+git, …, even glued to a word): everything from `://`
 *   to the last `@` of the address (a quote, `/` or `@` in a password never ends it early).
 * - scp-like `user:secret@host:path`: the secret, up to the last `@` before a host and its `:` (a
 *   user name may hold an `@`: `me@corp.com:secret@host:path`).
 * - git splits that address at its first `:` and quotes the rest as a path
 *   (`fatal: 'secret@host:path' does not appear to be a git repository`): the part before the `@`,
 *   after any quote mark (`'`, `"`, `‘`, `“`, `«`, …).
 * - without a host and its `:` after an `@` (`user:secret@host/path`, an origin set by hand): the
 *   secret, up to the last `@` before the first `/`; with none there (a `/` in the password), after a
 *   `user:` or a leading quote mark, up to the last `@` that a host and its `/` or `:` follow.
 * Linear whatever a server prints: every character is read a fixed number of times, and no pattern
 * backtracks.
 */
export function withoutUrlCredentials(text: string, meter?: ScanMeter): string {
  interface Run {
    start: number;
    end: number;
    /** It holds an `@`. */
    at: boolean;
    /** A path or a port follows its last `@` (`@host/…`, `@host:22`): an address that ends here. */
    ends: boolean;
    /** It may still be in an address's credentials. */
    opens: boolean;
    /**
     * It may start an address whose password starts with whitespace or holds a quote mark before
     * it: a `user:` with nothing after it, a lone quote mark, or a quoted word. It is joined only
     * with the next run holding an `@` when that one is a complete address (see `complete`).
     */
    weak: 'colon' | 'quote' | null;
    /** A host and its path, `:path` or port follow its last `@`: an address, read as a whole. */
    complete: boolean;
    /** It starts with a quote mark. */
    quoted: boolean;
    /** A `:` comes before its first `@` (`user:…@`): an address with its own user name. */
    userBeforeAt: boolean;
    /** A joined address never reaches it: a line break comes before it, or it starts another `scheme://`. */
    barrier: boolean;
  }
  const runs: Run[] = [];
  let lineBreak = false;
  for (let i = 0; i < text.length;) {
    if (isSpace(text.charCodeAt(i))) {
      if (text[i] === '\n') lineBreak = true;
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && !isSpace(text.charCodeAt(i))) i++;
    const run = text.slice(start, i);
    const at = run.lastIndexOf('@');
    const ends = at >= 0 && (run.indexOf('/', at) >= 0 || endsInPort(run, at));
    const scheme = run.indexOf('://');
    const opens = !ends && opensAddress(run, at, scheme);
    const colonAfterAt = at >= 0 ? run.indexOf(':', at) : -1;
    const complete = ends || (colonAfterAt >= 0 && colonAfterAt < run.length - 1);
    const quoted = QUOTES.has(run[0]!);
    runs.push({
      start,
      end: i,
      at: at >= 0,
      ends,
      opens,
      weak: opens || scheme >= 0 || complete ? null : weakStart(run, quoted),
      complete,
      quoted,
      userBeforeAt: at >= 0 && run.indexOf(':') >= 0 && run.indexOf(':') < run.indexOf('@'),
      barrier: lineBreak || scheme >= 0,
    });
    lineBreak = false;
    if (meter) meter.steps += run.length;
  }
  if (meter) meter.steps += text.length;
  const n = runs.length;
  // From run i on: the first run holding an `@`, the first that may start an address, and the
  // first a joined address never reaches.
  const nextAt = new Int32Array(n + 1).fill(n);
  const nextStart = new Int32Array(n + 1).fill(n);
  const bound = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    nextAt[i] = runs[i]!.at ? i : nextAt[i + 1]!;
    nextStart[i] = runs[i]!.opens || runs[i]!.weak ? i : nextStart[i + 1]!;
    bound[i] = i + 1 < n && runs[i + 1]!.barrier ? i + 1 : bound[i + 1]!;
  }
  if (meter) meter.steps += n;
  let out = '';
  let copied = 0;
  for (let i = 0; i < n;) {
    let last = i;
    const run = runs[i]!;
    if (run.opens) {
      let next = run.at ? i : nextAt[i + 1]!;
      while (next < bound[i]!) {
        last = next;
        if (runs[last]!.ends) break;
        next = nextAt[last + 1]!;
        if (meter) meter.steps++;
      }
    } else if (run.weak) {
      // Only up to the next address, with nothing that may start another one before it; after a
      // `user:`, one without a user name or quote of its own (`fatal: 'secret@host:path'`: the quoted
      // run is the address, not the word before it).
      const next = nextAt[i + 1]!;
      const target = runs[next];
      if (
        target &&
        next < bound[i]! &&
        nextStart[i + 1]! >= next &&
        target.complete &&
        (run.weak === 'quote' || (!target.quoted && !target.userBeforeAt))
      )
        last = next;
    }
    const { start } = runs[i]!;
    const { end } = runs[last]!;
    out += text.slice(copied, start) + withoutAddressCredentials(text.slice(start, end), meter);
    copied = end;
    i = last + 1;
  }
  return out + text.slice(copied);
}

/** `…@host:22`: the run ends in a port after its last `@`. */
function endsInPort(run: string, at: number): boolean {
  const colon = run.lastIndexOf(':');
  if (colon < at || colon === run.length - 1) return false;
  for (let i = colon + 1; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/** See `weak` in withoutUrlCredentials: a run starting with a quote mark, or a `user:` with nothing after it. */
function weakStart(run: string, quoted: boolean): 'colon' | 'quote' | null {
  if (quoted) return 'quote';
  const colon = run.indexOf(':');
  return colon > 0 && colon === run.length - 1 && !run.slice(0, colon).includes('/') ? 'colon' : null;
}

/**
 * A run that may still be in an address's credentials (the caller knows no path or port follows its
 * last `@`): a `scheme://` without a path yet (or with a `user:` before it that is no port), an `@`
 * after one, or a `user:` with something after it.
 */
function opensAddress(run: string, at: number, scheme: number): boolean {
  if (scheme >= 0) {
    if (at > scheme) return true;
    const rest = run.slice(scheme + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return true;
    const authority = rest.slice(0, slash);
    const colon = authority.lastIndexOf(':');
    if (colon < 0) return false;
    for (let i = colon + 1; i < authority.length; i++) {
      const c = authority.charCodeAt(i);
      if (c < 0x30 || c > 0x39) return true;
    }
    return false;
  }
  const colon = run.indexOf(':');
  return colon > 0 && colon < run.length - 1 && !run.slice(0, colon).includes('/');
}

/** One address (perhaps with whitespace in it) as `withoutUrlCredentials` masks it. */
function withoutAddressCredentials(address: string, meter?: ScanMeter): string {
  if (meter) meter.steps += address.length;
  let out = address;
  const scheme = out.indexOf('://');
  if (scheme >= 0) {
    const at = out.lastIndexOf('@');
    if (at > scheme) out = out.slice(0, scheme + 3) + out.slice(at + 1);
  }
  // Read from the end: the last `@` that a host and its `:` follow (`hostThenColon`: the characters
  // from i + 1 on are a host that a `:` ends), and the last one a host and its `/` or `:` follow.
  let hostAt = -1;
  let pathAt = -1;
  let hostThenColon = false;
  let hostThenPath = false;
  for (let i = out.length - 2; i >= 0 && hostAt < 0; i--) {
    const host = !endsHost(out[i + 1]!);
    hostThenColon = host && (out[i + 2] === ':' || hostThenColon);
    hostThenPath = host && (out[i + 2] === ':' || out[i + 2] === '/' || hostThenPath);
    if (out[i] === '@' && hostThenColon) hostAt = i;
    if (out[i] === '@' && hostThenPath && pathAt < 0) pathAt = i;
  }
  const colon = out.indexOf(':');
  const userOk = (end: number) => colon >= 0 && colon < end && !out.slice(0, colon).includes('/');
  if (hostAt < 0) {
    const slash = out.indexOf('/');
    hostAt = (slash < 0 ? out : out.slice(0, slash)).lastIndexOf('@');
    // `user:pa/ss@host/path`, or git's quoted `'pa/ss@host/path'`: a `/` in the password puts the
    // `@` after the first `/`.
    if (hostAt < 0 && pathAt >= 0 && (userOk(pathAt) || QUOTES.has(out[0]!))) hostAt = pathAt;
    if (hostAt < 0) return out;
  }
  const before = out.slice(0, hostAt);
  let quote = -1;
  for (let i = 0; i < before.length && quote < 0; i++) if (QUOTES.has(before[i]!)) quote = i;
  const userOk2 = userOk(hostAt);
  const from = Math.min(quote >= 0 ? quote + 1 : Infinity, userOk2 ? colon + 1 : Infinity);
  return from === Infinity ? out : `${out.slice(0, from)}***${out.slice(hostAt)}`;
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
  // A token typed into an origin (no account) is never quoted back.
  return redactCapabilityUrls(redactCredential(withoutUrlCredentials(text), credential)).slice(0, 300);
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
      /** Core's own networks (tests); see ContainerAddressesOptions.localNetworks. */
      localNetworks?: () => string[];
      /** EMBERLINE_CONTAINER_NETWORKS. */
      containerNetworks?: readonly string[];
    },
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.maxBytes = options.maxBytes ?? 4 * GB;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 2 * MINUTE;
  }

  get size(): number {
    let live = 0;
    for (const cap of this.caps.values()) if (cap.expiredAt === null) live++;
    return live;
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
      expiredAt: null,
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
    // Held here: the outcome stays readable even if the capability expires while git runs.
    const record = this.caps.get(capability)!;
    try {
      return await command(url);
    } catch (error) {
      const outcome = record.outcome;
      throw outcome
        ? new GitGatewayError(outcome.code, outcome.message)
        : new GitGatewayError('git_failed', describeGitError(error, grant.credential), { cause: error });
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
    // Methods Fastify does not route by default (PROPFIND, MKCOL, …) would reach its logged 404.
    for (const method of OTHER_METHODS) {
      if (!app.supportedMethods.includes(method)) app.addHttpMethod(method);
    }
    void app.register(async (scope) => {
      // Smart HTTP bodies stay streams: nothing buffers or parses them here.
      scope.addContentTypeParser(
        ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
        (_request, payload, done) => done(null, payload),
      );
      // The path holds the capability: these routes log nothing. HEAD is never sent on to the forge.
      const options = { logLevel: 'silent' as const, exposeHeadRoute: false };
      scope.get(`${CAPABILITY_ROUTE_PREFIX}:capability/info/refs`, options, (request, reply) =>
        this.handle(request as GitRequest, reply, 'advertise'),
      );
      scope.post(`${CAPABILITY_ROUTE_PREFIX}:capability/git-upload-pack`, options, (request, reply) =>
        this.handle(request as GitRequest, reply, 'git-upload-pack'),
      );
      scope.post(`${CAPABILITY_ROUTE_PREFIX}:capability/git-receive-pack`, options, (request, reply) =>
        this.handle(request as GitRequest, reply, 'git-receive-pack'),
      );
      // Any other path (dumb HTTP, a typo): the same 404; any other method: 405. No request log with the URL.
      scope.route({
        ...options,
        method: ['GET', 'POST'],
        url: `${CAPABILITY_ROUTE_PREFIX}*`,
        handler: (_request, reply) => plain(reply, 404, 'No such git operation (it ended or expired).'),
      });
      scope.route({
        ...options,
        method: OTHER_METHODS,
        url: `${CAPABILITY_ROUTE_PREFIX}*`,
        handler: (_request, reply) =>
          plain(reply.header('allow', 'GET, POST'), 405, 'The git gateway answers only GET and POST.'),
      });
    });
  }

  dispose(): void {
    for (const capability of [...this.caps.keys()]) this.release(capability);
    this.clones.clear();
    this.addresses?.stop();
    this.agents.destroy();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [capability, cap] of [...this.caps]) {
      if (cap.expiredAt !== null && now > cap.expiredAt + EXPIRED_KEPT_MS) this.caps.delete(capability);
      else this.live(capability);
    }
  }

  /** The capability if it may still be used. One past its time stops working and keeps why until released. */
  private live(capability: string): Capability | null {
    const cap = this.caps.get(capability);
    if (!cap || cap.expiredAt !== null) return null;
    const now = Date.now();
    if (
      now > cap.createdAt + cap.operationMs ||
      (cap.usedAt === null && now > cap.createdAt + cap.firstUseMs)
    ) {
      cap.expiredAt = now;
      cap.outcome ??= TIMED_OUT;
      cap.controller.abort();
      return null;
    }
    return cap;
  }

  private fromRunner(ip: string | undefined): Promise<boolean> {
    this.addresses ??= new ContainerAddresses(this.options.runnerHosts, {
      lookup: this.options.lookup,
      localNetworks: this.options.localNetworks,
      containerNetworks: this.options.containerNetworks,
    });
    // A miss resolves the runner's name again (rate-limited): a runner restart must not lock git out for a minute.
    return this.addresses.hasOrRefresh(ip);
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
    // Out of time (not released): say so, whatever the stream it cut says.
    signal.addEventListener('abort', () => {
      if (!cap.controller.signal.aborted) cap.outcome ??= TIMED_OUT;
    });
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
          // Nothing reaches the forge before the command list passed; a list that does not come in
          // the idle limit, or a release, ends the wait.
          pushed = await readPushRequest(
            source,
            cap.push!,
            AbortSignal.any([signal, AbortSignal.timeout(this.idleTimeoutMs)]),
          );
        } catch (error) {
          const message =
            error instanceof GitGatewayError ? error.message : 'The push request could not be read.';
          // The rest of the body is not read: close the connection after the answer.
          reply.header('connection', 'close');
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

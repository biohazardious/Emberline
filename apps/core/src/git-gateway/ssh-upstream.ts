/**
 * The gateway's ssh upstream (spec Part 2, "How git uses them"). Core itself opens the SSH
 * connection to the forge (ssh2: nothing ssh runs in the runner or ops), logs in with Emberline's
 * key and runs `git-upload-pack '<path>'` or `git-receive-pack '<path>'`. Smart HTTP's stateless
 * requests become sessions, answered as git http-backend would:
 * - info/refs → a session's advertisement, up to its flush: in v0 after the `# service=…` line and a
 *   flush; in v2 (GIT_PROTOCOL=version=2 asked, and the server answered `version 2`) as it is;
 * - a POST → a new session: its advertisement read and dropped, the request body written, the
 *   server's output streamed back until it ends.
 * The host key is checked before anything is sent (`hostKey`); for a host:port with known keys only
 * their types are offered (Ruling 16). The operation's signal, an idle limit and a handshake limit
 * bound every connection. The private key stays in memory; no message holds it, a capability or a
 * server's own text.
 */
import { Readable } from 'node:stream';
import { Client, type ClientChannel, type ServerHostKeyAlgorithm } from 'ssh2';
import { normaliseSshHost } from '../ssh-keys/known-hosts.js';
import type { GitService } from './gateway.js';
import { GitGatewayError, type HostKeyDetails } from './upstream.js';

export interface SshRemote {
  /** The login (`git` when the address names none: what every forge expects). */
  user: string;
  /** As the host normaliser reads it. */
  host: string;
  port: number;
  /** The path git sends: `/srv/app.git` for ssh://host/srv/app.git, `~me/app.git`, `owner/app.git` for scp-like. */
  path: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/**
 * An ssh repository address as git reads it (`ssh://[user@]host[:port]/path`, percent-decoded, a
 * `/~` path relative to a home; scp-like `[user@]host:path` as written), or null for anything else:
 * another scheme, a password, an IPv6 literal or a host the normaliser refuses, an empty path,
 * control characters, a login that could read as an option.
 */
export function parseSshRemote(raw: string): SshRemote | null {
  const url = raw.trim();
  if (CONTROL.test(url)) return null;
  let user: string | null;
  let host: string;
  let port = 22;
  let path: string;
  if (/^ssh:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
      user = parsed.username ? decodeURIComponent(parsed.username) : null;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    if (parsed.password || parsed.search || parsed.hash) return null;
    host = parsed.hostname;
    if (parsed.port) port = Number(parsed.port);
    if (path.startsWith('/~')) path = path.slice(1);
  } else {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
    // git's own rule: a `/` before the first `:` makes it a local path.
    const m = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/.exec(url);
    if (!m) return null;
    user = m[1] ?? null;
    host = m[2]!;
    path = m[3]!;
  }
  const name = normaliseSshHost(host);
  if (name === null || !/^[a-z0-9._-]+$/.test(name) || name.startsWith('-')) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (user !== null && !USER.test(user)) return null;
  if (!path || path === '/' || CONTROL.test(path)) return null;
  return { user: user ?? 'git', host: name, port, path };
}

/** The remote as a message names it: `host`, or `host:port` off port 22. */
export const sshWhere = (r: { host: string; port: number }) =>
  r.port === 22 ? r.host : `${r.host}:${r.port}`;

/** A path quoted for the server's shell as git quotes it (sq_quote_buf). */
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`).replace(/!/g, `'\\!'`)}'`;

/** The type a host key blob names in its first string (`ssh-rsa` whatever signature it was negotiated for). */
export function blobKeyType(blob: Buffer): string {
  if (blob.length < 4) return '';
  const length = blob.readUInt32BE(0);
  return length > 0 && length <= 64 && blob.length >= 4 + length
    ? blob.toString('latin1', 4, 4 + length)
    : '';
}

/** The signature algorithms a host key type can be negotiated as, in ssh2's preference order. */
const ALGORITHMS: Record<string, string[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

/**
 * The host key algorithms to offer for the key types known for a host (Ruling 16), or undefined
 * (ssh2's defaults) for a host nothing is known for, or whose known types ssh2 cannot use: the host
 * key check then answers `changed` for whatever key the server shows.
 */
export function hostKeyAlgorithms(types: readonly string[]): string[] | undefined {
  const algorithms = [...new Set(types.flatMap((type) => ALGORITHMS[type] ?? []))];
  return algorithms.length > 0 ? algorithms : undefined;
}

export interface SshUpstreamRequest {
  url: string;
  /** The OpenSSH private key, in memory only. */
  privateKey: string;
  service: GitService;
  /** A POST's request body (decompressed, push-checked); none for info/refs. */
  body?: Readable;
  /** Ask for protocol v2 (`GIT_PROTOCOL=version=2`): upload-pack, when the client asked for it. */
  protocolV2: boolean;
  signal: AbortSignal;
  idleTimeoutMs: number;
  /** The key types known for the remote's host:port (pinned, else trusted); empty when none. */
  hostKeyTypes: readonly string[];
  /** The host key check, before anything is sent: `ok`, or the error the connection fails with. */
  hostKey: (info: Omit<HostKeyDetails, 'fingerprint'>) => 'ok' | GitGatewayError;
  /** Where a person sees the public key of the key used (for the refused-key message). */
  keyShownIn: string;
  readyTimeoutMs?: number;
}

export interface SshUpstreamResponse {
  contentType: string;
  body: Readable;
}

const FLUSH = Buffer.from('0000');
const pktLine = (text: string) => Buffer.from(`${(text.length + 4).toString(16).padStart(4, '0')}${text}`);
const BATCH_BYTES = 64 * 1024;

interface Pkt {
  raw: Buffer;
  /** 0000: the end of an advertisement or a section. */
  flush: boolean;
  payload: Buffer;
}

/** pkt-lines off the server's stdout; null at the end (or a line cut off by it). */
class PktReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(
    private readonly it: AsyncIterator<Buffer>,
    private readonly onData: () => void,
  ) {}

  private async more(): Promise<boolean> {
    const next = await this.read();
    if (next.done) return false;
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, next.value]) : next.value;
    return true;
  }

  async next(): Promise<Pkt | null> {
    while (this.buf.length < 4) if (!(await this.more())) return null;
    const hex = this.buf.toString('latin1', 0, 4);
    if (!/^[0-9a-f]{4}$/i.test(hex))
      throw new GitGatewayError('network', 'The server did not answer in git’s protocol.');
    const length = Number.parseInt(hex, 16);
    // 0000 flush, 0001 delim, 0002 response end: four bytes, no payload.
    const size = length < 4 ? 4 : length;
    while (this.buf.length < size) if (!(await this.more())) return null;
    const raw = this.buf.subarray(0, size);
    this.buf = this.buf.subarray(size);
    return { raw, flush: length === 0, payload: raw.subarray(4) };
  }

  /** What was read past the last pkt-line. */
  rest(): Buffer {
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }

  async read(): Promise<IteratorResult<Buffer>> {
    const next = await this.it.next();
    if (!next.done) this.onData();
    return next;
  }
}

type SshError = Error & { level?: string; code?: string };

/** One SSH connection with one git session: its failure (if any) is the one the operation reports. */
class Session {
  readonly conn = new Client();
  readonly where: string;
  failure: GitGatewayError | null = null;
  exit: { code: number | null; signal: string | null } | null = null;
  private hostKeyError: GitGatewayError | null = null;
  private idle: NodeJS.Timeout | undefined;
  private ended = false;
  private connClosed = false;
  private channelClosed = false;
  private readonly onAbort = () =>
    this.fail(
      new GitGatewayError('timeout', `The git operation with ${this.where} ran out of time or was stopped.`),
    );

  constructor(
    private readonly r: SshUpstreamRequest,
    private readonly remote: SshRemote,
  ) {
    this.where = sshWhere(remote);
    // Always listened to: an 'error' without a listener would end core.
    this.conn.on('error', (error: SshError) => this.fail(this.connectError(error)));
    this.conn.on('close', () => {
      this.connClosed = true;
    });
    r.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  /** Any data either way: the connection is not idle. */
  touch(): void {
    if (this.ended) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(
      () => this.fail(new GitGatewayError('timeout', `${this.where} stopped answering.`)),
      this.r.idleTimeoutMs,
    );
  }

  fail(error: GitGatewayError): void {
    this.failure ??= error;
    this.end(true);
  }

  end(destroy = false): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idle);
    this.r.signal.removeEventListener('abort', this.onAbort);
    if (destroy) this.conn.destroy();
    else this.conn.end();
  }

  private connectError(error: SshError): GitGatewayError {
    if (this.hostKeyError) return this.hostKeyError;
    switch (error.level) {
      case 'client-authentication':
        return new GitGatewayError(
          'auth_refused',
          `The server refused Emberline's SSH key: add the public key shown in ${this.r.keyShownIn} to the repository or account.`,
        );
      case 'client-timeout':
        return new GitGatewayError('timeout', `${this.where} did not answer the ssh connection in time.`);
      case 'client-dns':
        return new GitGatewayError('network', `Couldn't find ${this.remote.host}.`);
      case 'client-socket':
        return new GitGatewayError(
          'network',
          `Couldn't reach ${this.where} (${error.code ?? 'network error'}).`,
        );
    }
    if (/no matching host key/i.test(error.message)) {
      // Only the known key types were offered, and the server has none of them any more.
      return new GitGatewayError(
        'host_key_changed',
        `${this.where} no longer offers the host key Emberline knows for it, so Emberline did not connect. If the server's key really changed, remove the stored key in Settings → SSH key.`,
      );
    }
    return new GitGatewayError('network', `The ssh connection to ${this.where} failed.`);
  }

  private verify(blob: Buffer): boolean {
    try {
      const verdict = this.r.hostKey({
        host: this.remote.host,
        port: this.remote.port,
        keyType: blobKeyType(blob),
        key: blob.toString('base64'),
      });
      if (verdict === 'ok') return true;
      this.hostKeyError = verdict;
    } catch {
      this.hostKeyError = new GitGatewayError(
        'network',
        `Emberline could not check the host key of ${this.where}.`,
      );
    }
    return false;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = () =>
        reject(this.failure ?? new GitGatewayError('network', `${this.where} closed the connection.`));
      this.conn.once('ready', () => {
        this.conn.off('close', settle);
        resolve();
      });
      this.conn.once('close', settle);
      this.conn.on('error', settle);
      if (this.r.signal.aborted) {
        this.onAbort();
        return settle();
      }
      const serverHostKey = hostKeyAlgorithms(this.r.hostKeyTypes);
      try {
        this.conn.connect({
          host: this.remote.host,
          port: this.remote.port,
          username: this.remote.user,
          privateKey: this.r.privateKey,
          hostVerifier: (blob: Buffer) => this.verify(blob),
          readyTimeout: this.r.readyTimeoutMs ?? 20_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          tryKeyboard: false,
          ...(serverHostKey
            ? { algorithms: { serverHostKey: serverHostKey as ServerHostKeyAlgorithm[] } }
            : {}),
        });
      } catch {
        // ssh2 could not read the key: say so without its words (they may quote it).
        this.fail(new GitGatewayError('ssh_key_missing', 'Emberline could not read its SSH key.'));
        settle();
      }
    });
  }

  exec(command: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const closed = () =>
        reject(this.failure ?? new GitGatewayError('network', `${this.where} closed the connection.`));
      this.conn.once('close', closed);
      const env = this.r.protocolV2 ? { GIT_PROTOCOL: 'version=2' } : undefined;
      // From the request on: a server that never answers it runs into the idle limit too.
      this.touch();
      this.conn.exec(command, env ? { env } : {}, (error, channel) => {
        this.conn.off('close', closed);
        if (error) return reject(this.notFound());
        channel.on('exit', (code: number | null, signal?: string) => {
          this.exit = { code, signal: signal ?? null };
        });
        channel.on('close', () => {
          this.channelClosed = true;
        });
        // A write after the server closed: the read side reports what matters.
        channel.on('error', () => undefined);
        // Its own text is never shown; read so the server never waits on it.
        channel.stderr.on('data', () => this.touch());
        this.touch();
        resolve(channel);
      });
    });
  }

  notFound(): GitGatewayError {
    return (
      this.failure ??
      new GitGatewayError(
        'not_found',
        `${this.where} has no repository at ${this.remote.path} that Emberline's SSH key can reach.`,
      )
    );
  }

  /** The channel closed (or the connection did): why it failed, if it did. */
  async closed(channel: ClientChannel): Promise<GitGatewayError | null> {
    if (!this.ended && this.exit === null && !this.channelClosed && !this.connClosed)
      await new Promise<void>((resolve) => {
        channel.once('close', () => resolve());
        this.conn.once('close', () => resolve());
      });
    if (this.failure) return this.failure;
    if (this.exit === null) return new GitGatewayError('network', `The connection to ${this.where} dropped.`);
    if (this.exit.signal)
      return new GitGatewayError('network', `git on ${this.where} stopped (${this.exit.signal}).`);
    return null;
  }
}

/**
 * One smart HTTP request over ssh: resolves once the server's answer can start (its advertisement
 * began, or was read and dropped), so a refused key, a host key, a missing repository fail before
 * anything is sent back; then streams. The stream fails when the connection drops or runs out of
 * time; destroying it closes the connection.
 */
export async function openSshUpstream(r: SshUpstreamRequest): Promise<SshUpstreamResponse> {
  const remote = parseSshRemote(r.url);
  if (!remote)
    throw new GitGatewayError(
      'url_refused',
      'Emberline reaches a repository over ssh only at an ssh address.',
    );
  const session = new Session(r, remote);
  let channel: ClientChannel;
  let reader: PktReader;
  let first: Pkt | null;
  try {
    await session.connect();
    channel = await session.exec(`${r.service} ${shellQuote(remote.path)}`);
    reader = new PktReader(channel[Symbol.asyncIterator]() as AsyncIterator<Buffer>, () => session.touch());
    first = await reader.next().catch(() => null);
    if (!first) throw session.notFound();
  } catch (error) {
    session.end(true);
    throw error instanceof GitGatewayError
      ? error
      : new GitGatewayError('network', `The ssh connection to ${session.where} failed.`);
  }
  const ended = (error?: unknown): GitGatewayError =>
    session.failure ??
    (error instanceof GitGatewayError
      ? error
      : new GitGatewayError('network', `The connection to ${session.where} dropped.`));

  if (!r.body) {
    const v2 = r.protocolV2 && /^version 2\n?$/.test(first.payload.toString('latin1'));
    async function* advertisement() {
      try {
        let batch: Buffer[] = v2 ? [first!.raw] : [pktLine(`# service=${r.service}\n`), FLUSH, first!.raw];
        let size = 0;
        for (let pkt = first!; !pkt.flush;) {
          const next = await reader.next().catch((e: unknown) => {
            throw ended(e);
          });
          if (!next) throw ended();
          pkt = next;
          batch.push(pkt.raw);
          size += pkt.raw.length;
          if (size >= BATCH_BYTES) {
            yield Buffer.concat(batch);
            batch = [];
            size = 0;
          }
        }
        yield Buffer.concat(batch);
        // Nothing wanted: a flush ends the session as git's own ls-remote ends it.
        channel.end(FLUSH);
        session.end();
      } finally {
        session.end(true);
      }
    }
    return { contentType: `application/x-${r.service}-advertisement`, body: Readable.from(advertisement()) };
  }

  // A POST: drop this session's advertisement, then send the request.
  try {
    for (let pkt = first; !pkt.flush;) {
      const next = await reader.next();
      if (!next) throw session.notFound();
      pkt = next;
    }
  } catch (error) {
    session.end(true);
    throw ended(error);
  }
  const body = r.body;
  body.pipe(channel); // the server's pace sets the client's; ends stdin with the body
  body.on('data', () => session.touch());
  body.on('error', (error) =>
    session.fail(
      error instanceof GitGatewayError
        ? error
        : new GitGatewayError('network', 'The git request could not be read.'),
    ),
  );
  async function* output() {
    try {
      const rest = reader.rest();
      if (rest.length > 0) yield rest;
      for (;;) {
        const next = await reader.read().catch((e: unknown) => {
          throw ended(e);
        });
        if (next.done) break;
        yield next.value;
      }
      const failed = await session.closed(channel);
      if (failed) throw failed;
    } finally {
      body.unpipe(channel);
      session.end(true);
    }
  }
  return { contentType: `application/x-${r.service}-result`, body: Readable.from(output()) };
}

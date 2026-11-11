import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { Server, utils } from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { projects } from '../db/schema.js';
import { deleteKey, generateKey, keyForProject } from '../ssh-keys/store.js';
import { removeHostKey, trustHostKey } from '../ssh-keys/known-hosts.js';
import { rmTemp } from '../test-rm.js';
import { type GatewayGrant, GitGateway } from './gateway.js';
import { gatewayGitArgs } from './remote-git.js';
import { openSshUpstream, parseSshRemote } from './ssh-upstream.js';
import { GitGatewayError } from './upstream.js';

const run = promisify(execFile);
const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));
const USER = userInfo().username;
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

describe('parseSshRemote', () => {
  it('reads ssh:// and scp-like addresses as git does', () => {
    expect(parseSshRemote('git@github.com:owner/app.git')).toEqual({
      user: 'git',
      host: 'github.com',
      port: 22,
      path: 'owner/app.git',
    });
    expect(parseSshRemote('ssh://git@GitHub.com./owner/app.git')).toEqual({
      user: 'git',
      host: 'github.com',
      port: 22,
      path: '/owner/app.git',
    });
    expect(parseSshRemote('ssh://alice@git.example.com:2222/srv/app%20x.git')).toEqual({
      user: 'alice',
      host: 'git.example.com',
      port: 2222,
      path: '/srv/app x.git',
    });
    expect(parseSshRemote('ssh://git@host/~alice/app.git')?.path).toBe('~alice/app.git');
    // No user: forges log in as git.
    expect(parseSshRemote('host.example:app.git')?.user).toBe('git');
    expect(parseSshRemote('ssh://host.example/app.git')?.user).toBe('git');
  });

  it('refuses what is not one ssh repository address', () => {
    for (const bad of [
      'https://github.com/owner/app.git',
      'ssh://git:secret@github.com/owner/app.git',
      'ssh://git@[::1]/app.git',
      'ssh://git@github.com',
      'ssh://git@github.com/',
      'git@github.com:',
      './local:path',
      '/abs/path',
      'git@github.com:owner/app\n.git',
      'ssh://git@github.com:0/app.git',
      'ssh://-oProxyCommand=x@host/app.git',
    ])
      expect(parseSshRemote(bad), bad).toBeNull();
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe('a server that logs in but never answers the git command', () => {
  // sshd always answers an exec request; ssh2's own server need not: the client waits for a reply
  // that never comes, and only the idle limit ends the operation.
  it('runs into the idle limit, the connection closed', async () => {
    const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () =>
        client.on('session', (accept) => {
          accept().on('exec', () => undefined); // neither accepted nor rejected
        }),
      );
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    let closed = false;
    const clients: { end: () => void }[] = [];
    server.on('connection', (client) => {
      clients.push(client);
      client.on('close', () => (closed = true));
    });
    try {
      const started = Date.now();
      const opened = openSshUpstream({
        url: `ssh://git@127.0.0.1:${port}/app.git`,
        privateKey: utils.generateKeyPairSync('ed25519').private,
        service: 'git-upload-pack',
        protocolV2: false,
        signal: new AbortController().signal,
        idleTimeoutMs: 300,
        hostKeyTypes: [],
        hostKey: () => 'ok',
        keyShownIn: 'Settings',
      });
      const outcome = await Promise.race([
        opened.then(
          () => 'answered',
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
      ]);
      expect(outcome).toBeInstanceOf(GitGatewayError);
      expect((outcome as GitGatewayError).code).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect.poll(() => closed).toBe(true);
    } finally {
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * The forge: a real sshd on 127.0.0.1 that logs in only the current user (also root, as CI runs it)
 * with the keys in `authorized_keys` and runs only git-upload-pack/git-receive-pack on the bare
 * repositories under `repos/`, through a forced command. `old*` repositories are served as by a
 * server without protocol v2; `cut` stops sending mid-pack, `drop` also kills the connection.
 */
describe.skipIf(!SSHD)('the git gateway over ssh', () => {
  let dir: string;
  let sshd: ChildProcess;
  let port: number;
  let db: Db;
  let opened: ReturnType<typeof openDb>;
  let app: FastifyInstance;
  let gateway: GitGateway;
  let sharedKeyId: string;
  const hostPub: Record<string, { keyType: string; key: string; fingerprint: string }> = {};
  const repos = () => path.join(dir, 'repos');
  const bare = (name: string) => path.join(repos(), `${name}.git`);
  const sessions = () => readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter(Boolean);
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ssh-upstream-'));
    for (const [type, extra] of [
      ['ed25519', []],
      ['ecdsa', ['-b', '256']],
      ['rsa', ['-b', '2048']],
    ] as const) {
      const file = path.join(dir, `host_${type}`);
      execFileSync('ssh-keygen', ['-q', '-t', type, ...extra, '-N', '', '-f', file]);
      const [keyType, key] = readFileSync(`${file}.pub`, 'utf8').split(' ') as [string, string];
      const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', `${file}.pub`], { encoding: 'utf8' }).split(
        ' ',
      )[1]!;
      hostPub[type] = { keyType, key, fingerprint };
    }
    // The served repositories: main with a commit large enough to be cut mid-pack.
    const seed = path.join(dir, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(path.join(seed, 'big.bin'), randomBytes(400_000));
    gitIn(seed, 'add', 'big.bin');
    gitIn(seed, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'seed');
    for (const name of ['app', 'old', 'hooked', 'cut', 'drop', 'stall'])
      execFileSync('git', ['clone', '-q', '--bare', seed, bare(name)]);
    const hook = path.join(bare('hooked'), 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "main is protected on this server" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const wrapper = path.join(dir, 'git-only.sh');
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'root="$1"',
        'case "$SSH_ORIGINAL_COMMAND" in',
        `  "git-upload-pack '"*"'") svc=git-upload-pack ;;`,
        `  "git-receive-pack '"*"'") svc=git-receive-pack ;;`,
        '  *) echo "only git here" >&2; exit 1 ;;',
        'esac',
        `name=\${SSH_ORIGINAL_COMMAND#"$svc '"}; name=\${name%"'"}; name=\${name#/}`,
        'case "$name" in *[!a-z.]*|"") echo "no such repository" >&2; exit 1 ;; esac',
        '[ -d "$root/$name" ] || { echo "no such repository" >&2; exit 1; }',
        'case "$name" in old*) unset GIT_PROTOCOL ;; esac',
        'echo "$svc $name${GIT_PROTOCOL:+ $GIT_PROTOCOL}" >> "$root/../log"',
        'case "$name" in',
        '  cut.git) "$svc" "$root/$name" | head -c 20000 ;;',
        '  stall.git) exec sleep 30 ;;',
        '  drop.git) "$svc" "$root/$name" | head -c 20000 | tee "$root/../drop-$$"',
        '    [ "$(wc -c < "$root/../drop-$$")" -ge 20000 ] && kill -9 $PPID ;;',
        '  *) exec "$svc" "$root/$name" ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(wrapper, 0o755);
    writeFileSync(path.join(dir, 'authorized_keys'), '');
    port = await freePort();
    const config = path.join(dir, 'sshd_config');
    writeFileSync(
      config,
      [
        ...['ed25519', 'ecdsa', 'rsa'].map((t) => `HostKey ${path.join(dir, `host_${t}`)}`),
        'PidFile none',
        'UsePAM no',
        'StrictModes no',
        'ListenAddress 127.0.0.1',
        `Port ${port}`,
        `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'AcceptEnv GIT_PROTOCOL',
        `ForceCommand ${wrapper} ${repos()}`,
      ].join('\n'),
    );
    sshd = spawn(SSHD!, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      sshd.stderr!.on('data', (d: Buffer) => d.toString().includes('Server listening') && resolve());
      sshd.on('exit', (code) => reject(new Error(`sshd exited with ${code}`)));
    });
  });
  afterAll(() => {
    sshd?.kill();
    if (dir) rmTemp(dir);
  });

  beforeEach(async () => {
    opened = openDb(':memory:');
    db = opened.db;
    db.insert(projects)
      .values({ id: 'p1', name: 'p1', slug: 'p1', path: '/workspaces/p1', createdAt: new Date() })
      .run();
    const shared = generateKey(db, 'shared');
    sharedKeyId = keyForProject(db, { id: 'p1', sshKeyChoice: 'shared' })!.keyId;
    // Only the shared key may log in; the project's own key is one the server does not know.
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    writeFileSync(path.join(dir, 'authorized_keys'), `${shared.publicKey}\n`);
    writeFileSync(path.join(dir, 'log'), '');
    app = Fastify();
    gateway = new GitGateway({ baseUrl: 'http://127.0.0.1:0', runnerHosts: ['localhost'], db });
    gateway.register(app);
    gateway.baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => {
    gateway.dispose();
    await app.close();
    opened.close();
  });

  const address = (repo: string) => `ssh://${USER}@127.0.0.1:${port}/${repo}.git`;
  const grant = (repo: string, extra: Partial<GatewayGrant> = {}): GatewayGrant => ({
    projectId: 'p1',
    upstreamUrl: address(repo),
    credential: { kind: 'ssh', keyId: sharedKeyId, keyScope: 'shared' },
    service: 'git-upload-pack',
    ...extra,
  });
  const trust = (type: 'ed25519' | 'ecdsa' | 'rsa') =>
    trustHostKey(db, { host: '127.0.0.1', port, keyType: hostPub[type]!.keyType, key: hostPub[type]!.key });
  /** Runs one git command through a capability (git's own http client, no prompt, no config of ours). */
  const viaGateway = (g: GatewayGrant, args: (url: string) => string[], cwd = dir) =>
    gateway.run(g, async (url) =>
      run('git', [...gatewayGitArgs(gateway), ...args(url)], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    );
  const failure = async (promise: Promise<unknown>): Promise<GitGatewayError> => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitGatewayError);
    const e = error as GitGatewayError;
    // A plain sentence: never a key, a capability or the capability URL.
    expect(e.message).not.toMatch(/PRIVATE KEY|b3BlbnNzaC1rZXktdjE|\/api\/internal\/git\//);
    return e;
  };
  const clone = async (repo: string, version: 0 | 2, target: string) =>
    viaGateway(grant(repo), (url) => ['-c', `protocol.version=${version}`, 'clone', '-q', '--', url, target]);
  const head = (repo: string) => gitIn(bare(repo), 'rev-parse', 'refs/heads/main');

  it('clones with protocol v2 and with v0 through one capability each; nothing is left open', async () => {
    trust('ed25519');
    const v2 = path.join(dir, `clone-v2-${randomBytes(4).toString('hex')}`);
    await clone('app', 2, v2);
    expect(gitIn(v2, 'rev-parse', 'HEAD')).toBe(head('app'));
    expect(sessions().filter((l) => l.startsWith('git-upload-pack app.git'))).toEqual(
      expect.arrayContaining(['git-upload-pack app.git version=2']),
    );
    expect(sessions().every((l) => l.endsWith('version=2'))).toBe(true);
    writeFileSync(path.join(dir, 'log'), '');
    const v0 = path.join(dir, `clone-v0-${randomBytes(4).toString('hex')}`);
    await clone('app', 0, v0);
    expect(gitIn(v0, 'rev-parse', 'HEAD')).toBe(head('app'));
    expect(sessions().length).toBeGreaterThan(0);
    expect(sessions().every((l) => l === 'git-upload-pack app.git')).toBe(true);
    expect(gateway.size).toBe(0);
  });

  it('a server without protocol v2 answers a v2 client in v0, and the clone works', async () => {
    trust('ed25519');
    const target = path.join(dir, `clone-old-${randomBytes(4).toString('hex')}`);
    await clone('old', 2, target);
    expect(gitIn(target, 'rev-parse', 'HEAD')).toBe(head('old'));
    expect(sessions().every((l) => l === 'git-upload-pack old.git')).toBe(true);
  });

  it('info/refs answers as git http-backend does: the service line first in v0, the v2 capabilities as they are', async () => {
    trust('ed25519');
    const { capability, url } = gateway.issue(grant('app'));
    const v0 = await fetch(`${url}/info/refs?service=git-upload-pack`);
    expect(v0.status).toBe(200);
    expect(v0.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    const v0Body = await v0.text();
    expect(v0Body.startsWith(`${pkt('# service=git-upload-pack\n')}0000`)).toBe(true);
    expect(v0Body).toContain(`${head('app')} HEAD`);
    expect(v0Body.endsWith('0000')).toBe(true);
    const v2 = await fetch(`${url}/info/refs?service=git-upload-pack`, {
      headers: { 'git-protocol': 'version=2' },
    });
    const v2Body = await v2.text();
    expect(v2Body.startsWith(pkt('version 2\n'))).toBe(true);
    expect(v2Body.endsWith('0000')).toBe(true);
    gateway.release(capability);
  });

  it('a gzipped request (git compresses large ones) reaches the server decompressed', async () => {
    trust('ed25519');
    const { capability, url } = gateway.issue(grant('app'));
    const res = await fetch(`${url}/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        'content-encoding': 'gzip',
        'git-protocol': 'version=2',
      },
      body: gzipSync(`${pkt('command=ls-refs\n')}0000`),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-git-upload-pack-result');
    expect(await res.text()).toContain(`${head('app')} refs/heads/main`);
    gateway.release(capability);
  });

  it('fetches new commits through the gateway', async () => {
    trust('ed25519');
    const work = path.join(dir, `fetch-${randomBytes(4).toString('hex')}`);
    await clone('app', 2, work);
    const other = path.join(dir, `other-${randomBytes(4).toString('hex')}`);
    execFileSync('git', ['clone', '-q', bare('app'), other]);
    gitIn(other, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'more');
    gitIn(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await viaGateway(
      grant('app'),
      (url) => ['fetch', '-q', '--', url, 'refs/heads/main:refs/remotes/x/main'],
      work,
    );
    expect(gitIn(work, 'rev-parse', 'refs/remotes/x/main')).toBe(head('app'));
  });

  it('pushes the planned commit; a push the plan does not allow never reaches the server', async () => {
    trust('ed25519');
    const work = path.join(dir, `push-${randomBytes(4).toString('hex')}`);
    await clone('app', 2, work);
    gitIn(work, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'mine');
    const newOid = gitIn(work, 'rev-parse', 'HEAD');
    const oldOid = head('app');
    const push = { service: 'git-receive-pack' as const, push: { ref: 'refs/heads/main', newOid, oldOid } };
    // To another branch than planned: refused by the gateway, after only the advertisement session.
    writeFileSync(path.join(dir, 'log'), '');
    const refused = await failure(
      viaGateway(
        grant('app', push),
        (url) => ['push', '--porcelain', '--', url, `${newOid}:refs/heads/other`],
        work,
      ),
    );
    expect(refused.code).toBe('ref_refused');
    expect(sessions()).toEqual(['git-receive-pack app.git']);
    expect(gitIn(bare('app'), 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    // As planned: pushed.
    await viaGateway(
      grant('app', push),
      (url) => ['push', '--porcelain', '--', url, `${newOid}:refs/heads/main`],
      work,
    );
    expect(head('app')).toBe(newOid);
    expect(gateway.size).toBe(0);
  });

  it("a push the server's pre-receive hook refuses fails with a plain message", async () => {
    trust('ed25519');
    const work = path.join(dir, `hooked-${randomBytes(4).toString('hex')}`);
    await clone('hooked', 2, work);
    gitIn(work, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'mine');
    const newOid = gitIn(work, 'rev-parse', 'HEAD');
    const oldOid = head('hooked');
    const e = await failure(
      viaGateway(
        grant('hooked', { service: 'git-receive-pack', push: { ref: 'refs/heads/main', newOid, oldOid } }),
        (url) => ['push', '--porcelain', '--', url, `${newOid}:refs/heads/main`],
        work,
      ),
    );
    expect(e.code).toBe('git_failed');
    expect(e.message).toMatch(/main is protected on this server|pre-receive hook declined/);
    expect(head('hooked')).toBe(oldOid);
    expect(gateway.size).toBe(0);
  });

  it('a key the server does not accept fails with auth_refused, naming where the public key is shown', async () => {
    trust('ed25519');
    const own = keyForProject(db, { id: 'p1', sshKeyChoice: 'own' })!;
    const e = await failure(
      viaGateway(grant('app', { credential: { kind: 'ssh', keyId: own.keyId, keyScope: 'p1' } }), (url) => [
        'ls-remote',
        '--',
        url,
      ]),
    );
    expect(e.code).toBe('auth_refused');
    expect(e.message).toBe(
      "The server refused Emberline's SSH key: add the public key shown in this project's settings to the repository or account.",
    );
    writeFileSync(path.join(dir, 'authorized_keys'), '');
    const shared = await failure(viaGateway(grant('app'), (url) => ['ls-remote', '--', url]));
    expect(shared.message).toBe(
      "The server refused Emberline's SSH key: add the public key shown in Settings → SSH key to the repository or account.",
    );
  });

  it('an unknown host key fails with host_key_unknown and the key and fingerprint to show', async () => {
    const e = await failure(viaGateway(grant('app'), (url) => ['ls-remote', '--', url]));
    expect(e.code).toBe('host_key_unknown');
    expect(e.hostKey).toEqual({
      host: '127.0.0.1',
      port,
      keyType: 'ssh-ed25519',
      key: hostPub.ed25519!.key,
      fingerprint: hostPub.ed25519!.fingerprint,
    });
    expect(e.message).toContain(hostPub.ed25519!.fingerprint);
    expect(sessions()).toEqual([]);
  });

  it('a host trusted with another key fails with host_key_changed, showing the key offered', async () => {
    const other = utils.generateKeyPairSync('ed25519').public.split(' ');
    trustHostKey(db, { host: '127.0.0.1', port, keyType: other[0]!, key: other[1]! });
    const e = await failure(viaGateway(grant('app'), (url) => ['ls-remote', '--', url]));
    expect(e.code).toBe('host_key_changed');
    expect(e.hostKey).toMatchObject({ keyType: 'ssh-ed25519', fingerprint: hostPub.ed25519!.fingerprint });
    expect(sessions()).toEqual([]);
  });

  it('a host trusted with only its ecdsa or only its rsa key is reached with that key (Ruling 16)', async () => {
    for (const type of ['ecdsa', 'rsa'] as const) {
      const stored = trust(type);
      const { stdout } = await viaGateway(grant('app'), (url) => ['ls-remote', '--', url]);
      expect(stdout).toContain(`${head('app')}\trefs/heads/main`);
      removeHostKey(db, '127.0.0.1', port, stored.keyType);
    }
  });

  it('a capability bound to a key that was replaced or deleted fails with ssh_key_missing (Ruling 17)', async () => {
    trust('ed25519');
    const { capability, url } = gateway.issue(grant('app'));
    // Replaced: the new key would even be accepted, but this operation was given the old one.
    writeFileSync(path.join(dir, 'authorized_keys'), `${generateKey(db, 'shared').publicKey}\n`);
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`)).status).toBe(403);
    expect(gateway.release(capability)).toMatchObject({ code: 'ssh_key_missing' });
    deleteKey(db, 'shared');
    const e = await failure(viaGateway(grant('app'), (u) => ['ls-remote', '--', u]));
    expect(e.code).toBe('ssh_key_missing');
    expect(e.message).toBe("Create a key in Settings → SSH key, or in this project's settings.");
    expect(sessions()).toEqual([]);
  });

  it('a server that stops mid-pack or drops the connection fails the clone, quickly, and the capability is released', async () => {
    trust('ed25519');
    for (const [repo, code] of [
      ['cut', 'git_failed'], // git's own "early EOF"
      ['drop', 'network'], // the gateway saw the connection go without git's exit
    ] as const) {
      const started = Date.now();
      const e = await failure(clone(repo, 2, path.join(dir, `${repo}-${randomBytes(4).toString('hex')}`)));
      expect(e.code).toBe(code);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(gateway.size).toBe(0);
    }
  }, 30_000);

  it('a server that never answers runs into the idle limit; the capability is released', async () => {
    trust('ed25519');
    const quick = Fastify();
    const impatient = new GitGateway({
      baseUrl: 'http://127.0.0.1:0',
      runnerHosts: ['localhost'],
      db,
      idleTimeoutMs: 500,
    });
    impatient.register(quick);
    impatient.baseUrl = await quick.listen({ host: '127.0.0.1', port: 0 });
    try {
      const started = Date.now();
      const e = await failure(
        impatient.run(grant('stall'), (url) =>
          run('git', [...gatewayGitArgs(impatient), 'ls-remote', '--', url], { cwd: dir }),
        ),
      );
      expect(e.code).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(impatient.size).toBe(0);
    } finally {
      impatient.dispose();
      await quick.close();
    }
  });

  it('refuses an ssh credential for an address that is not ssh, before anything runs', () => {
    expect(() => gateway.issue(grant('app', { upstreamUrl: 'https://github.com/o/r.git' }))).toThrow(
      expect.objectContaining({ code: 'url_refused' }),
    );
  });
});

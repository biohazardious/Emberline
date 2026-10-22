import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { basicAuthValue, type GitHttpCredential } from '../git-credentials.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import { execGitFile } from '../git-exec.js';
import { GitGateway } from './gateway.js';
import {
  accountFetchBranch,
  gatewayGitArgs,
  accountPushBranch,
  accountRemoteBranches,
  type AccountRemote,
} from './remote-git.js';

const TOKEN = 'gateway-secret-token';
let a: FakeForge;
let b: FakeForge;
let app: FastifyInstance;
let gateway: GitGateway;
let dir: string;
let repo: string;
const logs: string[] = [];
const execs: ExecRequest[] = [];
const cred = (): GitHttpCredential => ({ serverUrl: a.url, username: 'alice', token: TOKEN });
const remote = (): AccountRemote => ({
  gateway,
  projectId: 'p1',
  url: `${a.url}/alice/app.git`,
  credential: cred(),
});
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string) => {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  gitIn(cwd, 'add', file);
  gitIn(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
};
const posts = (f: FakeForge) => f.seen.filter((r) => r.method === 'POST');
/** Nothing anywhere holds the token: logs, every runner exec, error messages. */
function expectNoToken(...extra: unknown[]) {
  const all = JSON.stringify([logs, execs, extra.map(String)]).toLowerCase();
  for (const marker of [TOKEN, basicAuthValue(cred())]) expect(all).not.toContain(marker.toLowerCase());
}

async function startGateway(
  runnerHosts = ['localhost'],
  extra: Partial<ConstructorParameters<typeof GitGateway>[0]> = {},
) {
  app = Fastify({
    logger: {
      level: 'trace',
      stream: new Writable({
        write(chunk, _enc, done) {
          logs.push(String(chunk));
          done();
        },
      }),
    },
  });
  gateway = new GitGateway({ baseUrl: 'http://127.0.0.1:0', runnerHosts, ...extra });
  gateway.register(app);
  gateway.baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}

beforeEach(async () => {
  a = await startFakeForge({ token: TOKEN });
  b = await startFakeForge({ token: 'other-token' });
  a.bare('alice', 'app');
  dir = mkdtempSync(path.join(tmpdir(), 'gateway-'));
  repo = path.join(dir, 'work');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'a.txt');
  logs.length = 0;
  execs.length = 0;
  setCommandExecutor(async (request) => {
    execs.push(request);
    return localCommandExecutor(request);
  });
  await startGateway();
});
afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  gateway.dispose();
  await app.close();
  await a.close();
  await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the git gateway', () => {
  it('ls-remote, push and fetch go through it with the account; no log, exec or error holds the token or a live capability', async () => {
    expect(await accountRemoteBranches(remote(), repo)).toEqual([]);
    expect(await accountPushBranch(remote(), repo, 'main')).toBe('pushed');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
      gitIn(repo, 'rev-parse', 'HEAD'),
    );
    const elsewhere = path.join(dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', a.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'b.txt');
    gitIn(elsewhere, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await accountFetchBranch(remote(), repo, 'main');
    expect(gitIn(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(gitIn(elsewhere, 'rev-parse', 'HEAD'));
    expect(a.seen.every((r) => r.authorization === `Basic ${basicAuthValue(cred())}`)).toBe(true);
    expect(gateway.size).toBe(0);
    expect(logs.join('')).not.toMatch(/\/api\/internal\/git\/[A-Za-z0-9_-]{43}/);
    expect(gitIn(repo, 'config', '--get-regexp', '.')).not.toContain('/api/internal/git/');
    expectNoToken();
  });

  it('a capability works for one operation: refused after release and after expiry, without reaching the forge', async () => {
    const used = gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-upload-pack',
    });
    expect((await fetch(`${used.url}/info/refs?service=git-upload-pack`)).status).toBe(200);
    gateway.release(used.capability);
    const seen = a.seen.length;
    expect((await fetch(`${used.url}/info/refs?service=git-upload-pack`)).status).toBe(404);
    const stale = gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-upload-pack',
      firstUseMs: 50,
    });
    await new Promise((r) => setTimeout(r, 120));
    expect((await fetch(`${stale.url}/info/refs?service=git-upload-pack`)).status).toBe(404);
    expect(a.seen.length).toBe(seen);
  });

  it('the wrong service, another path and a second push are refused before the forge', async () => {
    const read = gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-upload-pack',
    });
    expect((await fetch(`${read.url}/info/refs?service=git-receive-pack`)).status).toBe(403);
    expect(
      (
        await fetch(`${read.url}/git-receive-pack`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-git-receive-pack-request' },
          body: '0000',
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${read.url}/../other.git/info/refs?service=git-upload-pack`)).status).toBe(404);
    expect(gateway.release(read.capability)).toMatchObject({ code: 'service_refused' });
    expect(a.seen).toEqual([]);
  });

  it('a push with another ref, an extra ref, a delete or another commit never reaches the forge', async () => {
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    for (const lines of [
      [`${head} ${head} refs/heads/other\0 report-status\n`],
      [`${head} ${head} refs/heads/main\0 report-status\n`, `${'0'.repeat(40)} ${head} refs/heads/extra\n`],
      [`${head} ${'0'.repeat(40)} refs/heads/main\0 report-status\n`],
      [`${head} ${'c'.repeat(40)} refs/heads/main\0 report-status\n`],
      [`${'d'.repeat(40)} ${head} refs/heads/main\0 report-status\n`], // another old value
    ]) {
      const grant = gateway.issue({
        projectId: 'p1',
        upstreamUrl: `${a.url}/alice/app.git`,
        credential: cred(),
        service: 'git-receive-pack',
        push: { ref: 'refs/heads/main', newOid: head, oldOid: head },
      });
      const res = await fetch(`${grant.url}/git-receive-pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-receive-pack-request' },
        body: `${lines.map(pkt).join('')}0000`,
      });
      expect(res.status).toBe(403);
      expect(gateway.release(grant.capability)).toMatchObject({ code: 'ref_refused' });
    }
    expect(posts(a)).toEqual([]);
  });

  it("any other path or method under a capability gets the same 404, a POST that is not git's is refused, and nothing is logged", async () => {
    const grant = gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-upload-pack',
    });
    for (const [method, suffix] of [
      ['GET', '/objects/info/packs'],
      ['GET', '/HEAD'],
    ] as const) {
      expect((await fetch(`${grant.url}${suffix}`, { method })).status, `${method} ${suffix}`).toBe(404);
    }
    // Other methods, WebDAV ones too, get 405 from the same silent route; HEAD never becomes a forge request.
    for (const [method, suffix] of [
      ['PUT', '/info/refs?service=git-upload-pack'],
      ['DELETE', ''],
      ['PROPFIND', '/info/refs'],
      ['MKCOL', '/x'],
      ['HEAD', '/info/refs?service=git-upload-pack'],
      ['OPTIONS', '/info/refs'],
    ] as const) {
      expect((await fetch(`${grant.url}${suffix}`, { method })).status, `${method} ${suffix}`).toBe(405);
    }
    // A POST that is not a git request body (another content type, none) is refused, not forwarded.
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/json' },
      {},
    ] as Record<string, string>[]) {
      const res = await fetch(`${grant.url}/git-upload-pack`, {
        method: 'POST',
        headers,
        body: headers['content-type'] === 'application/json' ? '{}' : '0000',
      });
      expect(res.status, JSON.stringify(headers)).toBe(415);
    }
    expect(logs.join('')).not.toContain(grant.capability);
    expect(a.seen).toEqual([]);
  });

  it('only the runner may use it', async () => {
    gateway.dispose();
    await app.close();
    await startGateway(['runner.invalid'], { lookup: async () => ['10.255.255.1'] });
    const grant = gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-upload-pack',
    });
    expect((await fetch(`${grant.url}/info/refs?service=git-upload-pack`)).status).toBe(403);
    expect(a.seen).toEqual([]);
  });

  it('a redirect to another server, a refused token and an upstream outside the account fail with a sentence and no token', async () => {
    a.redirectTo = b.url;
    const redirected = await accountRemoteBranches(remote(), repo).catch((e: unknown) => e);
    expect(redirected).toMatchObject({ code: 'redirect_refused' });
    expect(b.seen).toEqual([]);
    a.redirectTo = null;
    const refused = await accountRemoteBranches(
      { ...remote(), credential: { ...cred(), token: 'revoked' } },
      repo,
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: 'auth_refused',
      message: `The forge refused the account's token for ${new URL(a.url).host}.`,
    });
    expect(() =>
      gateway.issue({
        projectId: 'p1',
        upstreamUrl: `${b.url}/alice/app.git`,
        credential: cred(),
        service: 'git-upload-pack',
      }),
    ).toThrow(expect.objectContaining({ code: 'url_refused' }));
    expectNoToken(redirected, refused, JSON.stringify(refused));
  });

  it("a push larger than git's post buffer (an auth probe, then a chunked body) goes through as one push", async () => {
    writeFileSync(path.join(repo, 'big.bin'), randomBytes(3 * 1024 * 1024)); // incompressible, over http.postBuffer
    gitIn(repo, 'add', 'big.bin');
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'big');
    expect(await accountPushBranch(remote(), repo, 'main')).toBe('pushed');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
      gitIn(repo, 'rev-parse', 'HEAD'),
    );
    // The probe never reached the forge: one push POST (after the planning ls-remote and the advertisement).
    expect(a.seen.filter((r) => r.path.endsWith('/git-receive-pack'))).toHaveLength(1);
    expect(posts(a)).toHaveLength(1);
    expect(gateway.size).toBe(0);
  });

  it('stops an operation at the byte cap', async () => {
    gateway.dispose();
    await app.close();
    await startGateway(['localhost'], { maxBytes: 512 });
    writeFileSync(path.join(repo, 'big.bin'), randomBytes(64 * 1024)); // incompressible
    gitIn(repo, 'add', 'big.bin');
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'big');
    await expect(accountPushBranch(remote(), repo, 'main')).rejects.toMatchObject({
      code: 'too_large',
      message: 'This git operation moved more than 512 bytes; Emberline stopped it.',
    });
  });
});

describe('the git gateway, one push and its limits', () => {
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
  const ZERO = '0'.repeat(40);
  const RECEIVE = { 'content-type': 'application/x-git-receive-pack-request' };
  const receivePosts = () =>
    a.seen.filter((r) => r.method === 'POST' && r.path.endsWith('/git-receive-pack'));
  const pushGrant = (newOid: string, oldOid = ZERO) =>
    gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-receive-pack',
      push: { ref: 'refs/heads/main', newOid, oldOid },
    });

  it('a push capability carries one push: a second list or probe on it is refused before the forge', async () => {
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const grant = pushGrant(head);
    // Async: the gateway answers in this same process.
    await promisify(execFile)('git', [
      '-C',
      repo,
      ...gatewayGitArgs(gateway),
      'push',
      '-q',
      '--',
      grant.url,
      `${head}:refs/heads/main`,
    ]);
    expect(receivePosts()).toHaveLength(1);
    for (const body of [`${pkt(`${ZERO} ${head} refs/heads/main\0 report-status\n`)}0000`, '0000']) {
      const res = await fetch(`${grant.url}/git-receive-pack`, { method: 'POST', headers: RECEIVE, body });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('This push was already sent.');
    }
    expect(receivePosts()).toHaveLength(1);
    gateway.release(grant.capability);
  });

  it('a probe while a push is in flight is refused; release ends the push that never sent its list', async () => {
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const grant = pushGrant(head);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(pkt(`${ZERO} ${head} refs/heads/main\0 report-status\n`).slice(0, 30)),
        );
      },
    });
    const inFlight = fetch(`${grant.url}/git-receive-pack`, {
      method: 'POST',
      headers: RECEIVE,
      body,
      duplex: 'half',
    } as RequestInit);
    await new Promise((r) => setTimeout(r, 150));
    const probe = await fetch(`${grant.url}/git-receive-pack`, {
      method: 'POST',
      headers: RECEIVE,
      body: '0000',
    });
    expect(probe.status).toBe(403);
    gateway.release(grant.capability);
    expect((await inFlight).status).toBe(403);
    expect(receivePosts()).toEqual([]);
  });

  it('a command list that does not arrive within the idle limit is refused', async () => {
    gateway.dispose();
    await app.close();
    await startGateway(['localhost'], { idleTimeoutMs: 200 });
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const grant = pushGrant(head);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('00'));
      },
    });
    const started = Date.now();
    const res = await fetch(`${grant.url}/git-receive-pack`, {
      method: 'POST',
      headers: RECEIVE,
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(403);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(gateway.release(grant.capability)).toEqual({
      code: 'ref_refused',
      message: 'The push request did not send its command list in time.',
    });
  });

  it('a compressed push body is refused before the forge', async () => {
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const grant = pushGrant(head);
    const res = await fetch(`${grant.url}/git-receive-pack`, {
      method: 'POST',
      headers: { ...RECEIVE, 'content-encoding': 'gzip' },
      body: `${pkt(`${ZERO} ${head} refs/heads/main\0 report-status\n`)}0000`,
    });
    expect(res.status).toBe(403);
    expect(gateway.release(grant.capability)).toEqual({
      code: 'ref_refused',
      message: 'A compressed push request is not accepted.',
    });
    expect(posts(a)).toEqual([]);
  });

  it('request 101 on one capability gets 429', async () => {
    const grant = gateway.issue({
      projectId: 'p1',
      upstreamUrl: `${a.url}/alice/app.git`,
      credential: cred(),
      service: 'git-upload-pack',
    });
    for (let batch = 0; batch < 10; batch++) {
      const statuses = await Promise.all(
        Array.from({ length: 10 }, async () => {
          const res = await fetch(`${grant.url}/info/refs?service=git-upload-pack`);
          await res.arrayBuffer();
          return res.status;
        }),
      );
      expect(statuses.every((s) => s === 200)).toBe(true);
    }
    const seen = a.seen.length;
    expect((await fetch(`${grant.url}/info/refs?service=git-upload-pack`)).status).toBe(429);
    expect(a.seen.length).toBe(seen);
    gateway.release(grant.capability);
  });

  it('a capability that runs out of time mid-command keeps the reason', async () => {
    const error = await gateway
      .run(
        {
          projectId: 'p1',
          upstreamUrl: `${a.url}/alice/app.git`,
          credential: cred(),
          service: 'git-upload-pack',
          operationMs: 200,
        },
        async (url) => {
          await new Promise((r) => setTimeout(r, 300));
          return execGitFile([...gatewayGitArgs(gateway), 'ls-remote', '--', url], { cwd: repo });
        },
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'timeout',
      message: 'This git operation ran out of time; Emberline stopped it.',
    });
  });

  it('a push is planned from the remote branch: fast-forward passes, a diverged or unrelated branch is rejected and the remote keeps its commits', async () => {
    expect(await accountPushBranch(remote(), repo, 'main')).toBe('pushed'); // new branch: planned from the zero id
    commit(repo, 'b.txt');
    expect(await accountPushBranch(remote(), repo, 'main')).toBe('pushed'); // fast-forward
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
      gitIn(repo, 'rev-parse', 'HEAD'),
    );
    // Someone else pushes; our branch diverges (the remote commit is not even here yet).
    const elsewhere = path.join(dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', a.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'theirs.txt');
    gitIn(elsewhere, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const theirs = gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main');
    commit(repo, 'ours.txt');
    const pushes = receivePosts().length;
    expect(await accountPushBranch(remote(), repo, 'main')).toBe('rejected');
    // An unrelated history (what a force push would put there) is rejected the same way.
    gitIn(repo, 'checkout', '-q', '--orphan', 'other');
    commit(repo, 'orphan.txt');
    gitIn(repo, 'branch', '-f', 'main', 'HEAD');
    expect(await accountPushBranch(remote(), repo, 'main')).toBe('rejected');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(theirs);
    expect(receivePosts()).toHaveLength(pushes);
    expect(gateway.size).toBe(0);
  });

  it('a forged old value on a planned push never reaches the forge, and a force push of another commit is refused', async () => {
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const remoteHead = gitIn(repo, 'rev-parse', 'HEAD');
    commit(repo, 'next.txt');
    const planned = gitIn(repo, 'rev-parse', 'HEAD');
    const grant = pushGrant(planned, remoteHead);
    const forged = await fetch(`${grant.url}/git-receive-pack`, {
      method: 'POST',
      headers: RECEIVE,
      body: `${pkt(`${'e'.repeat(40)} ${planned} refs/heads/main\0 report-status\n`)}0000`,
    });
    expect(forged.status).toBe(403);
    gateway.release(grant.capability);
    // A hostile git with a capability for the planned commit forces an unrelated one.
    gitIn(repo, 'checkout', '-q', '--orphan', 'other');
    commit(repo, 'orphan.txt');
    const orphan = gitIn(repo, 'rev-parse', 'HEAD');
    const second = pushGrant(planned, remoteHead);
    await expect(
      promisify(execFile)('git', [
        '-C',
        repo,
        ...gatewayGitArgs(gateway),
        'push',
        '-q',
        '--force',
        '--',
        second.url,
        `${orphan}:refs/heads/main`,
      ]),
    ).rejects.toThrow();
    expect(gateway.release(second.capability)).toMatchObject({ code: 'ref_refused' });
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(remoteHead);
    expect(receivePosts()).toEqual([]);
  });

  it('a forge that refuses the push (a hook, a protected branch) says why, not "the remote has commits"', async () => {
    const hook = path.join(a.bare('alice', 'app'), 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n',
    );
    chmodSync(hook, 0o755);
    const error = await accountPushBranch(remote(), repo, 'main').catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'git_failed',
      message: 'The forge refused the push: GH006: Protected branch update failed for refs/heads/main.',
    });
  });
});

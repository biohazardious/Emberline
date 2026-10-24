/**
 * Proof, with real git in Docker, that no git command core runs against a remote lets a config an
 * agent can write run a command, route the traffic, or pick a different target. Rows are the
 * hardened paths (a push, a run push, reading origin, and an import clone); columns are the attack
 * keys, planted in the worktree's own config and in a global config the runner shares, plus a
 * submodule's config and a local-path origin. Each case asserts that no planted command ran (a
 * marker file is never created) and that the credential never reached a proxy.
 *
 * Then: TLS, proxy and extra-header keys one at a time (so a refusal of one key never hides
 * another), and the runner's environment and PATH, planted for ptyd itself (a real ptyd in this
 * process) and for a runner that would forward its whole environment: core's commands are the
 * image's binaries with only core's variables.
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localCommandExecutor, ptydCommandExecutor, RUNNER_BIN, setCommandExecutor } from './command-exec.js';
import { syncWorktreeToMainWorkspace } from './factory/service.js';
import {
  assertSafeGitConfig,
  cloneGitEnv,
  execGitFile,
  HARDENED_GIT_ARGS,
  hardenedGitEnv,
  NO_SUBMODULES,
  REMOTE_PROTOCOL_ARGS,
  UnsafeGitConfigError,
} from './git-exec.js';
import { PtydBridge } from './ptyd-bridge.js';
import { fetchBranchObjects, listRemoteBranches, pushBranch, remoteBranchHead } from './repository/git.js';
import { pushWorktreeBranch } from './runs/git.js';
import { probePreviewFraming } from './runs/preview-framing.js';
import { startGitHttp } from './test-git-http.js';
import { rmTemp } from './test-rm.js';

let root: string;
let marker: string;
let http: Awaited<ReturnType<typeof startGitHttp>>;
let proxy: { server: Server; hits: string[]; port: number };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-C', cwd, ...args], {
    encoding: 'utf8',
    // Never block on a credential prompt reading the test runner's tty.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

/** A script that records it ran (with its arguments) into the marker file and exits; it reads no stdin. */
function recorder(name: string): string {
  const file = path.join(root, 'bin', name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s: %s\\n' "${name}" "$*" >> "${marker}"\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}

/** The attack config as git-config text: every key that would run a command, route traffic or pick a target. */
function attackConfig(): string {
  const run = recorder('run');
  const hooks = path.join(root, 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-receive', 'update']) {
    writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 0\n`);
    chmodSync(path.join(hooks, hook), 0o755);
  }
  // `ext::` runs a command as a transport; the recorder (a path without spaces) only records and
  // exits, so the config parses and nothing reads stdin.
  const extTouch = `ext::${recorder('ext')}`;
  return [
    '[core]',
    `  askPass = ${run}`,
    `  sshCommand = ${run}`,
    `  fsmonitor = ${run}`,
    `  alternateRefsCommand = ${run}`,
    `  hooksPath = ${hooks}`,
    '[credential]',
    `  helper = !${run}`,
    '[remote "origin"]',
    `  receivepack = ${run}`,
    `  uploadpack = ${run}`,
    '[uploadpack]',
    `  packObjectsHook = ${run}`,
    `[url "${extTouch}"]`,
    '  insteadOf = https://',
    '[protocol]',
    '  allow = always',
    '[protocol "file"]',
    '  allow = always',
    '[protocol "ext"]',
    '  allow = always',
    '[submodule]',
    '  recurse = true',
    '[http]',
    `  proxy = http://127.0.0.1:${proxy.port}`,
    '',
  ].join('\n');
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'git-harden-'));
  mkdirSync(path.join(root, 'bin'));
  marker = path.join(root, 'MARKER');
  const hits: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? '-'}`);
    res.writeHead(502).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy = { server, hits, port: (server.address() as AddressInfo).port };
  http = await startGitHttp(root);
});
afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  await http.close();
  await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
  rmTemp(root);
});

/** A work repo with one commit and a bare origin served over http, both under `root`. */
function workAndOrigin(): { work: string; url: string } {
  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'a');
  return { work, url: http.url('origin.git') };
}

const nothingRan = () => {
  const recorded = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
  expect(recorded, `a planted command ran: ${recorded}`).toBe('');
  expect(recorded.includes('ext:'), 'the ext:: transport ran').toBe(false);
  expect(proxy.hits, `the proxy was reached:\n${proxy.hits.join('\n')}`).toEqual([]);
};

describe('git commands that reach a remote ignore config that runs a command or routes traffic', () => {
  for (const where of ['worktree config', 'global config'] as const) {
    describe(`planted in the ${where}`, () => {
      // Worktree: append to the repo's own config. Global: write the runner's ~/.gitconfig and run
      // every path with HOME/XDG pointing at it, so the test proves core's env (GIT_CONFIG_GLOBAL=
      // /dev/null) ignores it — not that the file was never written.
      const plant = (work: string) => {
        if (where === 'worktree config') appendFileSync(path.join(work, '.git', 'config'), attackConfig());
        else {
          writeFileSync(path.join(root, '.gitconfig'), attackConfig());
          setCommandExecutor((request) =>
            localCommandExecutor({ ...request, env: { HOME: root, XDG_CONFIG_HOME: root, ...request.env } }),
          );
        }
      };

      it('a push (no account) runs no planted command and reaches no proxy', async () => {
        const { work, url } = workAndOrigin();
        plant(work);
        await pushBranch(work, { url, account: null }, 'main', git(work, 'rev-parse', 'HEAD')).catch(
          () => undefined,
        );
        nothingRan();
      });

      it('a run push (no account) runs no planted command and reaches no proxy', async () => {
        const { work, url } = workAndOrigin();
        git(work, 'remote', 'add', 'origin', url);
        git(work, 'checkout', '-q', '-b', 'emberline/run-1');
        plant(work);
        await pushWorktreeBranch(work, 'emberline/run-1', 'main').catch(() => undefined);
        nothingRan();
      });

      it('reading origin (ls-remote, fetch; no account) runs no planted command and reaches no proxy', async () => {
        const { work, url } = workAndOrigin();
        git(work, 'push', '-q', path.join(root, 'origin.git'), 'main');
        plant(work);
        const oid = await remoteBranchHead(work, { url, account: null }, 'main').catch(() => null);
        if (oid) await fetchBranchObjects(work, { url, account: null }, 'main', oid).catch(() => undefined);
        nothingRan();
      });

      it('an import clone runs no planted command and reaches no proxy', async () => {
        const { url } = workAndOrigin();
        const target = path.join(root, 'cloned');
        // The clone target does not exist yet, so the attack lives in the global config only.
        writeFileSync(path.join(root, '.gitconfig'), attackConfig());
        const args = [
          ...HARDENED_GIT_ARGS,
          ...REMOTE_PROTOCOL_ARGS,
          ...NO_SUBMODULES,
          'clone',
          '--no-recurse-submodules',
          '--',
          url,
          target,
        ];
        // Async: the git-http server runs in this process, so a synchronous spawn would deadlock it.
        await promisify(execFile)('git', args, {
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, ...cloneGitEnv(false) },
        }).catch(() => undefined); // a failed clone is fine; the assertion is that nothing ran
        nothingRan();
      });
    });
  }

  it("a submodule's own receivepack never runs on a run push, even with submodule.recurse", async () => {
    const { url } = workAndOrigin();
    const work = path.join(root, 'work');
    const subOrigin = path.join(root, 'sub.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', subOrigin]);
    const sub = path.join(root, 'sub');
    execFileSync('git', ['init', '-q', '-b', 'main', sub]);
    writeFileSync(path.join(sub, 's.txt'), 's\n');
    git(sub, 'add', 's.txt');
    git(sub, 'commit', '-q', '-m', 's');
    git(sub, 'push', '-q', subOrigin, 'main');
    git(work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'sub');
    git(work, 'commit', '-q', '-m', 'add sub');
    git(path.join(work, 'sub'), 'checkout', '-q', '-b', 'emberline/run-1');
    writeFileSync(path.join(work, 'sub', 'more.txt'), 'm\n');
    git(path.join(work, 'sub'), 'add', 'more.txt');
    git(path.join(work, 'sub'), 'commit', '-q', '-m', 'more');
    git(work, 'add', 'sub');
    git(work, 'commit', '-q', '-m', 'bump');
    git(work, 'remote', 'add', 'origin', url);
    git(work, 'checkout', '-q', '-b', 'emberline/run-1');
    git(work, 'config', 'submodule.recurse', 'true');
    git(work, 'config', 'push.recurseSubmodules', 'on-demand');
    git(work, 'config', 'protocol.file.allow', 'always');
    git(
      path.join(work, '.git', 'modules', 'sub'),
      'config',
      'remote.origin.receivepack',
      `touch ${marker}; git-receive-pack`,
    );
    await pushWorktreeBranch(work, 'emberline/run-1', 'main').catch(() => undefined);
    expect(existsSync(marker)).toBe(false);
  });

  it('a local-path, file:// or ext:: origin is refused before any git runs', async () => {
    const { work } = workAndOrigin();
    const oid = git(work, 'rev-parse', 'HEAD');
    for (const url of [path.join(root, 'origin.git'), 'file:///srv/x.git', 'ext::sh -c id']) {
      const error = await pushBranch(work, { url, account: null }, 'main', oid).catch((e: unknown) => e);
      expect((error as { code?: string }).code, url).toBe('remote_not_supported');
    }
    expect(existsSync(marker)).toBe(false);
  });
});

/** An https server with a self-signed certificate for 127.0.0.1: any request at all means TLS was not verified. */
async function startTls(): Promise<{
  url: (repo: string) => string;
  cert: string;
  key: string;
  hits: string[];
  close: () => Promise<void>;
}> {
  const cert = path.join(root, 'tls-cert.pem');
  const key = path.join(root, 'tls-key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const hits: string[] = [];
  const server = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    req.resume();
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(404).end();
  });
  // A refused handshake is the expected outcome; keep it out of the test output.
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (repo) => `https://127.0.0.1:${port}/${repo}`,
    cert,
    key,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const plantedHeader = () => http.seen.filter((r) => 'x-planted' in r.headers).map((r) => r.url);

describe('TLS, proxy and extra headers from repo config on a command that reaches a remote', () => {
  let tls: Awaited<ReturnType<typeof startTls>>;
  beforeEach(async () => {
    tls = await startTls();
  });
  afterEach(async () => {
    await tls.close();
  });

  /** Push main, Refresh's read and a run's push, all to `url`; failures are fine, only what reached a server counts. */
  async function everyRemotePath(work: string, url: string): Promise<void> {
    const oid = git(work, 'rev-parse', 'HEAD');
    await pushBranch(work, { url, account: null }, 'main', oid).catch(() => undefined);
    const head = await remoteBranchHead(work, { url, account: null }, 'main').catch(() => null);
    await fetchBranchObjects(work, { url, account: null }, 'main', head ?? oid).catch(() => undefined);
    git(work, 'remote', 'add', 'origin', url);
    git(work, 'checkout', '-q', '-b', 'emberline/run-1');
    await pushWorktreeBranch(work, 'emberline/run-1', 'main').catch(() => undefined);
  }

  const tlsUrl = () => tls.url('origin.git');
  // `-c http.sslVerify=true` wins over the plain key; every other one is refused on remote commands.
  // A URL-scoped key names origin's exact address (with its port), so it would apply.
  const tlsKeys: [string, () => string, () => string, 'pinned' | 'refused'][] = [
    ['http.sslVerify', () => 'http.sslVerify', () => 'false', 'pinned'],
    ['http.<url>.sslVerify', () => `http.${tlsUrl()}.sslVerify`, () => 'false', 'refused'],
    ['http.sslCAInfo', () => 'http.sslCAInfo', () => tls.cert, 'refused'],
    ['http.<url>.sslCAInfo', () => `http.${tlsUrl()}.sslCAInfo`, () => tls.cert, 'refused'],
    ['http.sslCAPath', () => 'http.sslCAPath', () => root, 'refused'],
    ['http.sslCert', () => 'http.sslCert', () => tls.cert, 'refused'],
    ['http.sslKey', () => 'http.sslKey', () => tls.key, 'refused'],
    ['http.sslBackend', () => 'http.sslBackend', () => 'openssl', 'refused'],
    ['http.sslVersion', () => 'http.sslVersion', () => 'tlsv1.0', 'refused'],
    ['http.pinnedPubkey', () => 'http.pinnedPubkey', () => tls.cert, 'refused'],
  ];
  for (const [name, key, value, how] of tlsKeys) {
    it(`${name} in the repository's config never weakens TLS (${how})`, async () => {
      const { work } = workAndOrigin();
      git(work, 'config', key(), value());
      if (how === 'refused') {
        await expect(assertSafeGitConfig(work, { remote: true })).rejects.toBeInstanceOf(
          UnsafeGitConfigError,
        );
        // Only remote commands refuse it: the repository's local git (merges, status) still works.
        await expect(assertSafeGitConfig(work)).resolves.toBeUndefined();
      }
      await everyRemotePath(work, tlsUrl());
      expect(tls.hits, 'a request got through an unverified TLS connection').toEqual([]);
    });
  }

  it('a plain http.extraHeader is reset: the remote never sees it', async () => {
    const { work, url } = workAndOrigin();
    git(work, 'config', 'http.extraHeader', 'X-Planted: from-config');
    await everyRemotePath(work, url);
    expect(http.seen.length).toBeGreaterThan(0);
    expect(plantedHeader()).toEqual([]);
  });

  it('a URL-scoped http.<url>.extraHeader is refused', async () => {
    const { work, url } = workAndOrigin();
    git(work, 'config', `http.${url}.extraHeader`, 'X-Planted: from-config');
    await expect(assertSafeGitConfig(work, { remote: true })).rejects.toBeInstanceOf(UnsafeGitConfigError);
    await everyRemotePath(work, url);
    expect(plantedHeader()).toEqual([]);
  });

  it('a plain http.proxy (with no other planted key) is overridden: the proxy is never reached', async () => {
    const { work, url } = workAndOrigin();
    git(work, 'config', 'http.proxy', `http://127.0.0.1:${proxy.port}`);
    await everyRemotePath(work, url);
    expect(http.seen.length).toBeGreaterThan(0);
    expect(proxy.hits).toEqual([]);
  });
});

describe("the runner's environment and PATH never reach core's commands", () => {
  const PLANTED_ENV_KEYS = [
    'PATH',
    'HOME',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_1',
    'GIT_EXEC_PATH',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_PROXY_COMMAND',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'GIT_SSL_NO_VERIFY',
    'GIT_SSL_CAINFO',
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'all_proxy',
    'SSL_CERT_FILE',
    'CURL_CA_BUNDLE',
    'LD_PRELOAD',
  ];
  let saved: Record<string, string | undefined>;
  let tls: Awaited<ReturnType<typeof startTls>>;

  /**
   * What an agent could plant: binaries first on PATH and in a git exec dir, and every variable that
   * would steer git, ssh, curl or the loader. Set on this process: a ptyd started here forwards its
   * base environment (PATH, HOME) from it, and the local executor forwards all of it.
   */
  function plantEverything(): void {
    for (const name of [
      'git',
      'ssh',
      'git-remote-http',
      'git-remote-https',
      'cp',
      'rm',
      'sh',
      'cat',
      'head',
      'curl',
    ])
      recorder(name);
    const execDir = path.join(root, 'exec');
    mkdirSync(execDir);
    for (const name of ['git-remote-http', 'git-remote-https']) {
      writeFileSync(path.join(execDir, name), `#!/bin/sh\necho "exec-path ${name}" >> "${marker}"\nexit 1\n`);
      chmodSync(path.join(execDir, name), 0o755);
    }
    writeFileSync(path.join(root, '.gitconfig'), attackConfig());
    const run = path.join(root, 'bin', 'run');
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const planted: Record<string, string> = {
      PATH: `${path.join(root, 'bin')}:${saved.PATH ?? '/usr/bin:/bin'}`,
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_CONFIG_PARAMETERS: `'http.proxy=${proxyUrl}' 'http.extraheader=X-Planted: env'`,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: proxyUrl,
      GIT_CONFIG_KEY_1: 'http.extraHeader',
      GIT_CONFIG_VALUE_1: 'X-Planted: env',
      GIT_EXEC_PATH: execDir,
      GIT_SSH: run,
      GIT_SSH_COMMAND: run,
      GIT_PROXY_COMMAND: run,
      GIT_ASKPASS: run,
      SSH_ASKPASS: run,
      GIT_SSL_NO_VERIFY: '1',
      GIT_SSL_CAINFO: tls.cert,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      all_proxy: proxyUrl,
      SSL_CERT_FILE: tls.cert,
      CURL_CA_BUNDLE: tls.cert,
      LD_PRELOAD: path.join(root, 'planted-preload.so'),
    };
    Object.assign(process.env, planted);
  }

  beforeEach(async () => {
    saved = Object.fromEntries(PLANTED_ENV_KEYS.map((key) => [key, process.env[key]]));
    tls = await startTls();
  });
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await tls.close();
  });

  const nothingReached = () => {
    nothingRan();
    expect(plantedHeader(), 'a planted header reached the remote').toEqual([]);
    expect(tls.hits, 'TLS was not verified').toEqual([]);
  };

  for (const runner of ['ptyd', 'a runner that forwards its whole environment'] as const) {
    describe(`run by ${runner}`, () => {
      let ptyd: { server: PtydServer; bridge: PtydBridge } | null = null;
      beforeEach(async () => {
        if (runner === 'ptyd') {
          const socketPath = path.join(root, 'ptyd.sock');
          const server = new PtydServer({ socketPath });
          await server.listen();
          const bridge = new PtydBridge(socketPath);
          bridge.start();
          await bridge.waitUntilConnected();
          ptyd = { server, bridge };
          setCommandExecutor(ptydCommandExecutor(bridge));
        } else {
          // Forwards all of process.env, unless a command says inheritEnv: false.
          setCommandExecutor(localCommandExecutor);
        }
      });
      afterEach(async () => {
        setCommandExecutor(localCommandExecutor);
        if (ptyd) {
          ptyd.bridge.stop();
          await ptyd.server.close();
          ptyd = null;
        }
      });

      it('Push main, Refresh and a run push still work, and nothing planted runs or is used', async () => {
        const { work, url } = workAndOrigin();
        const oid = git(work, 'rev-parse', 'HEAD');
        git(work, 'remote', 'add', 'origin', url);
        git(work, 'checkout', '-q', '-b', 'emberline/run-1');
        plantEverything();
        // Real work through the clean environment: no dubious ownership, no missing helper.
        expect(await pushBranch(work, { url, account: null }, 'main', oid)).toBe('pushed');
        expect(await remoteBranchHead(work, { url, account: null }, 'main')).toBe(oid);
        await fetchBranchObjects(work, { url, account: null }, 'main', oid);
        await pushWorktreeBranch(work, 'emberline/run-1', 'main');
        const listed = await execGitFile(['ls-remote', '--heads', '--', url], { cwd: work, remote: true });
        expect(listed.stdout).toContain('refs/heads/emberline/run-1');
        expect(listed.stderr, 'LD_PRELOAD reached git').not.toMatch(/ld\.so|preload/i);
        nothingReached();
      });

      it('ssh, https and a 401 run no planted ssh, askpass or helper, and TLS stays verified', async () => {
        const { work } = workAndOrigin();
        plantEverything();
        await listRemoteBranches(work, { url: 'ssh://git@127.0.0.1:1/o/r.git', account: null }).catch(
          () => [],
        );
        await listRemoteBranches(work, { url: 'git@127.0.0.1:o/r.git', account: null }).catch(() => []);
        await remoteBranchHead(work, { url: tls.url('origin.git'), account: null }, 'main').catch(() => null);
        await remoteBranchHead(work, { url: http.url('private/origin.git'), account: null }, 'main').catch(
          () => null,
        );
        nothingReached();
      });

      it("a run's merge into main uses the image's sh, cp, rm and cat", async () => {
        const main = path.join(root, 'main');
        execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', main]);
        writeFileSync(path.join(main, 'a.txt'), 'a\n');
        git(main, 'add', 'a.txt');
        git(main, 'commit', '-q', '-m', 'a');
        const wt = path.join(root, 'wt');
        git(main, 'worktree', 'add', '-q', '-b', 'emberline/run-1', wt, 'HEAD');
        writeFileSync(path.join(wt, 'b.txt'), 'b\n');
        git(wt, 'add', 'b.txt'); // staged by hand: the merge copies the index (cp) to build its output
        plantEverything();
        const merged = await syncWorktreeToMainWorkspace({
          worktreePath: wt,
          mainWorkspacePath: main,
          ticketKey: 'T-1',
          runId: 'run-1',
        });
        expect(merged.ok, merged.summary).toBe(true);
        expect(readFileSync(path.join(main, 'b.txt'), 'utf8')).toBe('b\n');
        nothingReached();
      });

      it("a preview probe uses the image's curl", async () => {
        plantEverything();
        await probePreviewFraming(http.url('x'));
        nothingReached();
      });

      if (runner === 'ptyd')
        it('the import clone in a ptyd terminal is the image git with only the hardened environment', async () => {
          const { url } = workAndOrigin();
          git(path.join(root, 'work'), 'push', '-q', path.join(root, 'origin.git'), 'main');
          const target = path.join(root, 'cloned');
          plantEverything();
          const client = ptyd!.bridge.get();
          // As routes/projects.ts spawns it.
          const session = await client.spawn({
            file: RUNNER_BIN.git,
            args: [
              ...HARDENED_GIT_ARGS,
              ...REMOTE_PROTOCOL_ARGS,
              ...NO_SUBMODULES,
              'clone',
              '--',
              url,
              target,
            ],
            cwd: root,
            env: cloneGitEnv(false),
            inheritEnv: false,
          });
          await expect
            .poll(async () => (await client.list()).sessions.find((x) => x.id === session.id)?.status, {
              timeout: 15_000,
            })
            .toBe('exited');
          expect((await client.list()).sessions.find((x) => x.id === session.id)?.exitCode).toBe(0);
          expect(existsSync(path.join(target, 'a.txt'))).toBe(true);
          nothingReached();
        });
    });
  }

  it('core widens no safe.directory: neither its arguments nor its environment name one', () => {
    const all = [
      ...HARDENED_GIT_ARGS,
      ...REMOTE_PROTOCOL_ARGS,
      ...NO_SUBMODULES,
      ...Object.values(hardenedGitEnv()),
    ];
    expect(all.join('\n')).not.toMatch(/safe\.directory/i);
  });
});

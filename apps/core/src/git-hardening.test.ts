/**
 * Proof, with real git in Docker, that no git command core runs against a remote lets a config an
 * agent can write run a command, route the traffic, or pick a different target. Rows are the
 * hardened paths (a push, a run push, reading origin, and an import clone); columns are the attack
 * keys, planted in the worktree's own config and in a global config the runner shares, plus a
 * submodule's config and a local-path origin. Each case asserts that no planted command ran (a
 * marker file is never created) and that the credential never reached a proxy.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { cloneGitEnv, HARDENED_GIT_ARGS, NO_SUBMODULES, REMOTE_PROTOCOL_ARGS } from './git-exec.js';
import { fetchBranchObjects, pushBranch, remoteBranchHead } from './repository/git.js';
import { pushWorktreeBranch } from './runs/git.js';
import { startGitHttp } from './test-git-http.js';
import { rmTemp } from './test-rm.js';

let root: string;
let marker: string;
let http: { url: (repo: string) => string; close: () => Promise<void> };
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
  const recorded = existsSync(marker) ? execFileSync('cat', [marker], { encoding: 'utf8' }) : '';
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

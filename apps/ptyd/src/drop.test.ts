import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cwdProblem, droppableFile, dropArgs, lookupUid, wrapForUser } from './drop.js';
import { probeDrop } from './server.js';

const isRoot = process.getuid?.() === 0;

/**
 * ptyd as the runner's entrypoint starts it: user ptyd, with exactly the runner's capabilities. The
 * root tests run the drop from there, never from full root.
 */
const RUNNER_CAPS = '-all,+setuid,+setgid,+setpcap,+kill,+chown';
const AS_RUNNER_PTYD = [
  '/usr/bin/setpriv',
  '--reuid=ptyd',
  '--regid=ptyd',
  '--init-groups',
  `--inh-caps=${RUNNER_CAPS}`,
  `--ambient-caps=${RUNNER_CAPS}`,
  `--bounding-set=${RUNNER_CAPS}`,
  '--',
];

/** A user's gids as /etc/group has them: its primary group and every group naming it as a member. */
function groupsOf(user: string): number[] {
  const primary = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .map((line) => line.split(':'))
    .find(([name]) => name === user)?.[3];
  const gids = new Set<number>(primary === undefined ? [] : [Number(primary)]);
  for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
    const [, , gid, members = ''] = line.split(':');
    if (gid !== undefined && members.split(',').includes(user)) gids.add(Number(gid));
  }
  return [...gids].sort((a, b) => a - b);
}

/** What a process that ptyd (as the runner runs it) starts as `user` reports about itself. */
function identityAs(user: string) {
  const { file, args, cwd } = wrapForUser(
    '/bin/sh',
    ['-c', 'id -u; id -G; grep -E "^Cap(Eff|Prm|Amb|Bnd|Inh):" /proc/self/status'],
    user,
    '/',
  );
  const [setpriv = '', ...prefix] = AS_RUNNER_PTYD;
  const run = spawnSync(setpriv, [...prefix, file, ...args], { cwd, encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  const [uid = '', groups = '', ...caps] = run.stdout.trim().split('\n');
  return {
    uid: Number(uid),
    groups: groups
      .split(' ')
      .map(Number)
      .sort((a, b) => a - b),
    caps: Object.fromEntries(caps.map((line) => line.split(/:\s+/) as [string, string])),
  };
}

const NO_CAPS = {
  CapInh: '0000000000000000',
  CapPrm: '0000000000000000',
  CapEff: '0000000000000000',
  CapBnd: '0000000000000000',
  CapAmb: '0000000000000000',
};

const DROP = [
  '--reuid=node',
  '--regid=node',
  '--init-groups',
  '--inh-caps=-all',
  '--ambient-caps=-all',
  '--bounding-set=-all',
  '--',
];

describe('wrapForUser', () => {
  it('starts the command through setpriv as the user, with no capabilities, entering cwd after the drop', () => {
    expect(dropArgs('node')).toEqual(['/usr/bin/setpriv', ...DROP]);
    expect(wrapForUser('/bin/sh', ['-c', 'id'], 'node', '/workspaces/demo')).toEqual({
      file: '/usr/bin/setpriv',
      args: [...DROP, '/usr/bin/env', '--chdir=/workspaces/demo', '--', '/bin/sh', '-c', 'id'],
      cwd: '/',
      env: {},
    });
  });

  it("keeps the loader's variables from setpriv (it holds ptyd's capabilities) and hands them to the command after the drop", () => {
    const env = {
      PATH: '/usr/bin:/bin',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/opt/lib',
      GCONV_PATH: '/tmp/gconv',
      GLIBC_TUNABLES: 'glibc.malloc.check=3',
      LOCPATH: '/tmp/locale',
      NLSPATH: '/tmp/nls',
      MALLOC_TRACE: '/tmp/trace',
      HOSTALIASES: '/tmp/hosts',
      RESOLV_HOST_CONF: '/tmp/host.conf',
    };
    const command = wrapForUser('/bin/sh', ['-c', 'id'], 'node', '/w', env);
    expect(command.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(command.args).toEqual([
      ...DROP,
      '/usr/bin/env',
      '--chdir=/w',
      '--',
      'LD_PRELOAD=/tmp/evil.so',
      'LD_LIBRARY_PATH=/opt/lib',
      'GCONV_PATH=/tmp/gconv',
      'GLIBC_TUNABLES=glibc.malloc.check=3',
      'LOCPATH=/tmp/locale',
      'NLSPATH=/tmp/nls',
      'MALLOC_TRACE=/tmp/trace',
      'HOSTALIASES=/tmp/hosts',
      'RESOLV_HOST_CONF=/tmp/host.conf',
      '/bin/sh',
      '-c',
      'id',
    ]);
    // Without a drop nothing runs with ptyd's capabilities in front of the command: env as it is.
    expect(wrapForUser('/bin/sh', [], undefined, '/w', env).env).toEqual(env);
  });

  it('leaves the command as it is without a user', () => {
    expect(wrapForUser('/bin/sh', ['-c', 'id'], undefined, '/tmp')).toEqual({
      file: '/bin/sh',
      args: ['-c', 'id'],
      cwd: '/tmp',
      env: {},
    });
  });

  it('only starts files through env that env cannot take for a variable', () => {
    expect(droppableFile('/usr/bin/git')).toBe(true);
    expect(droppableFile('A=1')).toBe(false);
  });
});

describe('cwdProblem', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ptyd-cwd-'));
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses only a directory that is missing or not one', () => {
    expect(cwdProblem(dir)).toBeNull();
    expect(cwdProblem(path.join(dir, 'missing'))).toBe(`cwd does not exist: ${path.join(dir, 'missing')}`);
    writeFileSync(path.join(dir, 'file'), '');
    expect(cwdProblem(path.join(dir, 'file'))).toMatch(/^cwd does not exist/);
    expect(cwdProblem(path.join(dir, 'file', 'below'))).toMatch(/^cwd does not exist/); // ENOTDIR
    // One ptyd may not enter (the agents' own) is left to the user the command runs as.
    mkdirSync(path.join(dir, 'closed', 'inside'), { recursive: true });
    chmodSync(path.join(dir, 'closed'), 0o000);
    if (!isRoot) expect(cwdProblem(path.join(dir, 'closed', 'inside'))).toBeNull(); // EACCES
    chmodSync(path.join(dir, 'closed'), 0o700);
  });
});

describe('the drop', () => {
  // A process that is not root cannot change its user: the drop is only seen working from root, here
  // turned into the runner's ptyd first (CI's check stage runs the tests as root).
  it.skipIf(!isRoot)(
    "from the runner's ptyd to node: node's uid and groups (dialout for USB), no capabilities at all",
    () => {
      const node = identityAs('node');
      expect(node.uid).toBe(1000);
      expect(node.groups).toEqual(groupsOf('node'));
      expect(node.groups).toContain(20); // dialout: flashing boards over USB (compose.usb.yaml)
      expect(node.caps).toEqual(NO_CAPS);
    },
  );

  it.skipIf(!isRoot)("from the runner's ptyd to browser: uid 1002, no group beyond its own", () => {
    expect(lookupUid('browser')).toBe(1002);
    const browser = identityAs('browser');
    expect(browser.uid).toBe(1002);
    expect(browser.groups).toEqual([1002]);
    expect(browser.caps).toEqual(NO_CAPS);
  });

  it.skipIf(!isRoot)("the loader's variables reach the command, not setpriv or env in front of it", () => {
    // The loader prints the auxiliary vector of every program it starts with LD_SHOW_AUXV set: once
    // here (the command), not three times (setpriv, env, the command).
    const { file, args, cwd, env } = wrapForUser(
      '/bin/sh',
      ['-c', 'echo "show:$LD_SHOW_AUXV"'],
      'node',
      '/',
      { PATH: '/usr/bin:/bin', LD_SHOW_AUXV: '1' },
    );
    const [setpriv = '', ...prefix] = AS_RUNNER_PTYD;
    const run = spawnSync(setpriv, [...prefix, file, ...args], { cwd, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('show:1');
    expect(run.stdout.match(/^AT_ENTRY:/gm)).toHaveLength(1);
  });

  // Runs wherever the tests do not run as root (the dev container): there the drop cannot work,
  // and the probe must say so instead of trusting it. (The probe passing in the runner's ptyd is
  // shown in server.test.ts, where that ptyd says it is secured.)
  it.skipIf(isRoot)('the probe says a process that is not root cannot drop', () => {
    expect(probeDrop('browser')).toBe(false);
    expect(probeDrop('node')).toBe(false);
  });
});

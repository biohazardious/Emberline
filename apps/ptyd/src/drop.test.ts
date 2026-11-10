import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dropArgs, wrapForUser } from './drop.js';
import { lookupUid, probeDrop } from './server.js';

const isRoot = process.getuid?.() === 0;

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

/** What a process started as `user` reports about itself. */
function identityAs(user: string) {
  const { file, args } = wrapForUser(
    '/bin/sh',
    ['-c', 'id -u; id -G; grep -E "^Cap(Eff|Prm|Amb|Bnd|Inh):" /proc/self/status'],
    user,
  );
  const run = spawnSync(file, args, { encoding: 'utf8' });
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

describe('wrapForUser', () => {
  it('starts the command through setpriv as the user, with no capabilities', () => {
    expect(dropArgs('node')).toEqual([
      '/usr/bin/setpriv',
      '--reuid=node',
      '--regid=node',
      '--init-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--bounding-set=-all',
      '--',
    ]);
    expect(wrapForUser('/bin/sh', ['-c', 'id'], 'node')).toEqual({
      file: '/usr/bin/setpriv',
      args: [
        '--reuid=node',
        '--regid=node',
        '--init-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--bounding-set=-all',
        '--',
        '/bin/sh',
        '-c',
        'id',
      ],
    });
  });

  it('leaves the command as it is without a user', () => {
    expect(wrapForUser('/bin/sh', ['-c', 'id'], undefined)).toEqual({ file: '/bin/sh', args: ['-c', 'id'] });
  });
});

describe('the drop', () => {
  // A process that is not root cannot change its user: the drop is only seen working as root
  // (CI's check stage runs the tests as root).
  it.skipIf(!isRoot)("drop to node: node's uid and groups (dialout for USB), no capabilities at all", () => {
    const node = identityAs('node');
    expect(node.uid).toBe(1000);
    expect(node.groups).toEqual(groupsOf('node'));
    expect(node.groups).toContain(20); // dialout: flashing boards over USB (compose.usb.yaml)
    expect(node.caps).toEqual(NO_CAPS);
  });

  it.skipIf(!isRoot)('drop to browser: uid 1002, no group beyond its own', () => {
    const browser = identityAs('browser');
    expect(browser.uid).toBe(1002);
    expect(browser.groups).toEqual([1002]);
    expect(browser.caps).toEqual(NO_CAPS);
  });

  it.skipIf(!isRoot)('the probe sees the drop work as root', () => {
    expect(lookupUid('node')).toBe(1000);
    expect(probeDrop('node')).toBe(true);
    expect(probeDrop('browser')).toBe(true);
    expect(probeDrop('nobody-here')).toBe(false);
  });

  // Runs wherever the tests do not run as root (the dev container): there the drop cannot work,
  // and the probe must say so instead of trusting it.
  it.skipIf(isRoot)('the probe says a process that is not root cannot drop', () => {
    expect(probeDrop('browser')).toBe(false);
    expect(probeDrop('node')).toBe(false);
  });
});

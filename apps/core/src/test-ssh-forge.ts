/**
 * Test-only ssh forge: a real sshd on 127.0.0.1 that logs in only the current user (root too, as CI
 * runs it) with the keys `authorize` lists, and through a forced command runs only
 * git-upload-pack/git-receive-pack on bare repositories under its own folder. Every session is
 * logged, so a test can prove that nothing reached the server.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { rmTemp } from './test-rm.js';

/** OpenSSH's server (Debian/Ubuntu and Arch paths); tests that need it skip without one. */
export const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));

export interface SshForge {
  port: number;
  /** The server's ed25519 host key as `ssh-keygen -l` reads it. */
  hostKey: { keyType: string; key: string; fingerprint: string };
  /** `ssh://<user>@127.0.0.1:<port>/owner/<name>.git`. */
  address(name: string): string;
  /** The bare repository `owner/<name>.git` (created empty, with `main` as HEAD, on first use). */
  bare(name: string): string;
  /** Replaces the keys that may log in. */
  authorize(...publicKeys: string[]): void;
  /** One line per session that reached the forced command: `<service> <name>`. */
  sessions(): string[];
  close(): void;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

export async function startSshForge(): Promise<SshForge> {
  if (!SSHD) throw new Error('no sshd');
  const dir = mkdtempSync(path.join(tmpdir(), 'ssh-forge-'));
  const repos = path.join(dir, 'repos');
  execFileSync('mkdir', ['-p', repos]);
  const hostFile = path.join(dir, 'host_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostFile]);
  const [keyType, key] = readFileSync(`${hostFile}.pub`, 'utf8').split(' ') as [string, string];
  const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', `${hostFile}.pub`], { encoding: 'utf8' }).split(
    ' ',
  )[1]!;
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
      'case "$name" in *[!a-z0-9./-]*|*..*|"") echo "no such repository" >&2; exit 1 ;; esac',
      '[ -d "$root/$name" ] || { echo "no such repository" >&2; exit 1; }',
      'echo "$svc $name" >> "$root/../log"',
      'exec "$svc" "$root/$name"',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  const authorizedKeys = path.join(dir, 'authorized_keys');
  writeFileSync(authorizedKeys, '');
  writeFileSync(path.join(dir, 'log'), '');
  const port = await freePort();
  const config = path.join(dir, 'sshd_config');
  writeFileSync(
    config,
    [
      `HostKey ${hostFile}`,
      'PidFile none',
      'UsePAM no',
      'StrictModes no',
      'ListenAddress 127.0.0.1',
      `Port ${port}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AcceptEnv GIT_PROTOCOL',
      `ForceCommand ${wrapper} ${repos}`,
    ].join('\n'),
  );
  const sshd: ChildProcess = spawn(SSHD, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    sshd.stderr!.on('data', (d: Buffer) => d.toString().includes('Server listening') && resolve());
    sshd.on('exit', (code) => reject(new Error(`sshd exited with ${code}`)));
  });
  const user = userInfo().username;
  return {
    port,
    hostKey: { keyType, key, fingerprint },
    address: (name) => `ssh://${user}@127.0.0.1:${port}/owner/${name}.git`,
    bare(name) {
      const repo = path.join(repos, 'owner', `${name}.git`);
      if (!existsSync(repo)) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', repo]);
      return repo;
    },
    authorize: (...publicKeys) => writeFileSync(authorizedKeys, publicKeys.map((k) => `${k}\n`).join('')),
    sessions: () => readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter(Boolean),
    close() {
      sshd.kill();
      rmTemp(dir);
    },
  };
}

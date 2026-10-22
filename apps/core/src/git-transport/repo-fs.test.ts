import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTransportError } from './http.js';
import { RepoFs, type RepoFsOptions } from './repo-fs.js';

const SHA = 'a'.repeat(40);
const CONFIG = '[core]\n\tbare = false\n';
let base: string;
let outside: string;
let repo: string;
let gitdir: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'repofs-ws-'));
  outside = mkdtempSync(path.join(tmpdir(), 'repofs-data-')); // stands for core's /data
  writeFileSync(path.join(outside, 'core.db'), 'sentinel');
  repo = path.join(base, 'p');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  gitdir = path.join(repo, '.git');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const open = (extra: Partial<RepoFsOptions> = {}) =>
  RepoFs.open({
    workspacesDir: base,
    repoRoot: repo,
    config: CONFIG,
    refs: ['refs/remotes/origin/main'],
    ...extra,
  });

describe('RepoFs', () => {
  it('serves its own config and never reads or writes the file', async () => {
    writeFileSync(path.join(gitdir, 'config'), '[http]\n\tproxy = http://evil.example\n');
    const fs = await open();
    expect(await fs.client.promises.readFile(`${fs.gitdir}/config`, 'utf8')).toBe(CONFIG);
    await expect(fs.client.promises.writeFile(`${fs.gitdir}/config`, 'x')).rejects.toThrow();
    expect(readFileSync(path.join(gitdir, 'config'), 'utf8')).toContain('evil.example');
  });

  it('writes only objects, packs and the refs the operation updates', async () => {
    const fs = await open();
    const p = fs.client.promises;
    for (const rel of [
      'hooks/pre-push',
      'refs/heads/main',
      'HEAD',
      'index',
      'info/attributes',
      'refs/remotes/origin/other',
      'objects/info/alternates',
      '../outside-git',
    ]) {
      await expect(p.writeFile(`${fs.gitdir}/${rel}`, 'x'), rel).rejects.toThrow();
    }
    await expect(p.mkdir(`${fs.gitdir}/hooks2`)).rejects.toThrow();
    await expect(p.unlink(`${fs.gitdir}/HEAD`)).rejects.toThrow();
    await expect(p.symlink!('/data', `${fs.gitdir}/refs/remotes/origin/main`)).rejects.toThrow();
    expect(existsSync(path.join(gitdir, 'hooks', 'pre-push'))).toBe(false);
    expect(existsSync(path.join(repo, 'outside-git'))).toBe(false);
    expect(() => fs.assertClean()).toThrow(GitTransportError);

    const ok = await open();
    await ok.client.promises.mkdir(`${ok.gitdir}/refs/remotes`);
    await ok.client.promises.mkdir(`${ok.gitdir}/refs/remotes/origin`);
    await ok.client.promises.writeFile(`${ok.gitdir}/refs/remotes/origin/main`, `${SHA}\n`, 'utf8');
    expect(readFileSync(path.join(gitdir, 'refs', 'remotes', 'origin', 'main'), 'utf8')).toBe(`${SHA}\n`);
    expect(() => ok.assertClean()).not.toThrow();
  });

  it('never follows a link inside .git, also one that appears after it was opened', async () => {
    const fs = await open();
    mkdirSync(path.join(outside, 'heads'));
    writeFileSync(path.join(outside, 'heads', 'main'), `${'b'.repeat(40)}\n`);
    rmSync(path.join(gitdir, 'refs', 'heads'), { recursive: true, force: true });
    symlinkSync(path.join(outside, 'heads'), path.join(gitdir, 'refs', 'heads'));
    await expect(fs.client.promises.readFile(`${fs.gitdir}/refs/heads/main`, 'utf8')).rejects.toThrow();
    await expect(fs.client.promises.stat(`${fs.gitdir}/refs/heads/main`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(() => fs.assertClean()).toThrow(/symbolic link/);
  });

  it('a project folder or a .git reached through a link is refused', async () => {
    const movedGit = path.join(outside, 'git');
    renameSync(gitdir, movedGit);
    symlinkSync(movedGit, gitdir);
    await expect(open()).rejects.toMatchObject({ code: 'unsafe_repo' });
    rmSync(gitdir);
    renameSync(movedGit, gitdir);
    const movedRepo = path.join(outside, 'p');
    renameSync(repo, movedRepo);
    symlinkSync(movedRepo, repo);
    await expect(open()).rejects.toMatchObject({ code: 'unsafe_repo' });
  });

  it('caps what it reads and the objects in a pack it writes', async () => {
    const small = await open({ maxReadBytes: 4 });
    await expect(small.client.promises.readFile(`${small.gitdir}/HEAD`)).rejects.toThrow();
    expect(() => small.assertClean()).toThrow(/larger than/);
    const fs = await open({ maxPackObjects: 1 });
    const pack = Buffer.alloc(32);
    pack.write('PACK', 0, 'latin1');
    pack.writeUInt32BE(2, 4);
    pack.writeUInt32BE(2, 8);
    await expect(
      fs.client.promises.writeFile(`${fs.gitdir}/objects/pack/pack-${SHA}.pack`, pack),
    ).rejects.toThrow();
    expect(existsSync(path.join(gitdir, 'objects', 'pack', `pack-${SHA}.pack`))).toBe(false);
    expect(() => fs.assertClean()).toThrow(/more than Emberline's limit of 1/);
  });
});

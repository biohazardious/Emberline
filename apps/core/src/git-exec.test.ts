import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit, UnsafeGitConfigError } from './git-exec.js';
import { rmTemp } from './test-rm.js';

let repo: string;
let marker: string;

const gitSetup = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });

function writeScript(name: string): string {
  const file = path.join(repo, '..', name);
  writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'git-exec-'));
  repo = path.join(base, 'repo');
  marker = path.join(base, 'pwned');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  gitSetup('config', 'user.name', 'Test');
  gitSetup('config', 'user.email', 'test@example.com');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
});

afterEach(() => {
  rmTemp(path.dirname(repo));
});

describe('hardened git execution', () => {
  it('does not run core.fsmonitor or repository hooks', async () => {
    gitSetup('config', 'core.fsmonitor', writeScript('fsmonitor.sh'));
    writeScript('hook.sh');
    writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);

    await runGit(repo, ['status', '--porcelain']);
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'init']);

    expect(existsSync(marker)).toBe(false);
    expect((await runGit(repo, ['log', '--oneline'])).trim()).toMatch(/init$/);
  });

  it.each([
    ['filter.evil.clean', 'filter'],
    ['diff.evil.textconv', 'diff driver'],
    ['include.path', 'include'],
    ['remote.origin.uploadpack', 'upload-pack'],
  ])('refuses repositories whose config sets %s (%s)', async (key) => {
    gitSetup('config', key, writeScript('evil.sh'));
    await expect(runGit(repo, ['status'])).rejects.toBeInstanceOf(UnsafeGitConfigError);
    expect(existsSync(marker)).toBe(false);
  });
});
